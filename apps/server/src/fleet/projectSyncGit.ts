// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/** How Sync (1390) runs and reads Git: the pieces its fetch, its move and its service share. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { UNFINISHED_OPERATION_MARKS } from "../handoff/bundleGit.ts";
import { cloneStagingIn } from "./cloneStaging.ts";
import type { GitResult } from "./folderTransfer/git.ts";
import type { FetchRecord } from "./projectSyncRecord.ts";
import type { RefTransactionFactory } from "./refTransaction.ts";

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
    /** On top of `SYNC_ENV`: a move binds every command to one Git folder and checkout. */
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
) => Promise<GitResult>;

/**
 * Settings and environment every Sync read and write runs with: neither replacement
 * objects nor a graft file are used (either could make a fetched commit look related to
 * a local one, wherever the graft file is named), and nothing is fetched behind Sync's
 * back (the runner sets `GIT_NO_LAZY_FETCH`).
 */
export const SYNC_ENV = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "/dev/null",
  // `git config` would read only the file this names, every other command the
  // repository's own settings: a check could then pass on settings the writer never reads.
  GIT_CONFIG: undefined,
} as const;

/**
 * On top of `SYNC_ENV` for every Git child of a move (its folder probes, its
 * reads, the ref transaction, the tree writer, the readback): no transport at
 * all, whatever a setting or a partial clone asks for. `GIT_ALLOW_PROTOCOL` is
 * present and empty, so Git allows no protocol (it is checked before any
 * `protocol.*.allow` setting), and `protocol.allow=never` is added through
 * Git's environment pairs after any the server inherited, which stay.
 * `inherited` is the environment the child would get otherwise.
 */
export function moveEnv(
  inherited: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const env = { ...process.env, ...inherited };
  const count = configCount(env);
  // A move declines such a count before its first Git child (`fastForwardRepository`).
  if (count === null) throw new Error("GIT_CONFIG_COUNT is not a plain count.");
  const last = count - 1;
  const added =
    count > 0 &&
    env[`GIT_CONFIG_KEY_${last}`] === "protocol.allow" &&
    env[`GIT_CONFIG_VALUE_${last}`] === "never";
  return {
    ...SYNC_ENV,
    GIT_ALLOW_PROTOCOL: "",
    // Added once: a runner of a move wrapped again adds nothing.
    ...(added
      ? {}
      : {
          GIT_CONFIG_COUNT: String(count + 1),
          [`GIT_CONFIG_KEY_${count}`]: "protocol.allow",
          [`GIT_CONFIG_VALUE_${count}`]: "never",
        }),
  };
}

/**
 * How many `GIT_CONFIG_KEY_n` entries an environment hands Git: 0 when no
 * count is set, null when the count is not plain decimal (`01`, `+1`, ` 1`).
 * Git reads some of those as a count, so the list is never rewritten around one.
 */
export function configCount(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = env.GIT_CONFIG_COUNT;
  if (raw === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) ? count : null;
}

/** A runner whose every command runs with `moveEnv`, after the caller's environment. */
export const offlineGit =
  (git: SyncGit): SyncGit =>
  (cwd, args, options) => {
    const env = { ...options?.env };
    return git(cwd, args, { ...options, env: { ...env, ...moveEnv(env) } });
  };

/** A runner whose every command opens `gitDir` with `workTree` as its checkout, and cannot fetch. */
export const boundGit =
  (git: SyncGit, gitDir: string, workTree: string): SyncGit =>
  (cwd, args, options) => {
    // The move's own settings last: no caller turns transport back on.
    const env = { ...options?.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree };
    return git(cwd, args, { ...options, env: { ...env, ...moveEnv(env) } });
  };

export interface SyncContext {
  readonly git: SyncGit;
  /**
   * The title of a running thread that works in this very checkout, null when
   * none does, or undefined when the list of running threads could not be read.
   * Asked each time it matters, never remembered: a thread may start between
   * two reads.
   */
  readonly inUse: (checkout: string) => Promise<string | null | undefined>;
  /** Stops a fetch or a clone that is under way when the call is cancelled. A merge is never stopped. */
  readonly signal?: AbortSignal;
  /**
   * The fetch a `fetch` call fills, one row per checkout, published only once
   * the call has ended. A `run` reads the row it moves by from `record`.
   */
  readonly fetched?: FetchRecord;
  /**
   * The fetch the `run` names, looked up each time it is asked: before a move,
   * and again under Git's lock right before the write. Undefined once it has
   * expired or been dropped. Without it, `fetched` is gone by.
   */
  readonly record?: () => FetchRecord | undefined;
  /** How a move opens its ref transaction; tests wrap it. */
  readonly transaction?: RefTransactionFactory;
}

/** A read Git answered with a value, one Git itself says is absent, or one that could not be read. */
export type Read<A> =
  | { readonly kind: "value"; readonly value: A }
  | { readonly kind: "absent" }
  | { readonly kind: "unread" };

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

/**
 * The lines Git printed, exactly: each line ends in Git's own newline, which is
 * the only thing removed; nothing is trimmed. Null when Git failed, its output
 * is not UTF-8, or it is not `count` non-empty lines (a path with a newline in
 * it would be one line more), so a path is never read as another one.
 */
export async function exactLines(
  git: SyncGit,
  cwd: string,
  args: ReadonlyArray<string>,
  count: number,
): Promise<Array<string> | null> {
  const result = await git(cwd, args, { allowFailure: true, timeoutMs: LOCAL_MS }).catch(
    () => null,
  );
  if (result === null || result.code !== 0 || result.invalidUtf8 === true) return null;
  if (!result.stdout.endsWith("\n")) return null;
  const lines = result.stdout.slice(0, -1).split("\n");
  return lines.length === count && lines.every((line) => line.length > 0) ? lines : null;
}

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

/**
 * The branch HEAD names, in full (`refs/heads/main`). Absent only on the one
 * answer Git gives for a detached HEAD: exit 1 with nothing printed.
 */
export async function headBranch(git: SyncGit, cwd: string): Promise<Read<string>> {
  const named = await git(cwd, ["symbolic-ref", "-q", "HEAD"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (named === null) return { kind: "unread" };
  const text = named.stdout.trim();
  if (named.code === 0 && text.startsWith("refs/heads/") && !text.includes("\n"))
    return { kind: "value", value: text };
  if (named.code === 1 && text.length === 0) return { kind: "absent" };
  return { kind: "unread" };
}

/** The commit a ref is at. Absent only when Git says it names no commit (exit 1, nothing printed). */
export async function commitOf(git: SyncGit, cwd: string, ref: string): Promise<Read<string>> {
  const found = await git(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (found === null) return { kind: "unread" };
  const text = found.stdout.trim();
  if (found.code === 0 && SHA.test(text)) return { kind: "value", value: text };
  if (found.code === 1 && text.length === 0) return { kind: "absent" };
  return { kind: "unread" };
}

export const shortBranch = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * The branch (short) and head commit for a reader, and whether either could
 * not be read. `branch` null with `unread` false is Git's own "detached".
 */
export async function branchAndHead(git: SyncGit, cwd: string) {
  const [branch, head] = await Promise.all([headBranch(git, cwd), commitOf(git, cwd, "HEAD")]);
  return {
    branch: branch.kind === "value" ? shortBranch(branch.value) : null,
    head: head.kind === "value" ? head.value : null,
    unread: branch.kind === "unread" || head.kind === "unread",
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
  if (status.code !== 0 || status.invalidUtf8 === true) return null;
  const fields = status.stdout.split("\0");
  const entries: Array<string> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    entries.push(entry);
    // A rename or a copy, in either column, is followed by the name it came from.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  const kept = await withoutCloneStaging(git, cwd, entries);
  if (kept === null) return null;
  const files = kept.length;
  // An unfinished merge, rebase, cherry-pick, revert or bisect is not clean, also with no
  // file changed; one that could not be read is no count at all.
  if (files > 0) return files;
  const unfinished = await operationUnfinished(git, cwd);
  return unfinished === null ? null : unfinished ? 1 : 0;
}

/**
 * Status entries without what is only a clone's staging folder (one that
 * carries the clone step's mark): the folder itself, and an untracked folder
 * that holds nothing else. Such a folder is
 * not this repository's work, while a clone runs and after one that never
 * finished. Nothing is written to the repository's ignore files. Null when the
 * folders could not be listed.
 */
async function withoutCloneStaging(
  git: SyncGit,
  cwd: string,
  entries: ReadonlyArray<string>,
): Promise<Array<string> | null> {
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
  if (listed.code !== 0 || listed.invalidUtf8 === true) return null;
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

/**
 * Whether a merge, rebase, cherry-pick, revert or bisect is under way, or null
 * when that could not be read: a Git folder Git does not name, or a mark the
 * file system cannot say is there or not.
 */
export async function operationUnfinished(git: SyncGit, cwd: string): Promise<boolean | null> {
  const gitDir = (await exactLines(git, cwd, ["rev-parse", "--absolute-git-dir"], 1))?.[0];
  if (gitDir === undefined) return null;
  for (const mark of UNFINISHED_MARKS) {
    const found = await present(NodePath.join(gitDir, mark));
    if (found !== false) return found;
  }
  return false;
}

/** Whether something is at `path` (a link is not followed), or null when the file system did not say. */
export async function present(path: string): Promise<boolean | null> {
  return NodeFSP.lstat(path).then(
    () => true,
    (cause: unknown) =>
      (cause as { readonly code?: unknown }).code === "ENOENT" ||
      (cause as { readonly code?: unknown }).code === "ENOTDIR"
        ? false
        : null,
  );
}

export const didNotFinish = (cause: unknown) =>
  `Git did not finish: ${
    cause instanceof Error && cause.message.length > 0 ? cause.message : "no reason given"
  }`.slice(0, 1900);
