import type {
  ServerProvider,
  StartAdversarialReviewResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { REVIEWER_SKIP_NOTES } from "@specweave-studio/shared/adversarialReview";

import { fallbackEntryLabel } from "../components/settings/FallbackOrderList";

/** What the toast after "Adversarial review" says. */
export interface AdversarialReviewNotice {
  readonly type: "success" | "warning";
  readonly title: string;
  readonly description?: string;
  /** The review thread to open, when one started. */
  readonly reviewThreadId?: ThreadId;
}

/** Most skip reasons a notice lists before it folds the rest into "and N more". */
const MAX_LISTED_SKIPS = 4;

/**
 * The notice for a review request: the reviewer that took it, or why every
 * model in the order was passed over, in the fallback order's own words.
 */
export function adversarialReviewNotice(
  result: StartAdversarialReviewResult,
  providers: ReadonlyArray<ServerProvider>,
): AdversarialReviewNotice {
  if (result.status === "started") {
    return {
      type: "success",
      title: `Adversarial review started on ${fallbackEntryLabel(providers, result.reviewer)}`,
      reviewThreadId: result.threadId,
    };
  }
  const listed = result.skipped
    .slice(0, MAX_LISTED_SKIPS)
    .map(
      (skip) =>
        `${fallbackEntryLabel(providers, skip.selection)}: ${REVIEWER_SKIP_NOTES[skip.reason]}`,
    );
  const more = result.skipped.length - listed.length;
  return {
    type: "warning",
    title: "No other model family can review now",
    description:
      listed.length === 0
        ? "Enable or sign in to a provider from another model family, then try again."
        : `${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
  };
}
