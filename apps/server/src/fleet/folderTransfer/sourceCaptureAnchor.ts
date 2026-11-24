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
import { CaptureFilesystemRefused } from "./sourceCaptureFilesystem.ts";

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
): Promise<RootAnchor> {
  const stat = await FSP.lstat(root, { bigint: true });
  if (!stat.isDirectory()) throw unpinnable();
  const same = (seen: FS.BigIntStats | null) =>
    seen !== null && seen.isDirectory() && seen.dev === stat.dev && seen.ino === stat.ino;
  if (platform === "darwin") {
    const base = `/.vol/${stat.dev}/${stat.ino}`;
    if (!same(await FSP.stat(base, { bigint: true }).catch(() => null))) throw unpinnable();
    return { base, close: async () => {} };
  }
  if (platform === "linux") {
    const handle = await FSP.open(
      root,
      FS.constants.O_RDONLY | FS.constants.O_DIRECTORY | FS.constants.O_NOFOLLOW,
    );
    const base = `/proc/self/fd/${handle.fd}`;
    const opened = await handle.stat({ bigint: true }).catch(() => null);
    const looked = await FSP.stat(base, { bigint: true }).catch(() => null);
    if (!same(opened) || !same(looked)) {
      await handle.close();
      throw unpinnable();
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
