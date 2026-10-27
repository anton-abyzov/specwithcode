// @effect-diagnostics nodeBuiltinImport:off -- the age walk needs lstat, which effect/FileSystem does not offer, so symlinks are never followed.
/**
 * Which folders under `<baseDir>/scratch` may go. That folder is the Scratch
 * project ("No project"): each chat thread there has a folder of its own that
 * nothing can recreate. Agents also leave probes and run logs beside them. On
 * 2026-10-27 an ad hoc script removed 147 of these folders by a one-day mtime
 * cutoff, without a dry run or an archive; `specweave-studio scratch prune`
 * replaces such scripts.
 *
 * A folder may go only when every check passes: it is a real folder (no
 * symlink or file), no live path overlaps it, and every entry in it is known
 * to be older than the cutoff. Anything unknown keeps it. An entry's age is
 * the newer of its mtime and ctime: `tar x`, `rsync -a`, `cp -p` or a move
 * back from an archive bring old mtimes along, but no tool can set ctime, and
 * it changes when the file arrives.
 *
 * @module scratchPrune
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { olderThan } from "./failClosedAge.ts";

export const DAY_MS = 86_400_000;
/** Below this, folders an agent is still using could go. */
export const SCRATCH_PRUNE_MIN_AGE_MS = 7 * DAY_MS;
export const SCRATCH_PRUNE_DEFAULT_AGE_MS = 14 * DAY_MS;
/** A larger tree is kept rather than walked further. */
export const SCRATCH_PRUNE_WALK_LIMIT = 20_000;

/** `14d`, `2w` or `336h` in milliseconds; null for anything else. */
export function parseAge(text: string): number | null {
  const match = /^(\d+)([hdw])$/.exec(text.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "d" ? DAY_MS : 7 * DAY_MS;
  const ms = amount * unit;
  return Number.isSafeInteger(ms) ? ms : null;
}

/** The newest change in a tree, or why it is unknown. */
export type TreeAge =
  | { readonly known: true; readonly newestMs: number; readonly entries: number }
  | { readonly known: false; readonly reason: string };

/** When an entry last changed: the newer of its mtime and ctime. */
export const changedAt = (stat: NodeFS.Stats): number => Math.max(stat.mtimeMs, stat.ctimeMs);

/**
 * Newest change time of `root` and everything under it, read with lstat so a
 * symlink counts by its own time and is never followed. Any failed read, a
 * missing or non-finite time, or more than `limit` entries makes it unknown.
 * `timeOf` exists for tests, which can set mtimes but not ctimes.
 */
export function newestTreeMtime(
  root: string,
  limit = SCRATCH_PRUNE_WALK_LIMIT,
  timeOf: (stat: NodeFS.Stats) => number = changedAt,
): TreeAge {
  const pending = [root];
  let newest: number | null = null;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    entries += 1;
    if (entries > limit) return { known: false, reason: `more than ${limit} entries` };
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(current);
    } catch (cause) {
      return { known: false, reason: `cannot read ${current}: ${errorText(cause)}` };
    }
    const changed = timeOf(stat);
    if (!Number.isFinite(changed)) return { known: false, reason: `no time for ${current}` };
    newest = newest === null ? changed : Math.max(newest, changed);
    if (!stat.isDirectory()) continue;
    let names: Array<string>;
    try {
      names = NodeFS.readdirSync(current);
    } catch (cause) {
      return { known: false, reason: `cannot list ${current}: ${errorText(cause)}` };
    }
    for (const name of names) pending.push(NodePath.join(current, name));
  }
  return newest === null
    ? { known: false, reason: "no readings" }
    : { known: true, newestMs: newest, entries };
}

/** A path something still uses, with who uses it. Paths are absolute and canonical. */
export interface ScratchLivePath {
  readonly paths: ReadonlyArray<string>;
  readonly owner: string;
}

/** One direct child of the scratch folder, as read from disk. */
export interface ScratchEntry {
  readonly name: string;
  /** Every spelling to match live paths against: the real path first. */
  readonly paths: ReadonlyArray<string>;
  readonly kind: "directory" | "symlink" | "file" | "other";
  readonly age: TreeAge;
}

export type ScratchDecision =
  | {
      readonly name: string;
      readonly path: string;
      readonly action: "remove";
      readonly newestMs: number;
      readonly reason: string;
    }
  | {
      readonly name: string;
      readonly path: string;
      readonly action: "keep";
      readonly newestMs: number | null;
      readonly reason: string;
    };

/**
 * Platforms whose file systems ignore letter case by default: APFS and HFS+
 * on macOS, NTFS on Windows. Folding there can only match more paths, which
 * keeps more.
 */
export const casesFoldOn = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "win32";

/**
 * `candidate` is `root` or inside it. The same rule as `pathWithin` in
 * git/worktreeOwnership.ts, without the Effect `Path` service, so the CLI and
 * these pure checks can share it; `foldCase` also matches paths stored with
 * other letter case.
 */
export function pathInside(root: string, candidate: string, foldCase = false): boolean {
  const relative = foldCase
    ? NodePath.relative(root.toLowerCase(), candidate.toLowerCase())
    : NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

const days = (ms: number) => `${Math.floor(ms / DAY_MS)}d`;

/**
 * Decides every entry. Live paths at the scratch folder itself or around it
 * (the Scratch project's own root, an umbrella project) do not bind its
 * children, since they would bind every one; any other live path keeps each
 * entry it overlaps in either direction.
 */
export function decideScratchPrune(input: {
  readonly scratchRoots: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<ScratchEntry>;
  readonly livePaths: ReadonlyArray<ScratchLivePath>;
  readonly now: number;
  readonly olderThanMs: number;
  /** Match paths that differ only in letter case; see `casesFoldOn`. */
  readonly foldCase: boolean;
}): ReadonlyArray<ScratchDecision> {
  const { foldCase } = input;
  const binding = input.livePaths.filter(
    (live) =>
      !live.paths.some((path) =>
        input.scratchRoots.some((root) => pathInside(path, root, foldCase)),
      ),
  );
  return input.entries.map((entry): ScratchDecision => {
    const path = entry.paths[0]!;
    const base = { name: entry.name, path };
    const newestMs = entry.age.known ? entry.age.newestMs : null;
    const keep = (reason: string): ScratchDecision => ({
      ...base,
      action: "keep",
      newestMs,
      reason,
    });
    if (entry.kind !== "directory") return keep(`not a folder (${entry.kind})`);
    const owner = binding.find((live) =>
      live.paths.some((livePath) =>
        entry.paths.some(
          (spelling) =>
            pathInside(spelling, livePath, foldCase) || pathInside(livePath, spelling, foldCase),
        ),
      ),
    );
    if (owner !== undefined) return keep(`in use by ${owner.owner}`);
    if (!entry.age.known) return keep(`age unknown: ${entry.age.reason}`);
    if (!Number.isFinite(entry.age.newestMs)) return keep("age unknown: no valid mtime");
    if (!Number.isFinite(input.olderThanMs) || input.olderThanMs < SCRATCH_PRUNE_MIN_AGE_MS)
      return keep("cutoff below the minimum");
    if (!olderThan(entry.age.newestMs, input.olderThanMs, input.now))
      return keep(
        entry.age.newestMs > input.now
          ? "modified in the future"
          : `modified ${days(input.now - entry.age.newestMs)} ago`,
      );
    return {
      ...base,
      action: "remove",
      newestMs: entry.age.newestMs,
      reason: `unused, modified ${days(input.now - entry.age.newestMs)} ago`,
    };
  });
}

/** Reads the direct children of a scratch folder. `root` must be its real path. */
export function readScratchEntries(
  root: string,
  aliases: ReadonlyArray<string> = [],
): ReadonlyArray<ScratchEntry> {
  return NodeFS.readdirSync(root)
    .sort()
    .map((name): ScratchEntry => {
      const real = NodePath.join(root, name);
      const paths = [real, ...aliases.map((alias) => NodePath.join(alias, name))].filter(
        (value, index, all) => all.indexOf(value) === index,
      );
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(real);
      } catch (cause) {
        return {
          name,
          paths,
          kind: "other",
          age: { known: false, reason: `cannot read: ${errorText(cause)}` },
        };
      }
      const kind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other";
      return {
        name,
        paths,
        kind,
        age: kind === "directory" ? newestTreeMtime(real) : { known: false, reason: kind },
      };
    });
}

/**
 * Copies `source` into the existing empty folder `target`: folders, files and
 * symlinks (as links, never followed), with their times. Anything else, or
 * any failed read, throws. Not `cpSync`: on Node 22 its native copy aborts the
 * whole process on an unreadable folder instead of throwing.
 */
function copyTree(source: string, target: string): void {
  const times: Array<readonly [string, NodeFS.Stats]> = [[target, NodeFS.lstatSync(source)]];
  const pending: Array<readonly [string, string]> = NodeFS.readdirSync(source).map((name) => [
    NodePath.join(source, name),
    NodePath.join(target, name),
  ]);
  while (pending.length > 0) {
    const [from, to] = pending.pop()!;
    const stat = NodeFS.lstatSync(from);
    if (stat.isSymbolicLink()) {
      NodeFS.symlinkSync(NodeFS.readlinkSync(from), to);
      NodeFS.lutimesSync(to, stat.atime, stat.mtime);
      continue;
    }
    if (stat.isDirectory()) {
      NodeFS.mkdirSync(to);
      for (const name of NodeFS.readdirSync(from))
        pending.push([NodePath.join(from, name), NodePath.join(to, name)]);
    } else if (stat.isFile()) {
      NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
    } else {
      throw new Error(`cannot copy ${from}: not a file, folder or symlink`);
    }
    times.push([to, stat]);
  }
  // Folders last, children first, so writing into them does not move their times again.
  for (const [path, stat] of times.toReversed()) NodeFS.utimesSync(path, stat.atime, stat.mtime);
}

/** The folder was copied into the archive, but removing the source stopped part way. */
export class SourcePartlyRemovedError extends Error {
  readonly target: string;
  constructor(target: string, cause: unknown) {
    super(`archived to ${target}, but the source was only partly removed: ${errorText(cause)}`, {
      cause,
    });
    this.target = target;
  }
}

/**
 * Moves a folder into `archiveDir`, copying across volumes. The destination
 * is claimed first with an exclusive mkdir, so an existing one (even empty)
 * fails rather than being replaced. A copy that fails part way is removed and
 * the source kept; a source that cannot be fully removed after a complete
 * copy throws `SourcePartlyRemovedError`. `move` exists for tests.
 */
function claimFolder(target: string): void {
  try {
    NodeFS.mkdirSync(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`${target} already exists`, { cause });
    throw cause;
  }
}

export function archiveFolder(
  source: string,
  archiveDir: string,
  move: (from: string, to: string) => void = NodeFS.renameSync,
): string {
  const target = NodePath.join(archiveDir, NodePath.basename(source));
  claimFolder(target);
  try {
    // Replaces only the empty folder claimed above; anything put in it since fails.
    // Windows cannot rename onto an existing folder, so the claim is released
    // first; its rename then refuses a target that reappeared in between.
    if (process.platform === "win32") NodeFS.rmdirSync(target);
    move(source, target);
    return target;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") {
      // rmdir: only the empty folder claimed above, never anything put in it since.
      try {
        NodeFS.rmdirSync(target);
      } catch {
        // A claim left behind only makes a later run report "already exists".
      }
      throw cause;
    }
  }
  // The Windows path released the claim before its rename; take it again.
  if (process.platform === "win32") claimFolder(target);
  try {
    copyTree(source, target);
  } catch (cause) {
    NodeFS.rmSync(target, { recursive: true, force: true });
    throw cause;
  }
  try {
    NodeFS.rmSync(source, { recursive: true });
  } catch (cause) {
    throw new SourcePartlyRemovedError(target, cause);
  }
  return target;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
