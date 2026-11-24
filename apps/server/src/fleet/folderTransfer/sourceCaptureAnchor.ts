// @effect-diagnostics nodeBuiltinImport:off - capture pins each source root by inode with no-follow descriptors.
/**
 * Pins a captured copy's source roots by identity, so every file read can be proven to
 * sit below the root the capture started from, whatever happens to the folders above it.
 *
 * Path checks alone cannot prove that: a folder above the root can be swapped for another
 * tree while a file is opened and put back before the folders are looked at again, and the
 * folders above the root are compared by identity only (their times change all day). The
 * anchored lookup starts from the root's inode instead of its path: `/.vol/<dev>/<ino>` on
 * macOS, the root's open descriptor under `/proc/self/fd` on Linux. Windows has neither, so
 * there the path checks stay the only guard.
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

export interface RootAnchor {
  /** Where a name below the root is looked up from the pinned root; null where no lookup exists. */
  readonly base: string | null;
  readonly close: () => Promise<void>;
}

const unpinnable = () =>
  new CaptureFilesystemRefused(
    "This folder cannot be pinned for a captured copy on this machine. Try a new comparison.",
  );

/** The root as the capture starts: a real directory, looked up again from its own identity. */
export async function pinSourceRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
  scanned?: ScannedRoot,
  /** Test seam: runs after the root is first looked at. */
  afterStat?: () => Promise<void>,
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
  await afterStat?.();
  const same = (seen: FS.BigIntStats | null) =>
    seen !== null && seen.isDirectory() && seen.dev === stat.dev && seen.ino === stat.ino;
  // A lookup that failed is an unsupported filesystem only while the root is still there.
  const unsupportedOrChanged = async () =>
    same(await FSP.lstat(root, { bigint: true }).catch(() => null)) ? unpinnable() : changed();
  if (platform === "darwin") {
    const base = `/.vol/${stat.dev}/${stat.ino}`;
    if (!same(await FSP.stat(base, { bigint: true }).catch(() => null)))
      throw await unsupportedOrChanged();
    return { base, close: async () => {} };
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
    const looked = same(opened)
      ? await FSP.stat(base, { bigint: true }).catch(() => null)
      : null;
    if (!same(opened) || !same(looked)) {
      await handle.close();
      throw same(opened) ? await unsupportedOrChanged() : changed();
    }
    return { base, close: () => handle.close() };
  }
  return { base: null, close: async () => {} };
}

/** True when `relative`, looked up from the pinned root, is the file that was opened. */
export async function reachedFromRoot(
  anchor: RootAnchor,
  relative: string,
  opened: FS.BigIntStats,
): Promise<boolean> {
  if (anchor.base === null) return true;
  const named = await FSP.lstat(Path.posix.join(anchor.base, relative), { bigint: true }).catch(
    () => null,
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
  const parts = relative.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = await FSP.lstat(
      Path.posix.join(anchor.base, ...parts.slice(0, depth)),
    ).catch(() => null);
    if (!parent?.isDirectory()) return null;
  }
  const named = Path.posix.join(anchor.base, relative);
  const stat = await FSP.lstat(named).catch(() => null);
  if (!stat?.isSymbolicLink()) return null;
  return FSP.readlink(named).then(linkTargetOnWire, () => null);
}
