import type { PullRequestAction } from "@specweave-studio/contracts";

export interface SeenPullRequestHead {
  /** Which pull request on which server this belongs to, so a switch starts over. */
  readonly key: string;
  readonly sha: string | undefined;
}

/**
 * The head a reader was first shown. A background refresh does not move it, so a merge or a review
 * keeps applying to the commits they read until they choose to load the newer ones.
 */
export function seenPullRequestHead(
  seen: SeenPullRequestHead | null,
  key: string,
  settledHead: string | undefined,
): SeenPullRequestHead {
  return seen !== null && seen.key === key && (seen.sha !== undefined || settledHead === undefined)
    ? seen
    : { key, sha: settledHead };
}

/** A merge lands only the head the reader was shown, so the host refuses a head that moved. */
export function mergeHeadPin(
  action: PullRequestAction,
  headSha: string | undefined,
): { readonly expectedHeadSha?: string } {
  return (action === "merge" || action === "enable-auto-merge") && headSha !== undefined
    ? { expectedHeadSha: headSha }
    : {};
}
