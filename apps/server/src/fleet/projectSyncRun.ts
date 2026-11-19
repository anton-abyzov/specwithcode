// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Moving one checkout forward (1390). The move is to the exact commit the
 * fetch the call names brought for the branch's upstream on `origin`: never to
 * a ref by its name, and never by anything but that fetch. Before the write
 * the checkout is read again, slow reads first and its identity last; the
 * merge is told to do one thing only; and what is said after is what the
 * checkout shows, never how the command ended.
 */
import * as NodeFSP from "node:fs/promises";

import {
  planProjectSyncRepository,
  projectSyncMergeOptionsDetail,
  projectSyncObservedDetail,
  projectSyncUpstreamGoneDetail,
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_FILES_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_FETCH_STALE_DETAIL,
  PROJECT_SYNC_MOVED_UNASKED_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
  PROJECT_SYNC_NOT_TRIED_DETAIL,
  PROJECT_SYNC_OFFLINE_UNSURE_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncStepResult,
} from "@specweave-studio/contracts";

import { withCheckout } from "./checkoutLock.ts";
import { commitAt, readRepositoryFacts, unreadFacts } from "./projectSyncFacts.ts";
import {
  branchAndHead,
  FETCH_MS,
  gitReason,
  isLinkedWorktree,
  LOCAL_MS,
  type SyncContext,
  type SyncGit,
  type SyncRepository,
  uncommittedCount,
} from "./projectSyncGit.ts";
import {
  askOrigin,
  checkoutIdentity,
  fetchAddress,
  revoke,
  revokeElsewhere,
  upstreamOf,
} from "./projectSyncOrigin.ts";

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
 * The merge does one thing: it moves the branch forward, or it does nothing.
 * Every option a repository's settings can turn on for a merge and a flag can
 * turn off is turned off here, after `--ff-only`. Hooks never run (the runner
 * switches them off).
 */
export const MERGE_ARGS = [
  "merge",
  "--ff-only",
  "--no-squash",
  "--commit",
  "--no-edit",
  "--no-autostash",
  "--no-verify",
  "--no-verify-signatures",
  "--no-signoff",
  "--no-log",
  "--no-stat",
  "--no-progress",
  "--no-overwrite-ignore",
];

/**
 * The words of `branch.<name>.mergeOptions` a flag in `MERGE_ARGS` overrides.
 * Anything else (a strategy, its options, `--quiet`, a quoted word) cannot be
 * switched off from the command line, and with it the branch is not moved:
 * `-s ours` there makes a merge commit in spite of `--ff-only`.
 */
const OVERRIDDEN =
  /^--(no-)?(ff|squash|commit|edit|autostash|verify|verify-signatures|signoff|log|stat|summary|progress|overwrite-ignore)$|^--ff-only$|^--log=\d+$|^-n$|^-e$/;

/** Whether the branch's merge options are all ones the merge's own flags override. */
export async function mergeOptionsSafe(
  git: SyncGit,
  cwd: string,
  branch: string,
): Promise<boolean> {
  const set = await git(cwd, ["config", "--get-all", `branch.${branch}.mergeoptions`], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  });
  // Exit 1: not set. Any other failure is not taken for "not set".
  if (set.code === 1) return true;
  if (set.code !== 0) return false;
  return set.stdout
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => OVERRIDDEN.test(word));
}

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
  const { cwd } = repository;
  const linked = repository.path === "." ? false : await isLinkedWorktree(git, cwd);
  if (repository.unread === true || linked === null)
    return result(unreadFacts(repository.path, PROJECT_SYNC_PATH_UNREAD_DETAIL), otherBranch, {
      downgraded: true,
    });
  if (linked) {
    const facts = await readRepositoryFacts(context, repository, { fetch: false });
    return result(facts, otherBranch, {
      action: "none",
      reason: "refused",
      detail: "A thread's worktree is never moved by Sync.",
      downgraded: true,
    });
  }
  const realPath = await NodeFSP.realpath(cwd).catch(() => cwd);
  // One writer of the app at a time in a checkout, whatever project asks.
  return withCheckout(realPath, () => moveForward(context, repository, otherBranch, realPath));
}

async function moveForward(
  context: SyncContext,
  repository: SyncRepository,
  otherBranch: string | null,
  realPath: string,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  const { cwd } = repository;
  const record = context.fetched?.repositories.get(realPath);
  const facts = await readRepositoryFacts(context, repository, { fetch: false });
  const planned = result(facts, otherBranch);
  const refuse = (detail: string): ProjectSyncStepResult => ({
    ...planned,
    action: "none",
    reason: "refused",
    detail,
    downgraded: true,
  });
  // No fetch named, one the server no longer keeps, or one that did not fetch this
  // checkout: nothing stands in for it, also not what origin lists right now.
  if (record === undefined)
    return planned.action === "fast-forward"
      ? refuse(PROJECT_SYNC_NO_FETCH_DETAIL)
      : { ...planned, downgraded: true };
  /** Whether the checkout and the place origin leads to are still those of the fetch. */
  const sameAsFetched = async () => {
    const [identity, fetchUrl] = await Promise.all([
      checkoutIdentity(git, cwd),
      fetchAddress(git, cwd),
    ]);
    return identity?.identity === record.identity && fetchUrl === record.fetchUrl;
  };
  if (!(await sameAsFetched())) {
    context.fetched?.repositories.delete(realPath);
    return refuse(PROJECT_SYNC_FETCH_STALE_DETAIL);
  }
  const { branch } = facts;
  const upstream = branch === null ? null : ((await upstreamOf(git, cwd, branch)) ?? null);
  // Learned since the fetch, by this server: origin has the branch elsewhere now.
  if (upstream?.kind === "origin" && record.revoked.get(upstream.ref) === "moved")
    return refuse(PROJECT_SYNC_ORIGIN_MOVED_DETAIL);
  if (planned.action !== "fast-forward") return { ...planned, downgraded: true };
  // The commit this fetch brought for the branch origin itself names as the upstream.
  const target = upstream?.kind === "origin" ? record.heads.get(upstream.ref) : undefined;
  if (branch === null || upstream?.kind !== "origin" || target === undefined)
    return { ...planned, action: "fetch", reason: "no-upstream", downgraded: true };
  const { ref } = upstream;
  if (!(await mergeOptionsSafe(git, cwd, branch)))
    return refuse(projectSyncMergeOptionsDetail(branch));
  /** What was learned of origin's branch holds for every fetch of this checkout. */
  const learned = (now: string | undefined) => {
    revoke(record, ref, now);
    revokeElsewhere(realPath, ref, now);
  };
  // origin is asked once more where the branch is, by its commit. A branch deleted there
  // since the fetch keeps its tracking ref here, and one force-pushed keeps its name;
  // neither is what the person approved.
  const asked = await askOrigin(git, cwd, ref, {
    ...(context.asks === undefined ? {} : { budget: context.asks }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  // Not asked is not "out of reach": it is not moved, and the fetch stays good.
  if (asked.kind === "not-tried") return refuse(PROJECT_SYNC_NOT_TRIED_DETAIL);
  if (asked.kind === "answered" && asked.tip !== target) {
    learned(asked.tip);
    return asked.tip === undefined
      ? {
          ...planned,
          action: "none",
          reason: "no-upstream",
          detail: projectSyncUpstreamGoneDetail(upstream.name),
          downgraded: true,
        }
      : refuse(PROJECT_SYNC_ORIGIN_MOVED_DETAIL);
  }
  const unasked = asked.kind === "unreachable";
  // origin could not be asked: the fetch alone decides, and only for a checkout that is
  // surely the one it fetched.
  if (unasked && !record.sure) return refuse(PROJECT_SYNC_OFFLINE_UNSURE_DETAIL);
  // The slow read first: what follows it is quick, and is the last thing before the write.
  const uncommitted = await uncommittedCount(git, cwd);
  if (uncommitted !== 0)
    return {
      ...planned,
      action: "fetch",
      reason: "uncommitted",
      uncommitted: uncommitted ?? 0,
      detail:
        uncommitted === null ? PROJECT_SYNC_STATE_UNREAD_DETAIL : PROJECT_SYNC_CHANGED_FILES_DETAIL,
      downgraded: true,
    };
  // The checkout as it is now, after the waits: the one that was fetched, on the planned
  // branch at the planned commit, following the same branch of origin, its tracking ref
  // where the fetch left it, its merge options harmless. Anything else and it stays.
  if (!(await sameAsFetched())) {
    context.fetched?.repositories.delete(realPath);
    return refuse(PROJECT_SYNC_FETCH_STALE_DETAIL);
  }
  const now = await branchAndHead(git, cwd);
  if (now.branch !== branch) return refuse(PROJECT_SYNC_CHANGED_BRANCH_DETAIL);
  if (now.head !== facts.head) return refuse(PROJECT_SYNC_CHANGED_HEAD_DETAIL);
  const upstreamNow = await upstreamOf(git, cwd, branch);
  if (upstreamNow?.kind !== "origin" || upstreamNow.ref !== ref)
    return refuse(PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL);
  if ((await commitAt(git, cwd, upstream.tracking)) !== target) {
    record.revoked.set(ref, "moved");
    return refuse(PROJECT_SYNC_NOT_AS_FETCHED_DETAIL);
  }
  if (!(await mergeOptionsSafe(git, cwd, branch)))
    return refuse(projectSyncMergeOptionsDetail(branch));
  // Asked last, with nothing but the merge left to run: a thread that started working
  // here during the reads above keeps the checkout as it is.
  const startedHere = await context.inUse(cwd);
  if (startedHere !== null)
    return {
      ...planned,
      action: "fetch",
      reason: "in-use",
      inUseBy: startedHere,
      downgraded: true,
    };
  const merged = await git(cwd, [...MERGE_ARGS, target], {
    allowFailure: true,
    timeoutMs: FETCH_MS,
  }).catch((cause: unknown) => ({
    code: -1,
    stdout: "",
    stderr: `Git did not finish: ${cause instanceof Error ? cause.message : "no reason given"}`,
  }));
  // What happened is read from the checkout. A move is Sync's own only when Git itself
  // said it moved from the planned commit to the fetched one, and the checkout is then on
  // the planned branch at that commit. "Refused" is said only when the checkout was read
  // and is as it was, files included. Anything else is said as it was found.
  let after = await branchAndHead(git, cwd).catch(() => null);
  if (after === null || after.head === null)
    after = await branchAndHead(git, cwd).catch(() => null);
  if (after === null || after.head === null)
    return { ...planned, detail: PROJECT_SYNC_UNVERIFIED_DETAIL, downgraded: true };
  if (
    after.branch === branch &&
    after.head === target &&
    merged.code === 0 &&
    saysMoved(merged.stdout, facts.head, target)
  )
    return {
      ...planned,
      moved: facts.behind,
      ...(unasked ? { detail: PROJECT_SYNC_MOVED_UNASKED_DETAIL } : {}),
    };
  if (
    after.branch === branch &&
    after.head === facts.head &&
    merged.code !== 0 &&
    (await uncommittedCount(git, cwd)) === 0
  )
    return {
      ...planned,
      action: "fetch",
      reason: "refused",
      detail: gitReason(merged.stderr),
      downgraded: true,
    };
  return {
    ...planned,
    branch: after.branch,
    detail: projectSyncObservedDetail(after.branch, after.head),
    downgraded: true,
  };
}

/** Whether the merge's own words say it moved from `from` to `to` (Git prints both, shortened). */
function saysMoved(stdout: string, from: string | null, to: string): boolean {
  const updating = /^Updating ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})$/m.exec(stdout);
  return (
    from !== null &&
    updating !== null &&
    from.startsWith(updating[1]!) &&
    to.startsWith(updating[2]!) &&
    /^Fast-forward$/m.test(stdout)
  );
}
