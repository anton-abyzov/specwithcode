/**
 * The size walk behind the home folder guard. It runs in a worker thread (see
 * `measure.ts`), which receives this function as source text, so it must stay
 * self-contained: no imports, no references to anything outside its body.
 * `fs` and `path` arrive as arguments, which also lets tests pass a fake `fs`.
 *
 * Rules: lstat only, so a symlink inside the tree counts by its own size and
 * is never followed. The root and each part's own path are resolved first (a
 * home folder or worktrees folder moved to another volume and linked back is
 * measured where it lives), unless that would reach a folder holding the root.
 * Inside one walk, an entry on another device than the walk's starting folder
 * is skipped, so a volume mounted inside the tree is never walked; a file with
 * more than one link counts once
 * (by device and inode), so hard-linked installs do not count twice; the walk
 * stops at `maxEntries`, at `deadlineMs` or when `shouldStop` says so, and
 * then reports itself incomplete.
 *
 * @module homeUsage/walkTree
 */

/** A part of the home folder measured on its own. */
export interface WalkPartInput {
  readonly key: string;
  /** Absolute paths; a missing path measures zero. */
  readonly paths: ReadonlyArray<string>;
  /** Also report each direct child's size and newest change (scratch). */
  readonly children?: boolean;
  /** With `children`: only these children (a recheck before removal). */
  readonly onlyChildren?: ReadonlyArray<string>;
  /** Count checkouts (folders holding `.git`) up to two levels down. */
  readonly countCheckouts?: boolean;
}

export interface WalkInput {
  /** The home folder: parts first, then the rest of it as `other`. */
  readonly root: string;
  readonly parts: ReadonlyArray<WalkPartInput>;
  readonly maxEntries: number;
  readonly deadlineMs: number;
  /** False skips the rest of `root` (no `other` part). Default true. */
  readonly measureRest?: boolean;
}

/** One direct child of a part that asked for children. */
export interface WalkChild {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly bytes: number;
  /**
   * Newest change (the newer of mtime and ctime) of the child and everything
   * in it, or null when any read failed or the walk stopped inside it.
   * Contents of `node_modules` and `.git/objects` count for size but not for
   * age: installs and fetches date them, not anyone's work.
   */
  readonly newestMs: number | null;
}

export interface WalkPartResult {
  readonly key: string;
  readonly bytes: number;
  readonly checkouts: number;
  readonly children: ReadonlyArray<WalkChild>;
}

export interface WalkResult {
  readonly totalBytes: number;
  readonly parts: ReadonlyArray<WalkPartResult>;
  readonly entries: number;
  /** Entries left out because they sit on another device. */
  readonly otherDevice: number;
  /** Entries that could not be read; their size is unknown. */
  readonly unreadable: number;
  readonly complete: boolean;
  readonly stopped: "entries" | "deadline" | "cancelled" | null;
}

/** The subset of `node:fs` the walk uses. */
export interface WalkFs {
  lstatSync(
    path: string,
    options: { bigint: true },
  ): {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly nlink: bigint;
    readonly size: bigint;
    readonly blocks: bigint;
    readonly mtimeMs: bigint;
    readonly ctimeMs: bigint;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
  readdirSync(path: string): Array<string>;
  /** Resolves the root and part paths; without it they are walked as given. */
  realpathSync?(path: string): string;
}

export interface WalkPath {
  join(...parts: Array<string>): string;
  basename(path: string): string;
  dirname(path: string): string;
  readonly sep: string;
}

export function walkTreeSync(
  input: WalkInput,
  fs: WalkFs,
  path: WalkPath,
  shouldStop: () => boolean,
  now: () => number,
  /** Called every 1024 entries: the worker sleeps briefly so a walk never saturates the disk. */
  pause: () => void = () => {},
): WalkResult {
  const startedAt = now();
  const seenLinked = new Set<string>();
  let entries = 0;
  let otherDevice = 0;
  let unreadable = 0;
  let stopped: WalkResult["stopped"] = null;
  let pausedAt = 0;
  const realpath = (target: string): string => {
    if (fs.realpathSync === undefined) return target;
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  };
  const root = realpath(input.root);
  /** Whether `inner` is `outer` or inside it. */
  const within = (outer: string, inner: string) =>
    inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  /** A part's path, resolved unless that reaches the root or a folder above it. */
  const resolvePart = (target: string): string => {
    const resolved = realpath(target);
    return within(resolved, root) ? target : resolved;
  };
  // The rest of the root skips every spelling of a part: as given, where its
  // entry sits under the resolved root, and where it resolves to.
  const partPaths = new Set<string>();
  for (const part of input.parts)
    for (const partPath of part.paths) {
      partPaths.add(partPath);
      partPaths.add(path.join(realpath(path.dirname(partPath)), path.basename(partPath)));
      partPaths.add(resolvePart(partPath));
    }

  const halt = (): boolean => {
    if (stopped !== null) return true;
    if (entries >= input.maxEntries) stopped = "entries";
    else if (entries % 512 === 0 && now() - startedAt >= input.deadlineMs) stopped = "deadline";
    else if (entries % 64 === 0 && shouldStop()) stopped = "cancelled";
    if (stopped === null && entries > 0 && entries % 1024 === 0 && entries !== pausedAt) {
      pausedAt = entries;
      pause();
    }
    return stopped !== null;
  };
  const opaque = (target: string): boolean => {
    const name = path.basename(target);
    return (
      name === "node_modules" ||
      (name === "objects" && path.basename(path.dirname(target)) === ".git")
    );
  };

  /**
   * Walks `start` depth first. Returns its bytes, checkouts, and its newest
   * change (null when unknown). `skip` holds paths measured as parts.
   */
  const walk = (
    start: string,
    options: {
      readonly countCheckouts: boolean;
      readonly skip: ReadonlySet<string> | null;
      /** The device entries must be on; default the starting folder's own. */
      readonly dev?: bigint | null;
    },
  ): { bytes: number; checkouts: number; newestMs: number | null; reached: boolean } => {
    let bytes = 0;
    let checkouts = 0;
    let newest: number | null = null;
    let ageKnown = true;
    let reached = false;
    let startDev: bigint | null = options.dev ?? null;
    // [path, depth below start, inside an opaque folder]
    const pending: Array<[string, number, boolean]> = [[start, 0, false]];
    while (pending.length > 0) {
      if (halt()) {
        ageKnown = false;
        break;
      }
      const [current, depth, inOpaque] = pending.pop()!;
      if (options.skip !== null && depth > 0 && options.skip.has(current)) continue;
      entries += 1;
      let stat: ReturnType<WalkFs["lstatSync"]>;
      try {
        stat = fs.lstatSync(current, { bigint: true });
      } catch {
        if (depth === 0) return { bytes: 0, checkouts: 0, newestMs: null, reached: false };
        unreadable += 1;
        ageKnown = false;
        continue;
      }
      if (depth === 0) {
        reached = true;
        startDev ??= stat.dev;
      }
      if (startDev !== null && stat.dev !== startDev) {
        otherDevice += 1;
        continue;
      }
      if (!inOpaque && path.basename(current) !== ".DS_Store") {
        const changed = Number(stat.mtimeMs > stat.ctimeMs ? stat.mtimeMs : stat.ctimeMs);
        if (Number.isFinite(changed))
          newest = newest === null ? changed : Math.max(newest, changed);
        else ageKnown = false;
      }
      const counted = !stat.isDirectory() && stat.nlink > 1n;
      const key = counted ? `${stat.dev}:${stat.ino}` : "";
      if (!counted || !seenLinked.has(key)) {
        if (counted) seenLinked.add(key);
        // Allocated size, as `du` reports it; Windows reports no blocks.
        bytes += Number(stat.blocks > 0n ? stat.blocks * 512n : stat.size);
      }
      if (!stat.isDirectory()) continue;
      let names: Array<string>;
      try {
        names = fs.readdirSync(current);
      } catch {
        unreadable += 1;
        ageKnown = false;
        continue;
      }
      if (options.countCheckouts && depth >= 1 && depth <= 2 && names.includes(".git"))
        checkouts += 1;
      const childOpaque = inOpaque || (depth > 0 && opaque(current));
      for (const name of names) pending.push([path.join(current, name), depth + 1, childOpaque]);
    }
    return { bytes, checkouts, newestMs: ageKnown ? newest : null, reached };
  };

  const parts: Array<WalkPartResult> = [];
  let totalBytes = 0;
  for (const part of input.parts) {
    let bytes = 0;
    let checkouts = 0;
    const children: Array<WalkChild> = [];
    for (const givenPath of part.paths) {
      const partPath = resolvePart(givenPath);
      if (part.children) {
        let names: Array<string> = [];
        let isDirectory = false;
        let partDev: bigint | null = null;
        try {
          const partStat = fs.lstatSync(partPath, { bigint: true });
          isDirectory = partStat.isDirectory();
          partDev = partStat.dev;
          names = isDirectory ? fs.readdirSync(partPath) : [];
        } catch {
          names = [];
        }
        // The folder itself, then each child on its own.
        if (isDirectory) {
          try {
            const own = fs.lstatSync(partPath, { bigint: true });
            bytes += Number(own.blocks > 0n ? own.blocks * 512n : own.size);
            entries += 1;
          } catch {
            unreadable += 1;
          }
        }
        const only = part.onlyChildren === undefined ? null : new Set(part.onlyChildren);
        for (const name of names.toSorted()) {
          if (only !== null && !only.has(name)) continue;
          const child = path.join(partPath, name);
          let kind: WalkChild["kind"] = "other";
          try {
            const stat = fs.lstatSync(child, { bigint: true });
            kind = stat.isSymbolicLink()
              ? "symlink"
              : stat.isDirectory()
                ? "directory"
                : stat.isFile()
                  ? "file"
                  : "other";
          } catch {
            kind = "other";
          }
          // A volume mounted in the folder is another device: skipped like any mount.
          const measured = walk(child, { countCheckouts: false, skip: null, dev: partDev });
          bytes += measured.bytes;
          children.push({
            name,
            kind,
            bytes: measured.bytes,
            newestMs: measured.reached ? measured.newestMs : null,
          });
        }
      } else {
        const measured = walk(partPath, {
          countCheckouts: part.countCheckouts === true,
          skip: null,
        });
        bytes += measured.bytes;
        checkouts += measured.checkouts;
      }
    }
    totalBytes += bytes;
    parts.push({ key: part.key, bytes, checkouts, children });
  }
  if (input.measureRest !== false) {
    const rest = walk(root, { countCheckouts: false, skip: partPaths });
    totalBytes += rest.bytes;
    parts.push({ key: "other", bytes: rest.bytes, checkouts: 0, children: [] });
  }
  return {
    totalBytes,
    parts,
    entries,
    otherDevice,
    unreadable,
    complete: stopped === null,
    stopped,
  };
}
