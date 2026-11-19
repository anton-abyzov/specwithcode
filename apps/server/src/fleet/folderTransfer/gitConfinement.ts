// @effect-diagnostics nodeBuiltinImport:off - Lists the folders a Git command would write into.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { runGit } from "./git.ts";

/**
 * Git writes where Apply cannot stand beside each write: into its own data
 * folders and, when a branch moves, into every folder that holds a changed
 * file. These list those places first, so Apply can hold each to the same rule
 * as its own writes and refuse the command when one fails. Null means the
 * places could not be listed, and the command must not run.
 */

const posix = (path: string) => path.split(NodePath.sep).join("/");

/**
 * Every folder of the Git data a command in `repo` may write: the repository's
 * own Git folder and the shared one of a linked worktree, with all folders
 * below them, relative to `root`, and the first file among them (objects aside)
 * that has another name or is a link, which Git would write through. Null when
 * either folder lies outside `root`.
 */
export async function gitAdminFolders(
  root: string,
  repo: string,
): Promise<{ readonly folders: Array<string>; readonly shared: string | null } | null> {
  const cwd = repo === "." ? root : NodePath.join(root, ...repo.split("/"));
  const tops = new Set<string>();
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const result = await runGit(cwd, ["rev-parse", flag], { allowFailure: true });
    if (result.code !== 0 || result.stdout.trim().length === 0) return null;
    tops.add(NodePath.resolve(cwd, result.stdout.trim()));
  }
  const folders: Array<string> = [];
  let shared: string | null = null;
  try {
    const realRoot = await NodeFSP.realpath(root);
    for (const top of tops) {
      const relative = NodePath.relative(realRoot, await NodeFSP.realpath(top));
      if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative))
        return null;
      // Git never rewrites an object: it adds new ones by name. Everything else
      // (logs, refs, HEAD, config, pointers) it may write in place.
      const objects = NodePath.join(relative, "objects");
      const pending = [relative];
      for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
        folders.push(posix(folder));
        const inObjects = folder === objects || folder.startsWith(objects + NodePath.sep);
        for (const entry of await NodeFSP.readdir(NodePath.join(realRoot, folder), {
          withFileTypes: true,
        })) {
          const child = NodePath.join(folder, entry.name);
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isSymbolicLink()) {
            const named = await NodeFSP.stat(NodePath.join(realRoot, child)).catch(() => null);
            // A linked folder is listed: the folder check refuses it by name. A linked file is written through.
            if (named?.isDirectory()) folders.push(posix(child));
            else if (!inObjects) shared ??= posix(child);
          } else if (!inObjects && shared === null) {
            // A second name for these bytes may be anywhere: a write here would change that file too.
            const stat = await NodeFSP.lstat(NodePath.join(realRoot, child));
            if (stat.nlink > 1) shared = posix(child);
          }
        }
      }
    }
  } catch {
    return null;
  }
  return { folders, shared };
}

/** Paths, relative to the repository, whose working files change when HEAD moves from `from` to `to`. */
export async function gitTouchedPaths(
  cwd: string,
  from: string | null,
  to: string,
): Promise<Array<string> | null> {
  const result = await runGit(
    cwd,
    from === null
      ? ["ls-tree", "-r", "--name-only", "-z", to]
      : ["diff", "--name-only", "--no-renames", "-z", from, to],
    { allowFailure: true },
  );
  return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : null;
}

/** Paths a stash of everything would take out of the working tree: changed and untracked files. */
export async function gitDirtyPaths(cwd: string): Promise<Array<string> | null> {
  const result = await runGit(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    { allowFailure: true },
  );
  if (result.code !== 0) return null;
  return result.stdout
    .split("\0")
    .filter((field) => field.length > 3)
    .map((field) => field.slice(3));
}

/** True when `relative` is a tracked file exactly as Git checked it out: Git put it there, nobody else. */
export async function gitCheckedOut(cwd: string, relative: string): Promise<boolean> {
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", relative], {
    allowFailure: true,
  });
  if (tracked.code !== 0) return false;
  const status = await runGit(cwd, ["status", "--porcelain=v1", "--", relative], {
    allowFailure: true,
  });
  return status.code === 0 && status.stdout.trim().length === 0;
}

/** Git's own reason for a failed clone, short and without URLs that could carry tokens. */
export function cloneFailureReason(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((item) => item.replace(/^(?:fatal|error|remote): /, "").trim())
    .find((item) => item.length > 0 && !/https?:\/\//.test(item));
  return line ? ` (${line.slice(0, 160)})` : "";
}
