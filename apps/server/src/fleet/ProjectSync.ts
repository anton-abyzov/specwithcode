// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync for a project that exists on two machines (1390). Each machine fetches
 * `origin` for its own repositories and fast-forwards a clean checkout that is
 * only behind; a repository it lacks is cloned. This module runs exactly these
 * Git commands that change anything: a fetch of `origin`'s branches into
 * `refs/remotes/origin/` (never the destinations the repository's settings
 * name), `merge --ff-only` and `clone`. It never resets, rebases, merges with a merge commit, stashes,
 * switches a branch, deletes, pushes or commits, and it never calls the folder
 * copy's reconcile paths, which can stash and reset.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  planProjectSyncRepository,
  projectSyncUpstreamGoneDetail,
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_FILES_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_MOVED_UNASKED_DETAIL,
  PROJECT_SYNC_NOT_LISTED_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
  PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  type ProjectId,
  ProjectSyncError,
  type ProjectSyncFetchResult,
  type ProjectSyncProjectInput,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryStatus,
  type ProjectSyncRunInput,
  type ProjectSyncRunResult,
  type ProjectSyncStatusResult,
  type ProjectSyncStepResult,
  PROJECT_SYNC_MAX_REPOSITORIES,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { UNFINISHED_OPERATION_MARKS } from "../handoff/bundleGit.ts";
import {
  CLONE_STAGING_CLONE,
  CLONE_STAGING_PREFIX,
  cloneStagingIn,
  markCloneStaging,
  namedLikeCloneStaging,
} from "./cloneStaging.ts";
import { type GitResult, runGit } from "./folderTransfer/git.ts";
import * as HandoffGit from "./handoffGit.ts";
import { canonicalOrigin, safeRelativePath } from "./handoffGitTypes.ts";
import {
  type AskBudget,
  askBudget,
  dropOrigin,
  listOrigin,
  noteOrigin,
  originHost,
  originRecord,
  type OriginRecords,
  originRecordsOf,
} from "./projectSyncOrigin.ts";

const LOCAL_MS = 30_000;
const FETCH_MS = 5 * 60_000;
const CLONE_MS = 30 * 60_000;
const PARALLEL = 4;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** How Sync runs Git. Tests pass a recording runner to assert on every command. */
export type SyncGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
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
   * What `origin` listed to this project's Sync fetches, by checkout: every
   * branch and the commit it was listed at. The plan and the move go by it,
   * and a fast-forward that cannot ask `origin` once more goes by it alone.
   */
  readonly origin?: OriginRecords;
  /** The hosts this call found silent: a host that did not answer one ask is not asked again. */
  readonly asks?: AskBudget;
}

/** What Sync fetches, and where to: `origin`'s branches into its remote-tracking refs. */
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
/**
 * The fetch names its own destinations (`--refmap=` switches the configured
 * ones off) and never prunes, whatever `fetch.prune`, `fetch.pruneTags` or
 * `remote.origin.prune` say. Tags come as Git brings them by default: new ones
 * that point into the fetched history, and none that would replace a tag here.
 */
const FETCH_ARGS = [
  "fetch",
  "--quiet",
  "--no-prune",
  "--no-prune-tags",
  "--no-recurse-submodules",
  "--refmap=",
  "origin",
  FETCH_REFSPEC,
];

/**
 * Why `origin` is not fetched, or null: it is a mirror, or one of its fetch
 * lines writes outside `refs/remotes/`. Such a repository keeps its own
 * branches where a fetch writes, so Sync leaves it alone and says so.
 */
export function unusualFetchConfig(input: {
  /** `remote.origin.mirror` as Git reads it; a value Git cannot read as true or false counts as set. */
  readonly mirror: boolean;
  readonly refspecs: ReadonlyArray<string>;
}): string | null {
  if (input.mirror) return "origin is set up as a mirror (remote.origin.mirror).";
  for (const line of input.refspecs) {
    const refspec = line.trim();
    // `^refs/…` leaves refs out and has no destination.
    if (refspec.length === 0 || refspec.startsWith("^")) continue;
    const colon = refspec.indexOf(":");
    if (colon < 0) continue;
    const destination = refspec.slice(colon + 1);
    if (destination.length > 0 && !destination.startsWith("refs/remotes/"))
      return `origin fetches into refs outside refs/remotes/ (remote.origin.fetch ${refspec}).`.slice(
        0,
        1900,
      );
  }
  return null;
}

/**
 * A folder or `file://` address, or one whose host is the machine itself
 * (`localhost`, a loopback address), names a place on one machine only.
 */
const isLocalAddress = (canonical: string) => {
  if (canonical.startsWith("file://")) return true;
  const host = normalHost(
    (canonical.split("/")[0] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""),
  );
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    // 127.0.0.0/8 and 0.0.0.0/8, which a machine reads as itself.
    /^(127|0)(\.\d{1,3}){3}$/.test(host) ||
    // `::1`, `::`, and an IPv4 loopback address written inside an IPv6 one.
    /^::(1|(ffff:)?(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)|ffff:0:0)?$/.test(host)
  );
};

/**
 * A host as the network reads it: lower case, no trailing dot, and an address
 * in its one usual spelling, so `127.1`, `2130706433`, `0x7f000001` and
 * `0177.0.0.1` all read `127.0.0.1` and `0:0:0:0:0:0:0:1` reads `::1`.
 */
function normalHost(written: string): string {
  const host = written.toLowerCase().replace(/\.+$/, "");
  try {
    return new URL(`http://${host.includes(":") ? `[${host}]` : host}/`).hostname.replace(
      /^\[|\]$|\.+$/g,
      "",
    );
  } catch {
    return host;
  }
}

/**
 * The marks of an unfinished operation, plus the one Git keeps while a
 * cherry-pick or revert of several commits is part way through with nothing
 * left to resolve: no head mark, a clean tree, and commits still to pick.
 */
const UNFINISHED_MARKS = [...UNFINISHED_OPERATION_MARKS, "sequencer"];

/** The staging folders of the clones under way in this server, by absolute path. */
const liveCloneStaging = new Set<string>();

/**
 * Removes the staging folders that clones which never finished left behind
 * (the server stopped mid-way). `paths` are relative to the project folder; of
 * each, the staging folder it names or lies in is removed, unless a clone of
 * this server is filling it. Nothing else is touched: not a folder without the
 * clone step's mark (whatever its name), not a file, nothing reached through a
 * link or outside the project.
 * Returns the folders that could not be removed.
 */
export async function sweepCloneLeftovers(
  root: string,
  paths: ReadonlyArray<string>,
): Promise<Array<string>> {
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return [];
  const staging = cloneStagingIn(realRoot);
  const seen = new Set<string>();
  const failed: Array<string> = [];
  for (const path of paths) {
    if (!safeRelativePath(path)) continue;
    // Only a folder that carries the mark this server's clone step writes: a folder a
    // person merely named this way is theirs, and stays.
    const top = await staging.top(path);
    if (top === null || seen.has(top)) continue;
    seen.add(top);
    const folder = NodePath.join(realRoot, ...top.split("/"));
    if (liveCloneStaging.has(folder)) continue;
    // Only a real folder at that very place: nothing behind a link.
    if ((await NodeFSP.realpath(folder).catch(() => null)) !== folder) continue;
    await NodeFSP.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    if ((await NodeFSP.lstat(folder).catch(() => null)) !== null) failed.push(top);
  }
  return failed;
}

/** Staging folders beside the places `clonePaths` name, relative to the project folder. */
export async function cloneStagingBeside(
  root: string,
  clonePaths: ReadonlyArray<string>,
): Promise<Array<string>> {
  const out: Array<string> = [];
  for (const path of clonePaths) {
    if (!safeRelativePath(path)) continue;
    const parent = path.split("/").slice(0, -1);
    const names = await NodeFSP.readdir(NodePath.join(root, ...parent)).catch(() => []);
    for (const name of names)
      if (name.startsWith(CLONE_STAGING_PREFIX)) out.push([...parent, name].join("/"));
  }
  return out;
}

export interface SyncRepository {
  /** Relative to the project folder with `/` separators; "." is the folder itself. */
  readonly path: string;
  readonly cwd: string;
}

const read = async (git: SyncGit, cwd: string, args: ReadonlyArray<string>) => {
  const result = await git(cwd, args, { allowFailure: true, timeoutMs: LOCAL_MS });
  return { ok: result.code === 0, text: result.stdout.trim(), stderr: result.stderr.trim() };
};

const gitReason = (stderr: string) =>
  (
    stderr
      .split("\n")
      .map((line) => line.replace(/^(fatal|error):\s*/u, "").trim())
      .filter((line) => line.length > 0)
      .join(" ") || "Git gave no reason."
  ).slice(0, 1900);

/** A linked worktree: its Git directory differs from the repository's common one. */
export async function isLinkedWorktree(git: SyncGit, cwd: string): Promise<boolean> {
  const dirs = await read(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, common] = dirs.text.split("\n");
  return dirs.ok && gitDir !== undefined && common !== undefined && gitDir !== common;
}

/**
 * The repositories Sync lists: the scan's, minus every clone staging folder
 * (and what lies in one) and every linked worktree inside the project folder. Such a folder is a thread's checkout of a repository
 * already named, so it is not listed and never moved, whether or not its
 * thread is running. The project folder itself always stays.
 */
export async function syncRepositories(
  git: SyncGit,
  root: string,
  relativePaths: ReadonlyArray<string>,
): Promise<Array<SyncRepository>> {
  const out: Array<SyncRepository> = [];
  const staging = cloneStagingIn(root);
  const listed: Array<string> = [];
  for (const path of relativePaths) if (!(await staging.has(path))) listed.push(path);
  for (const path of listed.slice(0, PROJECT_SYNC_MAX_REPOSITORIES)) {
    const cwd = path === "." ? root : NodePath.join(root, ...path.split("/"));
    if (path !== "." && (await isLinkedWorktree(git, cwd))) continue;
    out.push({ path, cwd });
  }
  return out;
}

async function branchAndHead(git: SyncGit, cwd: string) {
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
async function uncommittedCount(git: SyncGit, cwd: string): Promise<number | null> {
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

/** Path, branch, head commit, clean or not: a local Git read, no network. */
export async function readRepositoryStatus(
  git: SyncGit,
  repository: SyncRepository,
): Promise<ProjectSyncRepositoryStatus> {
  const [{ branch, head }, uncommitted] = await Promise.all([
    branchAndHead(git, repository.cwd),
    uncommittedCount(git, repository.cwd),
  ]);
  return { path: repository.path, branch, head, clean: uncommitted === 0 };
}

/**
 * A repository as the plan needs it. `fetch: true` fetches `origin` first; the
 * recheck before a fast-forward passes false and reads local Git. Either way
 * `origin`'s fetch settings are read, and a repository they make unsafe to
 * fetch is reported as `unusual-config` and never fetched.
 */
export async function readRepositoryFacts(
  context: SyncContext,
  repository: SyncRepository,
  options: { readonly fetch: boolean },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  // The address as written: another machine applies its own rewrites to it.
  const urls = await read(git, cwd, ["config", "--get-all", "remote.origin.url"]);
  const address = urls.ok ? (urls.text.split("\n")[0] ?? "").trim() : "";
  const hasOrigin = address.length > 0;
  let fetch: ProjectSyncRepositoryFacts["fetch"] = hasOrigin ? "not-run" : "no-remote";
  let fetchError: string | null = null;
  if (hasOrigin) {
    const [refspecs, mirror] = await Promise.all([
      read(git, cwd, ["config", "--get-all", "remote.origin.fetch"]),
      // As Git reads it: any true value, also a bare key. Exit 1 means it is not set.
      git(cwd, ["config", "--get-all", "--bool", "remote.origin.mirror"], {
        allowFailure: true,
        timeoutMs: LOCAL_MS,
      }),
    ]);
    const unusual = unusualFetchConfig({
      mirror:
        mirror.code === 0 ? mirror.stdout.trim().split("\n").at(-1) !== "false" : mirror.code !== 1,
      refspecs: refspecs.ok ? refspecs.text.split("\n") : [],
    });
    if (unusual !== null) {
      fetch = "unusual-config";
      fetchError = unusual;
    }
  }
  /** What origin listed to this very call. */
  let fresh: ReadonlyMap<string, string> | undefined;
  // What origin lists is asked first, once, for all its branches: the fetch that follows is
  // planned and moved by that list. An origin that does not answer the ask is not fetched,
  // so it holds the call for the ask's short limit and not for a fetch's long one.
  if (fetch === "not-run" && options.fetch) {
    const listed = await listOrigin(git, cwd, {
      host: originHost(address),
      ...(context.asks === undefined ? {} : { budget: context.asks }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (listed.ok) {
      fresh = listed.heads;
      await noteOrigin(context.origin, git, cwd, address, listed.heads);
    } else {
      fetch = "failed";
      fetchError =
        listed.reason === null ? PROJECT_SYNC_NOT_LISTED_DETAIL : gitReason(listed.reason);
    }
  }
  if (fetch === "not-run" && options.fetch) {
    const fetched = await git(cwd, FETCH_ARGS, {
      allowFailure: true,
      timeoutMs: FETCH_MS,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }).catch((cause: unknown) => ({
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "The fetch did not finish.",
    }));
    fetch = fetched.code === 0 ? "ok" : "failed";
    if (fetched.code !== 0) fetchError = gitReason(fetched.stderr);
  }
  // A fetch that did not go through leaves nothing to go by.
  if (options.fetch && fetch !== "ok") await dropOrigin(context.origin, cwd);
  // This call's own list, or what an earlier fetch of this project kept for this checkout.
  const heads =
    fetch === "ok" && fresh !== undefined
      ? fresh
      : hasOrigin && !(options.fetch && fetch !== "ok")
        ? (await originRecord(context.origin, git, cwd, address))?.heads
        : undefined;
  const { branch, head } = await branchAndHead(git, cwd);
  const upstream = branch === null ? null : await originUpstream(git, cwd);
  let ahead = 0;
  let behind = 0;
  let upstreamName: string | null = null;
  if (upstream?.commit != null && head !== null) {
    // Counted against the commit `origin`'s branch is at, by its hash.
    const counted = await read(git, cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${head}...${upstream.commit}`,
    ]);
    const [left, right] = counted.text.split(/\s+/).map(Number);
    if (counted.ok && Number.isInteger(left) && Number.isInteger(right)) {
      upstreamName = upstream.name.slice(0, 512);
      ahead = left!;
      behind = right!;
    }
  }
  // The fetch never prunes, so a branch deleted on `origin` still reads as it last did,
  // behind or level: it is gone when origin's list does not name it, so nothing is
  // planned to move to it and it is never called up to date. A tracking ref that is not
  // at the commit origin listed (the branch moved right after, or something else fetched)
  // is not what this Sync fetched, and is not moved to either.
  const listedAt =
    heads === undefined || upstream?.ref == null ? undefined : heads.get(upstream.ref);
  const gone = heads !== undefined && upstream?.ref != null && listedAt === undefined;
  const movedSince = listedAt !== undefined && listedAt !== upstream?.commit;
  const uncommitted = await uncommittedCount(git, cwd);
  return {
    path,
    branch,
    head,
    upstream: upstreamName,
    otherUpstream: upstream?.commit === null ? upstream.name.slice(0, 512) : null,
    ...(gone ? { upstreamGone: true } : {}),
    ...(movedSince ? { upstreamMoved: true } : {}),
    ahead,
    behind,
    // A status Git could not read is never treated as clean, and never given a count
    // of files nobody saw: the plan holds the checkout on `stateUnread`.
    uncommitted: uncommitted ?? 0,
    ...(uncommitted === null ? { stateUnread: true } : {}),
    // Read last, after the status read above.
    inUseBy: await context.inUse(cwd),
    remote: cloneAddress(address),
    fetch,
    fetchError,
  };
}

const ORIGIN_REFS = "refs/remotes/origin/";

/**
 * The branch's upstream, only when it is a branch of `origin`: the one remote
 * Sync fetches. `commit` is where that branch is now. An upstream that is a
 * local branch (`branch.x.remote=.`) or a branch of another remote was not
 * fetched by Sync, so it has no `commit` here and is never moved forward to;
 * its name is kept for the step's reason.
 */
async function originUpstream(
  git: SyncGit,
  cwd: string,
): Promise<{
  readonly name: string;
  readonly commit: string | null;
  /** The branch's name on `origin`, as `refs/heads/…`; null when the upstream is not origin's. */
  readonly ref: string | null;
} | null> {
  const full = await read(git, cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (!full.ok || !full.text.startsWith("refs/") || full.text.includes("\n")) return null;
  if (!full.text.startsWith(ORIGIN_REFS))
    return { name: full.text.replace(/^refs\/(heads|remotes)\//, ""), commit: null, ref: null };
  const commit = await read(git, cwd, ["rev-parse", "-q", "--verify", `${full.text}^{commit}`]);
  return commit.ok && SHA.test(commit.text)
    ? {
        name: full.text.slice("refs/remotes/".length),
        commit: commit.text,
        ref: `refs/heads/${full.text.slice(ORIGIN_REFS.length)}`,
      }
    : null;
}

/** The address when another machine can clone from it: no credential, no folder of this machine. */
function cloneAddress(address: string): string | null {
  if (address.length === 0 || address.startsWith("-")) return null;
  const canonical = canonicalOrigin(address);
  return canonical === null || isLocalAddress(canonical) ? null : address;
}

const result = (
  facts: ProjectSyncRepositoryFacts,
  otherBranch: string | null | undefined,
  change: Partial<ProjectSyncStepResult> = {},
): ProjectSyncStepResult => ({
  ...planProjectSyncRepository(facts, otherBranch === undefined ? null : { branch: otherBranch }),
  moved: 0,
  downgraded: false,
  ...change,
});

/**
 * Moves one checkout forward. The plan was a proposal: the repository is read
 * again here, immediately before the merge, and when it is no longer clean,
 * only behind, on its branch and free of running work, nothing moves and the
 * result carries the reason.
 */
export async function fastForwardRepository(
  context: SyncContext,
  repository: SyncRepository,
  otherBranch: string | null,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  if (repository.path !== "." && (await isLinkedWorktree(git, repository.cwd))) {
    const facts = await readRepositoryFacts(context, repository, { fetch: false });
    return result(facts, otherBranch, {
      action: "none",
      reason: "refused",
      detail: "A thread's worktree is never moved by Sync.",
      downgraded: true,
    });
  }
  const facts = await readRepositoryFacts(context, repository, { fetch: false });
  const planned = result(facts, otherBranch);
  const { cwd } = repository;
  // A tracking ref that left the commit this Sync fetched takes the record with it.
  if (facts.upstreamMoved === true) await dropOrigin(context.origin, cwd);
  if (planned.action !== "fast-forward") return { ...planned, downgraded: true };
  // The commit `origin`'s branch is at, by its hash: never whatever `@{upstream}` names.
  const upstream = await originUpstream(git, cwd);
  const target = upstream?.commit ?? null;
  if (upstream == null || target === null || upstream.ref === null) {
    return { ...planned, action: "fetch", reason: "no-upstream", downgraded: true };
  }
  const ref = upstream.ref;
  const refuse = (detail: string): ProjectSyncStepResult => ({
    ...planned,
    action: "none",
    reason: "refused",
    detail,
    downgraded: true,
  });
  // origin is asked once more where the branch is, by its commit: only that very commit
  // is moved to. A branch deleted there since the fetch keeps its tracking ref here, and
  // one force-pushed keeps its name; neither is what this Sync was asked to bring in.
  const urls = await read(git, cwd, ["config", "--get-all", "remote.origin.url"]);
  const address = urls.ok ? (urls.text.split("\n")[0] ?? "").trim() : "";
  const asked = await listOrigin(git, cwd, {
    ref,
    host: originHost(address),
    ...(context.asks === undefined ? {} : { budget: context.asks }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (asked.ok) {
    const now = asked.heads.get(ref);
    if (now !== target) {
      // Learned for certain: what was kept of the fetch is not gone by again, also not
      // by a later try with no connection.
      await dropOrigin(context.origin, cwd);
      return now === undefined
        ? {
            ...planned,
            action: "none",
            reason: "no-upstream",
            detail: projectSyncUpstreamGoneDetail(upstream.name),
            downgraded: true,
          }
        : refuse(PROJECT_SYNC_ORIGIN_MOVED_DETAIL);
    }
  } else {
    // origin could not be asked (no connection): the move still goes to the commit origin
    // listed for this very branch to this project's own Sync fetch of this very checkout
    // and origin, and to nothing else. Without such a record nothing moves; it is kept.
    const record =
      address.length > 0 ? await originRecord(context.origin, git, cwd, address) : undefined;
    if (record?.heads.get(ref) !== target) return refuse(PROJECT_SYNC_REFUSED_UNASKED_DETAIL);
  }
  const unasked = !asked.ok;
  // Asked once more, with nothing but the merge left to run: a thread that started
  // working here during the reads above keeps the checkout as it is.
  const startedHere = await context.inUse(cwd);
  if (startedHere !== null) {
    return {
      ...planned,
      action: "fetch",
      reason: "in-use",
      inUseBy: startedHere,
      downgraded: true,
    };
  }
  // The checkout as it is now, after the wait for origin: on the planned branch, at the
  // planned commit, following the same branch of origin at the same commit, and clean.
  // Anything else and it is left as it is, with what changed.
  const [now, upstreamNow, uncommittedNow] = await Promise.all([
    branchAndHead(git, cwd),
    originUpstream(git, cwd),
    uncommittedCount(git, cwd),
  ]);
  if (now.branch !== facts.branch) return refuse(PROJECT_SYNC_CHANGED_BRANCH_DETAIL);
  if (now.head !== facts.head) return refuse(PROJECT_SYNC_CHANGED_HEAD_DETAIL);
  if (upstreamNow?.ref !== ref || upstreamNow.commit !== target)
    return refuse(PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL);
  if (uncommittedNow !== 0)
    return {
      ...planned,
      action: "fetch",
      reason: "uncommitted",
      uncommitted: uncommittedNow ?? 0,
      detail:
        uncommittedNow === null
          ? PROJECT_SYNC_STATE_UNREAD_DETAIL
          : PROJECT_SYNC_CHANGED_FILES_DETAIL,
      downgraded: true,
    };
  const merged = await git(
    cwd,
    // Ignored files in the way stop the merge instead of being written over, and nothing
    // is stashed for it, whatever `merge.autoStash` says.
    [
      "merge",
      "--ff-only",
      "--no-edit",
      "--no-autostash",
      "--no-overwrite-ignore",
      "--quiet",
      target,
    ],
    { allowFailure: true, timeoutMs: FETCH_MS },
  ).catch((cause: unknown) => ({
    code: -1,
    stdout: "",
    stderr: `Git did not finish: ${cause instanceof Error ? cause.message : "no reason given"}`,
  }));
  // What happened is read from the checkout, not taken from how the command ended: a
  // merge that went through is reported as one also when a read after it failed, and
  // "refused" is said only once the checkout was read and nothing had moved.
  let after = await branchAndHead(git, cwd).catch(() => null);
  if (after === null || after.head === null)
    after = await branchAndHead(git, cwd).catch(() => null);
  if (after !== null && after.head === target && after.branch === facts.branch)
    return {
      ...planned,
      moved: facts.behind,
      ...(unasked ? { detail: PROJECT_SYNC_MOVED_UNASKED_DETAIL } : {}),
    };
  if (after !== null && after.head === facts.head && after.branch === facts.branch)
    return {
      ...planned,
      action: "fetch",
      reason: "refused",
      detail: gitReason(merged.stderr),
      downgraded: true,
    };
  return { ...planned, detail: PROJECT_SYNC_UNVERIFIED_DETAIL, downgraded: true };
}

/**
 * Clones a repository this machine lacks into its place in the project folder.
 * The folder must not exist. The clone is made in a new folder beside it and
 * moved in when it is whole, so nothing at the target is ever written over or
 * deleted, also not what appears there while the clone runs. A remote that carries a credential, names a transport
 * other than https, ssh or git, or is a folder or `file://` address (a place
 * on one machine only) is refused. A clone that fails or is cancelled leaves
 * no folder behind.
 */
export async function cloneRepository(
  context: SyncContext,
  root: string,
  input: { readonly path: string; readonly remote: string },
): Promise<ProjectSyncStepResult> {
  const step = (change: Partial<ProjectSyncStepResult>): ProjectSyncStepResult => ({
    path: input.path,
    action: "clone",
    reason: "missing",
    branch: null,
    otherBranch: null,
    ahead: 0,
    behind: 0,
    uncommitted: 0,
    inUseBy: null,
    remote: input.remote,
    detail: null,
    moved: 0,
    downgraded: false,
    ...change,
  });
  const refuse = (detail: string) =>
    step({ action: "none", reason: "refused", detail, downgraded: true });
  if (
    input.path === "." ||
    !safeRelativePath(input.path) ||
    input.path.split("/").some(isGitFolderName)
  )
    return refuse("The repository's folder is not a path inside the project.");
  if (cloneAddress(input.remote) === null)
    return refuse("The remote is not an address Sync clones from.");
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return refuse("The project folder is missing.");
  const target = NodePath.join(realRoot, ...input.path.split("/"));
  if ((await NodeFSP.lstat(target).catch(() => null)) !== null)
    return refuse('A folder is already there. Use "Compare all files…".');
  /** The folders this call made on the way, innermost last: removed again when nothing is cloned. */
  const made: Array<string> = [];
  let staging = "";
  let published = false;
  const undo = async () => {
    for (const folder of made.toReversed()) await NodeFSP.rmdir(folder).catch(() => undefined);
  };
  try {
    // One folder at a time, creating nothing past a link: a link on the way would
    // put the clone, or an empty folder, outside the project folder.
    let folder = realRoot;
    for (const part of input.path.split("/").slice(0, -1)) {
      folder = NodePath.join(folder, part);
      let entry = await NodeFSP.lstat(folder).catch(() => null);
      if (entry === null) {
        await NodeFSP.mkdir(folder);
        made.push(folder);
        entry = await NodeFSP.lstat(folder);
      }
      if (!entry.isDirectory()) {
        await undo();
        return refuse("The folder's path leaves the project folder.");
      }
    }
    // The clone is made beside its place, in a folder only this call knows, and moved
    // in when it is whole: nothing a person puts at the target meanwhile is ever touched.
    staging = await NodeFSP.mkdtemp(
      NodePath.join(
        NodePath.dirname(target),
        `${CLONE_STAGING_PREFIX}${NodePath.basename(target)}-`,
      ),
    );
    // Known as this server's live clone before its mark says it is a staging folder: a
    // sweep for another project that reads the mark from here on leaves it alone.
    liveCloneStaging.add(staging);
    // Marked before anything else goes in: the mark is what makes the folder Sync's.
    await markCloneStaging(staging);
    await NodeFSP.mkdir(NodePath.join(staging, CLONE_STAGING_CLONE));
    return await fill();
  } catch (cause) {
    // Past the point where the clone is in its place, nothing is undone or called refused.
    if (published) throw cause;
    // A folder that got no further than its name holds nothing and goes again.
    if (staging.length > 0)
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await undo();
    return refuse("The folder could not be created.");
  } finally {
    if (staging.length > 0) liveCloneStaging.delete(staging);
  }
  async function fill(): Promise<ProjectSyncStepResult> {
    const clone = NodePath.join(staging, CLONE_STAGING_CLONE);
    const discard = async () => {
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await undo();
    };
    const cloned = await context
      // The remote is always named origin, whatever `clone.defaultRemoteName` says.
      .git(
        clone,
        [
          "clone",
          "--quiet",
          "--origin",
          "origin",
          "--no-recurse-submodules",
          "--",
          input.remote,
          ".",
        ],
        {
          allowFailure: true,
          timeoutMs: CLONE_MS,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      )
      .catch((cause: unknown) => ({
        code: -1,
        stdout: "",
        stderr: cause instanceof Error ? cause.message : "The clone did not finish.",
      }));
    if (cloned.code !== 0) {
      await discard();
      return refuse(
        context.signal?.aborted === true ? "The clone was cancelled." : gitReason(cloned.stderr),
      );
    }
    // Moved in only where nothing is. The target is made here first, exclusively: a folder
    // or file that appeared there, also an empty folder, makes that fail and stays. The
    // clone then takes the place of the empty folder this call just made. What is left
    // open: someone removing that folder and making an empty one of their own between
    // these two steps; an empty folder is all that could be replaced.
    const rename = () =>
      NodeFSP.rename(clone, target).then(
        () => true,
        () => false,
      );
    const moved = await NodeFSP.mkdir(target).then(
      async () =>
        (await rename()) ||
        // Where a rename never takes the place of a folder (Windows), the empty folder
        // goes first. A folder that gained a file meanwhile cannot be removed, and stays.
        ((await NodeFSP.rmdir(target).then(
          () => true,
          () => false,
        )) &&
          (await rename())),
      () => false,
    );
    if (!moved) {
      await discard();
      return refuse('A folder is already there. Use "Compare all files…".');
    }
    published = true;
    // The clone is in its place: what is left of the staging folder is its mark. From
    // here on the step is a clone that was made, whatever else fails: its branch is read
    // for the result when Git answers, and nothing kept of an earlier folder at this
    // path is gone by.
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await dropOrigin(context.origin, target).catch(() => undefined);
    const branch = await branchAndHead(context.git, target).then(
      (read) => read.branch,
      () => null,
    );
    return step({ branch });
  }
}

/**
 * A folder name a file system may read as `.git`: another case, a trailing dot
 * or space, a character it ignores, or a short name. A clone into such a folder
 * would put a remote's files where Git reads its own settings.
 */
export function isGitFolderName(name: string): boolean {
  const plain = name
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g, "")
    .replace(/[. ]+$/, "")
    .toLowerCase();
  return plain === ".git" || /^git~\d+$/.test(plain);
}

/**
 * Whether a thread working in `threadFolder` works in `checkout`: it runs in
 * that folder, in a folder above it (a thread in the project folder reaches
 * every nested repository), or in a subfolder that belongs to that checkout.
 * A thread in its own worktree works in another checkout, so it never blocks
 * the repository its worktree was cut from.
 */
export function threadUsesCheckout(input: {
  readonly threadFolder: string;
  /** `git rev-parse --show-toplevel` of the thread's folder; null when Git could not read it. */
  readonly threadCheckout: string | null;
  readonly checkout: string;
}): boolean {
  const { threadFolder, checkout } = input;
  if (threadFolder === checkout) return true;
  if (checkout.startsWith(`${threadFolder}${NodePath.sep}`)) return true;
  // A subfolder whose checkout could not be read is taken for part of this one: nothing
  // moves on a guess.
  return (
    threadFolder.startsWith(`${checkout}${NodePath.sep}`) &&
    (input.threadCheckout === checkout || input.threadCheckout === null)
  );
}

/**
 * Runs `run` over the items, four at a time. When one fails no further item is
 * started, and the call ends only once every one that was started has ended:
 * whoever holds the project's lock never lets go of it while Git still runs.
 */
export async function inParallel<A, B>(items: ReadonlyArray<A>, run: (item: A) => Promise<B>) {
  const out: Array<B> = Array.from({ length: items.length });
  let next = 0;
  let failed = false;
  const ended = await Promise.allSettled(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length && !failed) {
        const index = next++;
        try {
          out[index] = await run(items[index]!);
        } catch (cause) {
          failed = true;
          throw cause;
        }
      }
    }),
  );
  for (const worker of ended) if (worker.status === "rejected") throw worker.reason;
  return out;
}

export async function statusOf(
  git: SyncGit,
  repositories: ReadonlyArray<SyncRepository>,
): Promise<Array<ProjectSyncRepositoryStatus>> {
  return inParallel(repositories, (repository) => readRepositoryStatus(git, repository));
}

/** Fetches `origin` in every repository. One that fails is reported; the others continue. */
export async function fetchAll(
  context: SyncContext,
  repositories: ReadonlyArray<SyncRepository>,
): Promise<Array<ProjectSyncRepositoryFacts>> {
  // A failure on one repository is that repository's facts: the others keep theirs.
  return inParallel(repositories, (repository) =>
    readRepositoryFacts(context, repository, { fetch: true }).catch(
      async (cause: unknown): Promise<ProjectSyncRepositoryFacts> => {
        await dropOrigin(context.origin, repository.cwd).catch(() => undefined);
        return {
          path: repository.path,
          branch: null,
          head: null,
          upstream: null,
          otherUpstream: null,
          ahead: 0,
          behind: 0,
          uncommitted: 0,
          stateUnread: true,
          inUseBy: null,
          remote: null,
          fetch: "failed",
          fetchError: didNotFinish(cause),
        };
      },
    ),
  );
}

/** Fast-forwards and clones, one repository at a time, each rechecked as it is reached. */
export async function runSync(
  context: SyncContext,
  root: string,
  repositories: ReadonlyArray<SyncRepository>,
  input: Pick<ProjectSyncRunInput, "fastForward" | "clone">,
): Promise<Array<ProjectSyncStepResult>> {
  const known = new Map(repositories.map((repository) => [repository.path, repository]));
  const out: Array<ProjectSyncStepResult> = [];
  for (const wanted of input.fastForward) {
    const repository = known.get(wanted.path);
    if (repository === undefined) {
      out.push({
        path: wanted.path,
        action: "none",
        reason: "refused",
        branch: null,
        otherBranch: wanted.otherBranch,
        ahead: 0,
        behind: 0,
        uncommitted: 0,
        inUseBy: null,
        remote: null,
        detail: "Sync does not list this folder as a repository of the project.",
        moved: 0,
        downgraded: true,
      });
      continue;
    }
    // A failure on one repository is that repository's result: the others keep theirs.
    out.push(
      await fastForwardRepository(context, repository, wanted.otherBranch).catch((cause) =>
        failedStep(cause, { path: wanted.path, otherBranch: wanted.otherBranch, remote: null }),
      ),
    );
  }
  for (const wanted of input.clone)
    out.push(
      await cloneRepository(context, root, wanted).catch((cause) =>
        failedStep(cause, { path: wanted.path, otherBranch: null, remote: wanted.remote }),
      ),
    );
  return out;
}

const didNotFinish = (cause: unknown) =>
  `Git did not finish: ${
    cause instanceof Error && cause.message.length > 0 ? cause.message : "no reason given"
  }`.slice(0, 1900);

/** The result of a repository whose step did not end: nothing is claimed about it but that. */
const failedStep = (
  cause: unknown,
  at: {
    readonly path: string;
    readonly otherBranch: string | null;
    readonly remote: string | null;
  },
): ProjectSyncStepResult => ({
  path: at.path,
  action: "none",
  reason: "refused",
  branch: null,
  otherBranch: at.otherBranch,
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: at.remote,
  detail: didNotFinish(cause),
  moved: 0,
  downgraded: true,
});

const defaultGit: SyncGit = (cwd, args, options) => runGit(cwd, args, options);

export class ProjectSync extends Context.Service<
  ProjectSync,
  {
    /** The project's folder and the repositories Sync lists in it. */
    readonly repositories: (projectId: ProjectId) => Effect.Effect<
      {
        readonly root: string;
        readonly repositories: ReadonlyArray<SyncRepository>;
        /** Paths the scan found under a folder named like a clone's staging folder; the sweep checks its mark. */
        readonly cloneStaging: ReadonlyArray<string>;
        readonly scanLimited: boolean;
      },
      ProjectSyncError
    >;
    readonly status: (
      input: ProjectSyncProjectInput,
    ) => Effect.Effect<ProjectSyncStatusResult, ProjectSyncError>;
    readonly fetch: (
      input: ProjectSyncProjectInput,
    ) => Effect.Effect<ProjectSyncFetchResult, ProjectSyncError>;
    readonly run: (
      input: ProjectSyncRunInput,
    ) => Effect.Effect<ProjectSyncRunResult, ProjectSyncError>;
  }
>()("specweave-studio/fleet/ProjectSync") {}

const failed = (reason: string, code: ProjectSyncError["code"] = "failed") =>
  new ProjectSyncError({ code, reason });

const gitFailure = (cause: unknown) =>
  failed(cause instanceof Error ? cause.message.slice(0, 1900) : "Git did not finish.");

/**
 * Git work that is never cut short: a cancelled call waits for it, so the
 * project's lock is not released while Git still writes. Each Git command
 * ends by itself, under its own time limit.
 */
export const untilGitEnds = <A>(run: () => Promise<A>): Effect.Effect<A, ProjectSyncError> =>
  Effect.tryPromise({ try: run, catch: gitFailure }).pipe(Effect.uninterruptible);

/**
 * Git work a cancelled call stops (a fetch, a clone): the signal is aborted,
 * and the call still waits until `run` has ended, so whoever holds the
 * project's lock keeps it until Git is gone and `run` has cleaned up.
 */
export const stoppedWhenCancelled = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProjectSyncError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const settled = run(controller.signal).then(
        (value) => ({ ok: true as const, value }),
        (cause: unknown) => ({ ok: false as const, cause }),
      );
      return { controller, settled };
    }),
    ({ settled }) =>
      Effect.promise(() => settled).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(gitFailure(outcome.cause)),
        ),
      ),
    ({ controller, settled }) =>
      Effect.promise(() => {
        // After `run` has ended this changes nothing; before, it stops Git and waits for it.
        controller.abort();
        return settled;
      }),
  );

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const handoffGit = yield* HandoffGit.HandoffGit;
  const sql = yield* SqlClient.SqlClient;

  const attempt = untilGitEnds;

  const repositories = Effect.fn("ProjectSync.repositories")(function* (projectId: ProjectId) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(() => failed("Could not read this machine's projects.")),
    );
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined)
      return yield* failed("This machine does not have that project.", "not_found");
    if (isPersonalAssistantProject(project))
      return yield* failed("A personal project is not synced between machines.", "personal");
    const root = yield* attempt(() => NodeFSP.realpath(project.workspaceRoot));
    // A tree the scan cannot finish (past its limits, a link to a folder, a nested folder
    // whose Git data is broken) lists its root alone, marked as such: today's fallback of a
    // Git sync move. The root itself must be a repository.
    const scanned = yield* handoffGit.discover({ workspaceRoot: root }).pipe(
      Effect.map((paths) => ({ paths, scanLimited: false })),
      Effect.catchTags({
        HandoffGitError: () =>
          attempt(async () => {
            const top = await read(defaultGit, root, ["rev-parse", "--show-toplevel"]);
            const real = top.ok ? await NodeFSP.realpath(top.text).catch(() => null) : null;
            return real === root;
          }).pipe(
            Effect.flatMap((isRepository) =>
              isRepository
                ? Effect.succeed({ paths: ["."] as ReadonlyArray<string>, scanLimited: true })
                : Effect.fail(failed("The project folder is not a Git repository.", "invalid")),
            ),
          ),
      }),
    );
    return {
      root,
      repositories: yield* attempt(() => syncRepositories(defaultGit, root, scanned.paths)),
      cloneStaging: scanned.paths.filter((path) => path.split("/").some(namedLikeCloneStaging)),
      scanLimited: scanned.scanLimited,
    };
  });

  /** Threads with a run or a provider session going, and the folder each works in. */
  const runningThreads = sql<{
    title: string | null;
    workspaceRoot: string;
    worktreePath: string | null;
  }>`
    SELECT t.title AS "title", p.workspace_root AS "workspaceRoot",
      json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
    FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
    WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id AND r.status NOT IN ('completed','interrupted','failed','cancelled','rolled_back'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions s WHERE s.thread_id=t.thread_id AND s.status IN ('running','working','connecting','starting'))
    ORDER BY t.updated_at DESC, t.thread_id
  `;

  /**
   * Which running thread works in a checkout, read from the database each time
   * it is asked: before a plan, and again immediately before a merge. A list
   * that cannot be read counts as in use, so nothing moves on a guess.
   */
  const inUse: SyncContext["inUse"] = async (checkout) => {
    const rows = await Effect.runPromise(runningThreads).catch(() => null);
    if (rows === null) return "a thread (the list of running threads could not be read)";
    for (const row of rows) {
      const folder = row.worktreePath ?? row.workspaceRoot;
      const real = await NodeFSP.realpath(folder).catch(() => NodePath.resolve(folder));
      // A thread in a folder outside the checkout and not above it cannot work in it.
      if (
        real !== checkout &&
        !checkout.startsWith(`${real}${NodePath.sep}`) &&
        !real.startsWith(`${checkout}${NodePath.sep}`)
      )
        continue;
      const top = await read(defaultGit, real, ["rev-parse", "--show-toplevel"]).catch(() => null);
      const threadCheckout =
        top?.ok === true
          ? await NodeFSP.realpath(top.text).catch(() => NodePath.resolve(top.text))
          : null;
      if (threadUsesCheckout({ threadFolder: real, threadCheckout, checkout }))
        return row.title ?? "a thread";
    }
    return null;
  };
  /** A call's context: its project's own records of origin, and its time for asking origin. */
  const syncContext = (
    projectId: ProjectId,
    asks: AskBudget,
    signal?: AbortSignal,
  ): SyncContext => ({
    git: defaultGit,
    inUse,
    origin: originRecordsOf(projectId),
    asks,
    ...(signal === undefined ? {} : { signal }),
  });

  return ProjectSync.of({
    repositories,
    status: Effect.fn("ProjectSync.status")(function* (input) {
      const found = yield* repositories(input.projectId);
      return {
        repositories: yield* attempt(() => statusOf(defaultGit, found.repositories)),
        scanLimited: found.scanLimited,
      };
    }),
    fetch: (input) =>
      admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          const found = yield* repositories(input.projectId);
          const asks = askBudget();
          return {
            // A cancelled fetch is stopped; the lock is held until Git has ended.
            repositories: yield* stoppedWhenCancelled((signal) =>
              fetchAll(syncContext(input.projectId, asks, signal), found.repositories),
            ),
            scanLimited: found.scanLimited,
          };
        }),
      ),
    run: (input) =>
      admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          const found = yield* repositories(input.projectId);
          const out: Array<ProjectSyncStepResult> = [];
          const asks = askBudget();
          // What a clone that never finished left behind goes first, under the lock: no
          // clone of this project is under way now. A folder that stays is said so.
          const kept = yield* attempt(async () =>
            sweepCloneLeftovers(found.root, [
              ...found.cloneStaging,
              ...(await cloneStagingBeside(
                found.root,
                input.clone.map((wanted) => wanted.path),
              )),
            ]),
          ).pipe(Effect.uninterruptible);
          for (const path of kept)
            out.push({
              path: path.slice(0, 1024),
              action: "none",
              reason: "refused",
              branch: null,
              otherBranch: null,
              ahead: 0,
              behind: 0,
              uncommitted: 0,
              inUseBy: null,
              remote: null,
              detail:
                "A clone that was stopped left this folder behind, and it could not be removed.",
              moved: 0,
              downgraded: false,
            });
          // A merge is never cut short. A cancelled call ends between two repositories.
          for (const wanted of input.fastForward) {
            out.push(
              ...(yield* attempt(() =>
                runSync(syncContext(input.projectId, asks), found.root, found.repositories, {
                  fastForward: [wanted],
                  clone: [],
                }),
              )),
            );
          }
          // A cancelled clone is stopped and its folder removed before the lock is released.
          for (const wanted of input.clone) {
            out.push(
              ...(yield* stoppedWhenCancelled((signal) =>
                runSync(
                  syncContext(input.projectId, asks, signal),
                  found.root,
                  found.repositories,
                  {
                    fastForward: [],
                    clone: [wanted],
                  },
                ),
              )),
            );
          }
          return { repositories: out };
        }),
      ),
  });
});

export const layer = Layer.effect(ProjectSync, make).pipe(
  Layer.provide(ProjectAdmission.layer),
  Layer.provide(HandoffGit.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
