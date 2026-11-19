// @effect-diagnostics nodeBuiltinImport:off - plain file reads beside a clone, like folderTransfer/git.ts.
/**
 * The folder a Sync clone is made in before it is moved into place (1390).
 *
 * It sits beside the clone's target, is named `.swc-clone-{name}-{random}`,
 * and holds two things: a mark file this module writes first, and the folder
 * `clone` Git fills. The name alone proves nothing: a person may name a folder
 * of their own that way. Only a folder that carries the mark is treated as a
 * staging folder, which means it is no repository of the project, no work of
 * the repository above it, never part of a snapshot, and removed when the
 * clone that made it is gone. A folder with the name and without the mark is
 * left alone and counted like any other folder.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const CLONE_STAGING_PREFIX = ".swc-clone-";
/** The prefix, the target's name, and the six characters `mkdtemp` adds. */
const CLONE_STAGING_NAME = /^\.swc-clone-.+-[A-Za-z0-9]{6}$/;
/** The mark file's name inside a staging folder. */
export const CLONE_STAGING_MARK = "swc-clone-staging";
/** The folder inside a staging folder that Git clones into. */
export const CLONE_STAGING_CLONE = "clone";
const MARK_TEXT =
  "SpecWithCode is cloning a repository into this folder and moves it into place when it is whole.\n" +
  "If no Sync is running, the clone was stopped and this folder can be deleted.\n";

/** Whether a folder or file name is shaped like a staging folder's. It may still be a person's own. */
export const namedLikeCloneStaging = (name: string) => CLONE_STAGING_NAME.test(name);

/** Writes the mark into a staging folder this call just made. */
export async function markCloneStaging(folder: string): Promise<void> {
  await NodeFSP.writeFile(NodePath.join(folder, CLONE_STAGING_MARK), MARK_TEXT, { flag: "wx" });
}

/** A real folder (no link) with a staging folder's name that carries the mark. */
export async function isMarkedCloneStaging(folder: string): Promise<boolean> {
  if (!namedLikeCloneStaging(NodePath.basename(folder))) return false;
  const stat = await NodeFSP.lstat(folder).catch(() => null);
  if (stat === null || !stat.isDirectory()) return false;
  const file = NodePath.join(folder, CLONE_STAGING_MARK);
  const mark = await NodeFSP.lstat(file).catch(() => null);
  if (mark === null || !mark.isFile() || mark.size !== Buffer.byteLength(MARK_TEXT)) return false;
  return (await NodeFSP.readFile(file, "utf8").catch(() => "")) === MARK_TEXT;
}

/**
 * Answers, for paths relative to `root` with `/` separators, whether a path is
 * a marked staging folder or lies inside one. Each folder is looked at once.
 */
export function cloneStagingIn(root: string) {
  const known = new Map<string, Promise<boolean>>();
  /** The marked staging folder a path names or lies in, relative to `root`; null when none. */
  const top = async (path: string): Promise<string | null> => {
    const parts = path.split("/").filter((part) => part.length > 0);
    for (let at = 0; at < parts.length; at += 1) {
      if (!namedLikeCloneStaging(parts[at]!)) continue;
      const relative = parts.slice(0, at + 1).join("/");
      let marked = known.get(relative);
      if (marked === undefined) {
        marked = isMarkedCloneStaging(NodePath.join(root, ...parts.slice(0, at + 1)));
        known.set(relative, marked);
      }
      if (await marked) return relative;
    }
    return null;
  };
  return { top, has: async (path: string) => (await top(path)) !== null };
}
