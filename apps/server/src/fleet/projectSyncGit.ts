// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/** How Sync (1390) runs and reads Git: the pieces its fetch, its move and its service share. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { UNFINISHED_OPERATION_MARKS } from "../handoff/bundleGit.ts";
import { cloneStagingIn } from "./cloneStaging.ts";
import type { GitResult } from "./folderTransfer/git.ts";
import type { AskBudget, FetchRecord } from "./projectSyncOrigin.ts";

export const LOCAL_MS = 30_000;
export const FETCH_MS = 5 * 60_000;

export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** How Sync runs Git. Tests pass a recording runner to assert on every command. */
export type SyncGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** Written to Git's standard input. */
    readonly input?: string;
  },
) => Promise<GitResult>;

export interface SyncContext {
  readonly git: SyncGit;
  /**
   * The title of a running thread that works in this very checkout, or null.
   * Asked each time it matters, never remembered: a thread may start between
   * two reads.
   */
  readonly inUse: (checkout: string) => Promise<string | null>;
  /** Stops a fetch or a clone that is under way when the call is cancelled. A merge is never stopped. */
  readonly signal?: AbortSignal;
  /**
   * The one fetch this call goes by. A fetch writes into it what it brought,
   * per checkout; a move reads from it the commit to move to, and moves
   * nothing without it.
   */
  readonly fetched?: FetchRecord;
  /** The time this call has left for asking `origin` before its moves. */
  readonly asks?: AskBudget;
}

/**
 * The marks of an unfinished operation, plus the one Git keeps while a
 * cherry-pick or revert of several commits is part way through with nothing
 * left to resolve: no head mark, a clean tree, and commits still to pick.
 */
export const UNFINISHED_MARKS = [...UNFINISHED_OPERATION_MARKS, "sequencer"];

export interface SyncRepository {
  /** Relative to the project folder with `/` separators; "." is the folder itself. */
  readonly path: string;
  readonly cwd: string;
  /** Git could not say what this folder is: it is listed, said to be unread, and left alone. */
  readonly unread?: true;
}

export const read = async (git: SyncGit, cwd: string, args: ReadonlyArray<string>) => {
  const result = await git(cwd, args, { allowFailure: true, timeoutMs: LOCAL_MS });
  return { ok: result.code === 0, text: result.stdout.trim(), stderr: result.stderr.trim() };
};

export const gitReason = (stderr: string) =>
  (
    stderr
      .split("\n")
      .map((line) => line.replace(/^(fatal|error):\s*/u, "").trim())
      .filter((line) => line.length > 0)
      .join(" ") || "Git gave no reason."
  ).slice(0, 1900);

/**
 * Whether the folder is a linked worktree (its Git directory differs from the
 * repository's common one), or null when Git did not say: it failed, or never
 * came back. Null is never taken for "it is not one".
 */
export async function isLinkedWorktree(git: SyncGit, cwd: string): Promise<boolean | null> {
  const dirs = await read(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]).catch(() => null);
  if (dirs === null || !dirs.ok) return null;
  const [gitDir, common] = dirs.text.split("\n");
  if (gitDir === undefined || common === undefined || gitDir.length === 0 || common.length === 0)
    return null;
  return gitDir !== common;
}

export async function branchAndHead(git: SyncGit, cwd: string) {
  const [symbolic, head] = await Promise.all([
    read(git, cwd, ["symbolic-ref", "-q", "--short", "HEAD"]),
    read(git, cwd, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
  ]);
  return {
    branch: symbolic.ok && symbolic.text.length > 0 ? symbolic.text : null,
    head: head.ok && SHA.test(head.text) ? head.text : null,
  };
}

/**
 * How many files keep the checkout from being clean, or null when Git could
 * not say: a status that exits with an error, and one that never comes back
 * (it ran out of time, Git could not be started).
 */
export async function uncommittedCount(git: SyncGit, cwd: string): Promise<number | null> {
  return countUncommitted(git, cwd).catch(() => null);
}

async function countUncommitted(git: SyncGit, cwd: string): Promise<number | null> {
  const status = await git(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
    { allowFailure: true, timeoutMs: LOCAL_MS },
  );
  if (status.code !== 0) return null;
  const fields = status.stdout.split("\0");
  const entries: Array<string> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    entries.push(entry);
    // A rename or a copy, in either column, is followed by the name it came from.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  const files = (await withoutCloneStaging(git, cwd, entries)).length;
  // An unfinished merge, rebase, cherry-pick, revert or bisect is not clean, also with no file changed.
  return files === 0 && (await operationUnfinished(git, cwd)) ? 1 : files;
}

/**
 * Status entries without what is only a clone's staging folder (one that
 * carries the clone step's mark): the folder itself, and an untracked folder
 * that holds nothing else. Such a folder is
 * not this repository's work, while a clone runs and after one that never
 * finished. Nothing is written to the repository's ignore files.
 */
async function withoutCloneStaging(
  git: SyncGit,
  cwd: string,
  entries: ReadonlyArray<string>,
): Promise<Array<string>> {
  const staging = cloneStagingIn(cwd);
  const untracked = (entry: string) => entry.startsWith("?? ");
  const kept: Array<string> = [];
  for (const entry of entries)
    if (!(untracked(entry) && (await staging.has(entry.slice(3))))) kept.push(entry);
  // Git names an untracked folder once, whatever it holds: its files are listed to see
  // whether a staging folder is all there is in it.
  const folders = kept
    .filter((entry) => entry.startsWith("?? ") && entry.endsWith("/"))
    .map((entry) => entry.slice(3));
  if (folders.length === 0 || folders.length > 200) return kept;
  const listed = await git(
    cwd,
    ["ls-files", "-z", "--others", "--exclude-standard", "--", ...folders],
    { allowFailure: true, timeoutMs: LOCAL_MS },
  );
  if (listed.code !== 0) return kept;
  const files = listed.stdout.split("\0").filter((file) => file.length > 0);
  const onlyStaging = new Set<string>();
  for (const folder of folders) {
    const inside = files.filter((file) => file.startsWith(folder));
    let all = inside.length > 0;
    for (const file of inside) all = all && (await staging.has(file));
    if (all) onlyStaging.add(folder);
  }
  return kept.filter((entry) => !(untracked(entry) && onlyStaging.has(entry.slice(3))));
}

async function operationUnfinished(git: SyncGit, cwd: string): Promise<boolean> {
  const gitDir = await read(git, cwd, ["rev-parse", "--absolute-git-dir"]);
  // A Git folder that cannot be found is never taken for a finished state.
  if (!gitDir.ok || gitDir.text.length === 0) return true;
  for (const mark of UNFINISHED_MARKS) {
    if ((await NodeFSP.lstat(NodePath.join(gitDir.text, mark)).catch(() => null)) !== null)
      return true;
  }
  return false;
}

export const didNotFinish = (cause: unknown) =>
  `Git did not finish: ${
    cause instanceof Error && cause.message.length > 0 ? cause.message : "no reason given"
  }`.slice(0, 1900);
