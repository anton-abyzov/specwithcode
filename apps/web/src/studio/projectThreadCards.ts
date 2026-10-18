/**
 * Threads as the project chat shows them: a card under the message that started
 * one, and a chip wherever a message names one. Both carry a status dot; a card
 * also offers the next step its thread's state calls for. Pure rules only; the
 * components live in components/studio/ProjectThreadCards.tsx.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { resolveThreadCurrentPullRequestLink } from "@specweave-studio/shared/threadPullRequests";
import type { VcsStatusResult } from "@specweave-studio/contracts";

import { THREAD_TONE_LABELS, threadStatusWord, threadTone, type ThreadTone } from "./shellModel";

/** A thread's dot: the pane's tones, plus "done" for a thread whose last turn finished. */
export type ThreadCardTone = ThreadTone | "done";

export interface ThreadCardStatus {
  readonly tone: ThreadCardTone;
  /** Said beside the dot and to screen readers, so the color is never the only cue. */
  readonly label: string;
}

type StatusShell = EnvironmentThreadShell;

export function threadCardStatus(thread: StatusShell, hostOffline = false): ThreadCardStatus {
  const tone = threadTone(thread, hostOffline);
  const word = threadStatusWord(thread, hostOffline);
  if (word !== null) return { tone, label: word };
  if (tone === "idle" && thread.latestRun?.status === "completed")
    return { tone: "done", label: "Done" };
  return { tone, label: THREAD_TONE_LABELS[tone] };
}

export type ThreadCardPullRequestState = "open" | "draft" | "merged" | "closed";

export interface ThreadCardPullRequest {
  readonly url: string;
  readonly number: number;
  readonly state: ThreadCardPullRequestState;
  /** Present while the host says the open pull request conflicts with its base branch. */
  readonly conflict?: ThreadCardConflict;
}

export interface ThreadCardConflict {
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The host read that reported the conflict, so a request can wait for a newer one. */
  readonly syncedAt: string;
}

type PullRequestLink = NonNullable<EnvironmentThreadShell["pullRequests"]>[number];

/**
 * Whether the host's last read says the linked pull request conflicts. A clean answer wins;
 * "unknown" is the host still computing after a push, so the watch's last verdict stands until
 * the host decides, the same rule the watch itself follows.
 */
export function threadCardConflict(link: PullRequestLink): ThreadCardConflict | null {
  const snapshot = link.snapshot;
  if (snapshot === null || snapshot.state !== "open") return null;
  const mergeability = snapshot.mergeability ?? "unknown";
  const conflicting =
    mergeability === "conflicting" ||
    (mergeability === "unknown" && link.watch?.conflicting === true);
  return conflicting
    ? {
        headBranch: snapshot.headBranch,
        baseBranch: snapshot.baseBranch,
        syncedAt: snapshot.syncedAt,
      }
    : null;
}

type GitStatus = Pick<
  VcsStatusResult,
  | "isRepo"
  | "refName"
  | "isDefaultRef"
  | "hasPrimaryRemote"
  | "hasWorkingTreeChanges"
  | "aheadCount"
  | "aheadOfDefaultCount"
  | "branchChanges"
  | "pr"
>;

/**
 * The thread's pull request: the one it linked (as the thread's header shows it),
 * or the one its checkout's branch has open on the host.
 */
export function threadCardPullRequest(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "branch">,
  git: GitStatus | null,
): ThreadCardPullRequest | null {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  if (link) {
    const snapshot = link.snapshot;
    const conflict = threadCardConflict(link);
    return {
      url: link.url,
      number: link.number,
      state: snapshot?.state === "open" && snapshot.isDraft ? "draft" : (snapshot?.state ?? "open"),
      ...(conflict === null ? {} : { conflict }),
    };
  }
  const pr = git?.pr ?? null;
  if (pr === null || (thread.branch !== null && pr.headRef !== thread.branch)) return null;
  return {
    url: pr.url,
    number: pr.number,
    state: pr.state === "open" && pr.isDraft ? "draft" : pr.state,
  };
}

/**
 * Work in the thread's checkout that no pull request carries yet: uncommitted
 * changes, or commits its branch has over the default branch. Only on a branch
 * of its own, with a remote to open the pull request on, and only while the
 * checkout is still on the thread's branch. After a pull request merged or
 * closed, only new work counts, not the commits that pull request already had.
 */
export function threadHasUnshippedWork(
  thread: Pick<EnvironmentThreadShell, "branch">,
  git: GitStatus | null,
  pullRequest: ThreadCardPullRequest | null,
): boolean {
  if (
    git === null ||
    !git.isRepo ||
    git.refName === null ||
    git.isDefaultRef ||
    !git.hasPrimaryRemote ||
    (thread.branch !== null && thread.branch !== git.refName)
  )
    return false;
  if (git.hasWorkingTreeChanges || git.aheadCount > 0) return true;
  if (pullRequest !== null) return false;
  const branchChanges = git.branchChanges;
  return (
    (git.aheadOfDefaultCount ?? 0) > 0 ||
    (branchChanges !== undefined && branchChanges.insertions + branchChanges.deletions > 0)
  );
}

/** The card itself opens the thread; these are the secondary actions beside it. */
export type ThreadCardAction =
  /** Asks the thread's own agent to merge the base in, resolve the conflicts and push. */
  | ({ readonly kind: "resolve_conflicts" } & ThreadCardPullRequest & {
        readonly conflict: ThreadCardConflict;
      })
  /** Runs the thread's own source control action that opens a pull request. */
  | { readonly kind: "create_pr" }
  | ({ readonly kind: "view_pr" } & ThreadCardPullRequest);

/**
 * The quick actions a thread card offers, in order. An action whose data has not
 * loaded is left out rather than shown disabled.
 */
export function threadCardActions(input: {
  readonly thread: Pick<EnvironmentThreadShell, "branch">;
  readonly git: GitStatus | null;
  readonly pullRequest: ThreadCardPullRequest | null;
  /** The person may change source control on the thread's host, which is connected. */
  readonly canChange: boolean;
  /** The thread's agent is busy; a conflict it is already working through is not offered again. */
  readonly working?: boolean;
  /** The host read a Resolve conflicts request was sent against, if one was. */
  readonly resolveRequestedFor?: string | null;
}): ThreadCardAction[] {
  const actions: ThreadCardAction[] = [];
  const { pullRequest } = input;
  const conflict = pullRequest?.conflict;
  // Offered until a newer host read: a resolve the agent just pushed takes a sync to clear, and
  // a second press in between would queue the same work twice.
  if (
    input.canChange &&
    pullRequest !== null &&
    conflict !== undefined &&
    (pullRequest.state === "open" || pullRequest.state === "draft") &&
    input.working !== true &&
    input.resolveRequestedFor !== conflict.syncedAt
  )
    actions.push({ kind: "resolve_conflicts", ...pullRequest, conflict });
  const pullRequestOpen =
    pullRequest?.state === "open" ||
    pullRequest?.state === "draft" ||
    input.git?.pr?.state === "open";
  if (
    input.canChange &&
    !pullRequestOpen &&
    threadHasUnshippedWork(input.thread, input.git, pullRequest)
  )
    actions.push({ kind: "create_pr" });
  if (pullRequest !== null) actions.push({ kind: "view_pr", ...pullRequest });
  return actions;
}
