import type {
  PullRequestChecksState,
  PullRequestReviewDecision,
} from "@specweave-studio/contracts";

/** Provider observations, not a claim of exact-head QA or release verification. */
export interface ResolutionPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly mergedAt?: string | null | undefined;
  readonly closedAt?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly observedAt?: number | undefined;
  readonly syncedAt?: string | undefined;
  readonly isDraft?: boolean | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
}

/**
 * Every relevant PR must carry affirmative readiness from the same merged observation.
 * Legacy/missing host evidence stays unknown. Age alone never completes work.
 * A snapshot has no head SHA or QA receipt; this deliberately makes neither claim.
 */
export function resolutionMergeAt(
  pullRequests: ReadonlyArray<ResolutionPullRequest | null>,
  userAnchorMs: number,
  nowMs: number,
): number | null {
  if (pullRequests.length === 0 || !Number.isFinite(userAnchorMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  let latestMerge = Number.NEGATIVE_INFINITY;
  for (const pr of pullRequests) {
    if (
      pr === null ||
      pr.state !== "merged" ||
      pr.isDraft === true ||
      pr.checksState !== "passing" ||
      pr.reviewDecision !== "approved"
    )
      return null;
    const mergedAt = Date.parse(pr.mergedAt ?? "");
    const updatedAt = Date.parse(pr.updatedAt ?? "");
    const observedAt = pr.observedAt ?? Date.parse(pr.syncedAt ?? "");
    if (
      !Number.isFinite(mergedAt) ||
      !Number.isFinite(updatedAt) ||
      !Number.isFinite(observedAt) ||
      updatedAt < mergedAt ||
      observedAt < updatedAt ||
      observedAt > nowMs
    )
      return null;
    latestMerge = Math.max(latestMerge, mergedAt);
  }
  return latestMerge >= userAnchorMs ? latestMerge : null;
}
