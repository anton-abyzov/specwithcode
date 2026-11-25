// @effect-diagnostics nodeBuiltinImport:off - capture pins each source root by inode with no-follow descriptors.
/**
 * Pins a captured copy's source roots by identity, so every file read can be proven to
 * sit below the root the capture started from, whatever happens to the folders above it.
 *
 * Path checks alone cannot prove that: a folder above the root can be swapped for another
 * tree while a file is opened and put back before the folders are looked at again, and the
 * folders above the root are compared by identity only (their times change all day). The
 * anchored lookup starts from the root's inode instead of its path: `/.vol/<dev>/<ino>` on
 * macOS, the root's open descriptor under `/proc/self/fd` on Linux. It then takes one name
 * at a time, so no folder below the root that became a link can lead it elsewhere. Windows
 * has neither, so there the path checks stay the only guard.
 *
 * @module sourceCaptureAnchor
 */
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { linkTargetOnWire } from "./paths.ts";
import { CaptureFilesystemRefused } from "./sourceCaptureFilesystem.ts";

/** The root as the scan saw it start. */
export interface ScannedRoot {
  readonly dev: string;
  readonly ino: string;
}

/** A folder below the pinned root, reached one name at a time; release when done. */
interface Reached {
  /** Where a name inside that folder is looked up. */
  readonly at: string;
  readonly release: () => Promise<void>;
}

export interface RootAnchor {
  /** The pinned root's lookup path; null where no lookup exists. */
  readonly base: string | null;
  /**
   * The folder `parts` names below the pinned root, each name looked up inside the folder
   * before it and none followed as a link, so a folder turned into a link cannot lead out.
   * Null when a name there is missing or is not a real folder.
   */
  readonly reach: (parts: ReadonlyArray<string>) => Promise<Reached | null>;
  readonly close: () => Promise<void>;
}

const noRelease = async () => {};

/** Test seams for pinning races and lookup failures. */
export interface PinSeams {
  /** Runs after the root is first looked at. */
  readonly afterStat?: () => Promise<void>;
  /** Replaces the anchored lookup of the root. */
  readonly lookUp?: (base: string) => Promise<FS.BigIntStats>;
}

/** Lookup errors that mean the anchored path does not exist on this system. */
const NO_LOOKUP = new Set(["ENOENT", "ENOTDIR", "ENOTSUP", "EOPNOTSUPP"]);

const lookupFailed = (code: string) =>
  new Error(`The source folder could not be pinned (${code}). Try a new comparison.`);

const unpinnable = () =>
  new CaptureFilesystemRefused(
    "This folder cannot be pinned for a captured copy on this machine. Try a new comparison.",
  );

/** The root as the capture starts: a real directory, looked up again from its own identity. */
export async function pinSourceRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
  scanned?: ScannedRoot,
  seams: PinSeams = {},
): Promise<RootAnchor> {
  // A root that changed refuses outright: only an unsupported filesystem may let a moving
  // copy fall back to its live checks.
  const changed = () =>
    new Error("The source folder changed after it was measured. Try a new comparison.");
  const stat = await FSP.lstat(root, { bigint: true });
  if (!stat.isDirectory()) throw changed();
  // The folder the inventory came from, not one put in its place since.
  if (scanned && (String(stat.dev) !== scanned.dev || String(stat.ino) !== scanned.ino))
    throw changed();
  await seams.afterStat?.();
  const same = (seen: FS.BigIntStats | null) =>
    seen !== null && seen.isDirectory() && seen.dev === stat.dev && seen.ino === stat.ino;
  /**
   * Looks the root up through `base`. Only a lookup that does not exist (no `/.vol`, no
   * `/proc`) while the root is still there is an unsupported filesystem, the one case a
   * moving copy may fall back to its live checks for. Any other failure refuses.
   */
  const lookUp = async (base: string) => {
    const looked = await (seams.lookUp ?? ((path: string) => FSP.stat(path, { bigint: true })))(
      base,
    ).then(
      (seen) => ({ seen, code: null }),
      (cause: NodeJS.ErrnoException) => ({ seen: null, code: cause.code ?? "" }),
    );
    if (same(looked.seen)) return;
    if (looked.code === null) return changed();
    if (!NO_LOOKUP.has(looked.code)) return lookupFailed(looked.code);
    return same(await FSP.lstat(root, { bigint: true }).catch(() => null))
      ? unpinnable()
      : changed();
  };
  if (platform === "darwin") {
    const base = `/.vol/${stat.dev}/${stat.ino}`;
    const refused = await lookUp(base);
    if (refused) throw refused;
    // Each folder by its own inode: `/.vol/<dev>/<ino>/<name>` resolves one name only.
    const reach = async (parts: ReadonlyArray<string>): Promise<Reached | null> => {
      let at = base;
      for (const part of parts) {
        const seen = await FSP.lstat(`${at}/${part}`, { bigint: true }).catch(() => null);
        if (!seen?.isDirectory()) return null;
        at = `/.vol/${seen.dev}/${seen.ino}`;
      }
      return { at, release: noRelease };
    };
    return { base, reach, close: noRelease };
  }
  if (platform === "linux") {
    const handle = await FSP.open(
      root,
      FS.constants.O_RDONLY | FS.constants.O_DIRECTORY | FS.constants.O_NOFOLLOW,
    ).catch((cause: NodeJS.ErrnoException) => {
      throw ["ELOOP", "ENOTDIR", "ENOENT"].includes(cause.code ?? "") ? changed() : cause;
    });
    const base = `/proc/self/fd/${handle.fd}`;
    const opened = await handle.stat({ bigint: true }).catch(() => null);
    const refused = same(opened) ? await lookUp(base) : changed();
    if (refused) {
      await handle.close();
      throw refused;
    }
    // Each folder opened inside the one before it, refusing a link: the kernel follows only
    // the descriptor's own entry under /proc, then one name.
    const reach = async (parts: ReadonlyArray<string>): Promise<Reached | null> => {
      const held: Array<FSP.FileHandle> = [];
      const release = async () => {
        await Promise.all(held.map((folder) => folder.close()));
      };
      let at = base;
      for (const part of parts) {
        const folder = await FSP.open(
          `${at}/${part}`,
          FS.constants.O_RDONLY | FS.constants.O_DIRECTORY | FS.constants.O_NOFOLLOW,
        ).catch(() => null);
        if (!folder) {
          await release();
          return null;
        }
        held.push(folder);
        at = `/proc/self/fd/${folder.fd}`;
      }
      return { at, release };
    };
    return { base, reach, close: () => handle.close() };
  }
  return { base: null, reach: async () => null, close: noRelease };
}

/** Looks up `relative`'s last name inside its folder reached from the pinned root. */
async function fromRoot<T>(
  anchor: RootAnchor,
  relative: string,
  look: (named: string) => Promise<T | null>,
): Promise<T | null> {
  const parts = relative.split("/");
  const last = parts.pop()!;
  const folder = await anchor.reach(parts);
  if (!folder) return null;
  try {
    return await look(`${folder.at}/${last}`);
  } finally {
    await folder.release();
  }
}

/** True when `relative`, looked up from the pinned root, is the file that was opened. */
export async function reachedFromRoot(
  anchor: RootAnchor,
  relative: string,
  opened: FS.BigIntStats,
): Promise<boolean> {
  if (anchor.base === null) return true;
  const named = await fromRoot(anchor, relative, (path) =>
    FSP.lstat(path, { bigint: true }).catch(() => null),
  );
  return named !== null && named.dev === opened.dev && named.ino === opened.ino;
}

/**
 * The link target `relative` holds, looked up from the pinned root: null when it is no
 * link there, undefined where no anchored lookup exists.
 */
export async function linkFromRoot(
  anchor: RootAnchor,
  relative: string,
): Promise<string | null | undefined> {
  if (anchor.base === null) return undefined;
  // Every folder above the link is a real folder below the root, not a link out of it.
  return fromRoot(anchor, relative, async (named) => {
    const stat = await FSP.lstat(named).catch(() => null);
    if (!stat?.isSymbolicLink()) return null;
    return FSP.readlink(named).then(linkTargetOnWire, () => null);
  });
}
