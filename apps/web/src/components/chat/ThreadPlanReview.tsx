/**
 * The review line of a thread's plan card: who reviewed the increment's code,
 * at which commit and with what verdict ("Reviewed by GPT-6.1 Sol at
 * 3f9a2c1 · ship"), or what its spec still asks for ("OpenAI review
 * required"). Read from the increment's review records, which `specweave
 * review` and `specweave review --record` write.
 */
import type { ThreadIncrementReview } from "@specweave-studio/contracts";
import { MODEL_FAMILY_LABELS, type ModelFamily } from "@specweave-studio/shared/fallbackOptions";
import { memo } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { cn } from "~/lib/utils";

/** "OpenAI" for openai; a family nobody recorded or knows stays as written. */
export function reviewFamilyLabel(family: string): string {
  return family in MODEL_FAMILY_LABELS ? MODEL_FAMILY_LABELS[family as ModelFamily] : family;
}

/** What the card says, as data, so it can be tested without rendering. */
export function reviewSummary(review: ThreadIncrementReview | null | undefined): {
  readonly latest: {
    /** Null for a report without a record line. */
    readonly model: string | null;
    readonly family: string | null;
    readonly commit: string | null;
    readonly verdict: "ship" | "fix first" | null;
    readonly sameFamily: boolean;
    readonly reportPath: string;
  } | null;
  /** The family a required review still needs (`cross-family` for any other one); null when nothing is missing. */
  readonly missing: string | null;
} | null {
  if (review === null || review === undefined) return null;
  const latest = review.latest;
  const missing =
    review.policy?.required === true && review.policySatisfied !== true
      ? review.policy.family
      : null;
  if (latest === null && missing === null) return null;
  return {
    latest:
      latest === null
        ? null
        : {
            model: latest.model,
            family: latest.family === "unknown" ? null : reviewFamilyLabel(latest.family),
            commit: latest.head === null ? null : latest.head.slice(0, 7),
            verdict: latest.verdict,
            sameFamily:
              review.authorFamily !== null &&
              latest.family !== "unknown" &&
              latest.family === review.authorFamily,
            reportPath: latest.reportPath,
          },
    missing,
  };
}

export const ThreadPlanReview = memo(function ThreadPlanReview(props: {
  review: ThreadIncrementReview | null | undefined;
  onOpenPath?: ((path: string) => void) | null;
}) {
  const tx = useTx();
  const summary = reviewSummary(props.review);
  if (summary === null) return null;
  const { latest, missing } = summary;
  const open = props.onOpenPath ?? null;
  return (
    <p className="mb-1.5 text-xs text-muted-foreground" data-plan-review>
      {latest !== null ? (
        <span data-plan-review-latest>
          {renderRich(
            latest.model === null
              ? tx("Reviewed, model not recorded")
              : latest.commit === null
                ? tx("Reviewed by {model}")
                : tx("Reviewed by {model} at {commit}"),
            {
              model: open ? (
                <button
                  type="button"
                  className="font-medium text-foreground/80 underline-offset-2 hover:underline"
                  onClick={() => open(latest.reportPath)}
                >
                  {latest.model}
                </button>
              ) : (
                <span className="font-medium text-foreground/80">{latest.model}</span>
              ),
              commit: <code className="font-mono">{latest.commit}</code>,
            },
          )}
          {latest.family !== null ? ` (${latest.family})` : null}
          {latest.verdict !== null ? (
            <>
              {" · "}
              <span
                className={
                  latest.verdict === "ship"
                    ? "text-success-foreground"
                    : "text-destructive-foreground"
                }
              >
                {latest.verdict === "ship" ? tx("ship") : tx("fix first")}
              </span>
            </>
          ) : null}
          {latest.sameFamily ? (
            <span className="text-warning-foreground"> · {tx("same family as the author")}</span>
          ) : null}
        </span>
      ) : null}
      {missing !== null ? (
        <span
          className={cn("text-warning-foreground", latest !== null && "ms-1")}
          data-plan-review-missing
        >
          {latest !== null ? "· " : null}
          {missing === "cross-family"
            ? tx("Review by another model family required")
            : renderRich(tx("{family} review required"), { family: reviewFamilyLabel(missing) })}
        </span>
      ) : null}
    </p>
  );
});
