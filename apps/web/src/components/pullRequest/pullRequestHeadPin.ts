import type { PullRequestAction } from "@specweave-studio/contracts";

export interface SeenPullRequestHead {
  /** Which pull request on which server this belongs to, so a switch starts over. */
  readonly key: string;
  readonly sha: string | undefined;
}

/**
 * The head a reader was first shown, cached or fresh: whatever was painted first is what they
 * read. A refresh does not move it, so a merge or a review keeps applying to those commits until
 * they choose to load the newer ones.
 */
export function seenPullRequestHead(
  seen: SeenPullRequestHead | null,
  key: string,
  paintedHead: string | undefined,
): SeenPullRequestHead {
  return seen !== null && seen.key === key && (seen.sha !== undefined || paintedHead === undefined)
    ? seen
    : { key, sha: paintedHead };
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

/**
 * The line comments written on another head than the one a review is pinned to. Their lines
 * belong to the diff they were drawn on, so sending them with a newer head could attach them to
 * different code; the review waits until they are removed. A comment with no head was drawn
 * before one was known, and is held back the same way.
 */
export function commentsFromOtherHeads<C extends { readonly headSha?: string | undefined }>(
  comments: ReadonlyArray<C>,
  headSha: string | undefined,
): ReadonlyArray<C> {
  return headSha === undefined ? [] : comments.filter((comment) => comment.headSha !== headSha);
}
