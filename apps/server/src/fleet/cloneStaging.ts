// @effect-diagnostics nodeBuiltinImport:off - plain file reads beside a clone, like folderTransfer/git.ts.
/**
 * The folder a Sync clone is made in before it is moved into place (1390).
 *
 * It sits beside the clone's target, is named `.swc-clone-{name}-{random}`,
 * and holds two things: a mark file this module writes first, and the folder
 * `clone` Git fills. The name alone proves nothing: a person may name a folder
 * of their own that way. Only a folder that carries the mark is treated as a
 * staging folder, which means it is no repository of the project, no work of
 * the repository above it, and never part of a snapshot. A folder with the
 * name and without the mark is left alone and counted like any other folder.
 *
 * The mark names its owner: the server process (its id and when it started)
 * and a random token of the clone. A staging folder is removed only once that
 * process is provably gone; one whose owner may still be running is left.
 */
import * as NodeCrypto from "node:crypto";
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
const OWNER_PREFIX = "owner ";
const MARK_MAX_BYTES = 4096;

/** The process that writes a mark: its id, when it started, and the clone's own token. */
export interface CloneStagingOwner {
  readonly pid: number;
  readonly started: number;
  readonly token: string;
}

// @effect-diagnostics-next-line globalDate:off - a process's start, as wall-clock time, read once.
const STARTED = Math.round(Date.now() - process.uptime() * 1000);

/** The text of a mark for `owner`. */
export const cloneStagingMarkText = (owner: CloneStagingOwner) =>
  `${MARK_TEXT}${OWNER_PREFIX}${JSON.stringify(owner)}\n`;

/** The owner a mark's text names, or null when it is not a mark this module writes. */
const ownerOf = (text: string): CloneStagingOwner | null => {
  if (!text.startsWith(MARK_TEXT) || !text.endsWith("\n")) return null;
  const line = text.slice(MARK_TEXT.length, -1);
  if (!line.startsWith(OWNER_PREFIX) || line.includes("\n")) return null;
  try {
    const owner = JSON.parse(line.slice(OWNER_PREFIX.length)) as Partial<CloneStagingOwner>;
    return Number.isSafeInteger(owner.pid) &&
      owner.pid! > 0 &&
      Number.isSafeInteger(owner.started) &&
      typeof owner.token === "string" &&
      /^[0-9a-f]{32}$/.test(owner.token)
      ? { pid: owner.pid!, started: owner.started!, token: owner.token }
      : null;
  } catch {
    return null;
  }
};

/** Whether a folder or file name is shaped like a staging folder's. It may still be a person's own. */
export const namedLikeCloneStaging = (name: string) => CLONE_STAGING_NAME.test(name);

/** Writes the mark, owned by this process, into a staging folder this call just made. */
export async function markCloneStaging(folder: string): Promise<CloneStagingOwner> {
  const owner = {
    pid: process.pid,
    started: STARTED,
    token: NodeCrypto.randomBytes(16).toString("hex"),
  };
  await NodeFSP.writeFile(NodePath.join(folder, CLONE_STAGING_MARK), cloneStagingMarkText(owner), {
    flag: "wx",
  });
  return owner;
}

/** The owner of a real folder (no link) with a staging folder's name that carries the mark. */
export async function cloneStagingOwner(folder: string): Promise<CloneStagingOwner | null> {
  if (!namedLikeCloneStaging(NodePath.basename(folder))) return null;
  const stat = await NodeFSP.lstat(folder).catch(() => null);
  if (stat === null || !stat.isDirectory()) return null;
  const file = NodePath.join(folder, CLONE_STAGING_MARK);
  const mark = await NodeFSP.lstat(file).catch(() => null);
  if (mark === null || !mark.isFile() || mark.size > MARK_MAX_BYTES) return null;
  return ownerOf(await NodeFSP.readFile(file, "utf8").catch(() => ""));
}

/** A real folder (no link) with a staging folder's name that carries the mark. */
export async function isMarkedCloneStaging(folder: string): Promise<boolean> {
  return (await cloneStagingOwner(folder)) !== null;
}

/**
 * Who a mark's owner is now: this very process, another that may still be
 * running (its id is in use, by it or by another program), or gone (no process
 * has that id, or this process has it and started at another time).
 */
export function ownerState(owner: CloneStagingOwner): "this-process" | "maybe-running" | "gone" {
  if (owner.pid === process.pid) return owner.started === STARTED ? "this-process" : "gone";
  try {
    process.kill(owner.pid, 0);
    return "maybe-running";
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "ESRCH" ? "gone" : "maybe-running";
  }
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
