/** Moving one checkout forward (1390): the reads before the merge, the merge, and what is said after. */
import {
  planProjectSyncRepository,
  projectSyncUpstreamGoneDetail,
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_FILES_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_MOVED_UNASKED_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
  PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncStepResult,
} from "@specweave-studio/contracts";

import { originUpstream, readRepositoryFacts } from "./projectSyncFacts.ts";
import {
  branchAndHead,
  FETCH_MS,
  gitReason,
  isLinkedWorktree,
  read,
  type SyncContext,
  type SyncRepository,
  uncommittedCount,
} from "./projectSyncGit.ts";
import { dropOrigin, listOrigin, originHost, originRecord } from "./projectSyncOrigin.ts";

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
