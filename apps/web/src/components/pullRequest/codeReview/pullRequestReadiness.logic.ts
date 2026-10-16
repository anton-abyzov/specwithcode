import type {
  PullRequestCheck,
  PullRequestMergeability,
  PullRequestState,
} from "@specweave-studio/contracts";

import type { PullRequestReviewOutcome } from "../pullRequestDetail.logic";

export type ReadinessTone = "done" | "pending" | "blocked" | "neutral";

export interface ReadinessItem {
  readonly key: "checks" | "reviews" | "conflicts";
  readonly tone: ReadinessTone;
  readonly label: string;
}

export interface PullRequestReadiness {
  /** The one-line answer to "can this merge?", worded for the person deciding. */
  readonly headline: string;
  readonly tone: ReadinessTone;
  /** Empty once the pull request is merged or closed: there is nothing left to get ready. */
  readonly items: ReadonlyArray<ReadinessItem>;
}

const FAILING = new Set(["failure", "cancelled", "action-required"]);
const SETTLED = new Set(["success", "skipped", "neutral"]);

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Where the checks stand: a failing one decides it, then anything still running. */
export function checksReadiness(checks: ReadonlyArray<PullRequestCheck>): ReadinessItem {
  if (checks.length === 0) return { key: "checks", tone: "neutral", label: "No checks reported" };
  const failing = checks.filter((check) => FAILING.has(check.status)).length;
  const pending = checks.filter(
    (check) => !FAILING.has(check.status) && !SETTLED.has(check.status),
  ).length;
  if (failing > 0)
    return { key: "checks", tone: "blocked", label: `${plural(failing, "check")} failing` };
  if (pending > 0)
    return { key: "checks", tone: "pending", label: `${plural(pending, "check")} running` };
  return { key: "checks", tone: "done", label: `${plural(checks.length, "check")} passed` };
}

/** Where the reviews stand: a request for changes outweighs any number of approvals. */
export function reviewsReadiness(
  outcomes: ReadonlyArray<{ readonly outcome: PullRequestReviewOutcome; readonly stale: boolean }>,
  requestedReviewers: number,
): ReadinessItem {
  const live = outcomes.filter((entry) => entry.outcome !== "dismissed");
  if (live.some((entry) => entry.outcome === "changes-requested"))
    return { key: "reviews", tone: "blocked", label: "Changes requested" };
  const approvals = live.filter((entry) => entry.outcome === "approved" && !entry.stale).length;
  if (approvals > 0)
    return { key: "reviews", tone: "done", label: `${plural(approvals, "approval")}` };
  if (requestedReviewers > 0)
    return {
      key: "reviews",
      tone: "pending",
      label: `Waiting on ${plural(requestedReviewers, "reviewer")}`,
    };
  return { key: "reviews", tone: "neutral", label: "No reviews yet" };
}

export function conflictsReadiness(mergeability: PullRequestMergeability): ReadinessItem {
  switch (mergeability) {
    case "mergeable":
      return { key: "conflicts", tone: "done", label: "No conflicts with the base" };
    case "conflicting":
      return { key: "conflicts", tone: "blocked", label: "Conflicts with the base" };
    case "unknown":
      return { key: "conflicts", tone: "pending", label: "Checking for conflicts" };
  }
}

/**
 * Merge readiness as one block: the headline a reader acts on, over the three things that decide
 * it. Neutral items (no checks configured, no reviews asked for) never block; a failing check, a
 * request for changes or a conflict always does.
 */
export function pullRequestReadiness(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly outcomes: ReadonlyArray<{
    readonly outcome: PullRequestReviewOutcome;
    readonly stale: boolean;
  }>;
  readonly requestedReviewers: number;
}): PullRequestReadiness {
  if (input.state === "merged") return { headline: "Merged", tone: "done", items: [] };
  if (input.state === "closed")
    return { headline: "Closed without merging", tone: "neutral", items: [] };
  const items = [
    checksReadiness(input.checks),
    reviewsReadiness(input.outcomes, input.requestedReviewers),
    conflictsReadiness(input.mergeability),
  ];
  if (input.isDraft) return { headline: "Draft: mark it ready to merge", tone: "neutral", items };
  if (items.some((item) => item.tone === "blocked"))
    return { headline: "Blocked", tone: "blocked", items };
  if (items.some((item) => item.tone === "pending"))
    return { headline: "Almost ready", tone: "pending", items };
  return { headline: "Ready to merge", tone: "done", items };
}
