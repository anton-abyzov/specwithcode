/**
 * The first feature guide's view (1398 AC-22 to AC-24): three knots on one
 * thread, the current step's sentence and action, "Skip this step" and "Leave
 * the guide", and the end. Pure: `FirstFeatureGuide` reads the state and makes
 * the presses; tests and the fixture feed it directly.
 */
import type { CSSProperties } from "react";

import { useTx } from "../../../i18n";
import { renderRich } from "../../../i18n/rich";
import { ProviderLogo } from "../../ProviderLogo";
import { Button } from "../../ui/button";
import {
  ADD_ONE,
  ASK_FIXING,
  ASK_IN_REVIEW,
  ASK_PLANNING,
  ASK_SENTENCE,
  ASK_SENTENCE_NO_REVIEW,
  ASK_WORKING,
  END_CANCEL,
  END_REMOVE,
  END_REMOVE_CONFIRM,
  END_REMOVE_YES,
  END_REVIEW_ALL,
  END_REVIEW_ALL_DONE,
  END_REVIEW_ALL_NOT_ALLOWED,
  END_REVIEW_ALL_NOTE,
  END_SENTENCE,
  GUIDE_STEP_LABELS,
  GUIDE_TITLE,
  LEAVE_THE_GUIDE,
  OPEN_THE_REVIEW,
  OPEN_THE_THREAD,
  REVIEW_FIX_FIRST,
  REVIEW_NONE_NO_FAMILY,
  REVIEW_NONE_RECORDED,
  REVIEW_NO_VERDICT,
  REVIEW_SAME_FAMILY,
  REVIEW_SENTENCE,
  REVIEW_SHIP,
  REVIEW_UNNAMED,
  SHOW_ME,
  SKIP_THIS_STEP,
  SPECWEAVE_SENTENCE,
  WRITE_IT_FOR_ME,
  type GuideStepId,
  type GuideView,
} from "./firstFeature.logic";

// ── The view ──────────────────────────────────────────────────────────────

export interface FirstFeatureGuideViewProps {
  readonly view: GuideView;
  readonly projectTitle: string;
  /** The guide reached its end and the server says `finished`, so the sample may be removed. */
  readonly finishedStored: boolean;
  readonly disabled?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly reviewAll?: "offered" | "saving" | "done" | "not-allowed" | undefined;
  readonly removing?: "offered" | "confirm" | "removing" | undefined;
  readonly onShowMe: () => void;
  readonly onWriteRequest: () => void;
  readonly onOpenThread: () => void;
  readonly onOpenReview: () => void;
  readonly onAddReviewer: () => void;
  readonly onSkip: (step: GuideStepId) => void;
  readonly onLeave: () => void;
  readonly onReviewAll: () => void;
  readonly onRemove: () => void;
  readonly onRemoveConfirm: () => void;
  readonly onRemoveCancel: () => void;
}

function verdictLabel(verdict: GuideView["reviews"][number]["verdict"]) {
  return verdict === "ship"
    ? REVIEW_SHIP
    : verdict === "fix first"
      ? REVIEW_FIX_FIRST
      : REVIEW_NO_VERDICT;
}

/** The thread with three knots, as the first-run stage bar draws it (1387). */
function GuideKnots({ view }: { readonly view: GuideView }) {
  const tx = useTx();
  return (
    <div
      data-slot="setup-stage-bar"
      data-first-feature-knots=""
      style={{ "--setup-stages": view.knots.length } as CSSProperties}
    >
      <span aria-hidden data-slot="setup-rail">
        <i data-motion="setup" style={{ "--setup-progress": view.progress } as CSSProperties} />
      </span>
      <ol
        aria-label={tx("Steps")}
        className="relative grid"
        style={{ gridTemplateColumns: `repeat(${view.knots.length}, minmax(0, 1fr))` }}
      >
        {view.knots.map((knot) => (
          <li
            key={knot.id}
            data-state={knot.state}
            data-step={knot.id}
            aria-current={knot.state === "now" ? "step" : undefined}
            className="grid min-w-0 justify-items-center gap-1.5 pb-1 text-xs font-medium text-muted-foreground data-[state=now]:text-foreground"
          >
            <span aria-hidden data-slot="setup-knot" data-motion="setup" />
            <span className="max-w-full truncate">
              {tx(GUIDE_STEP_LABELS[knot.id])}
              {knot.state === "done" ? <span className="sr-only">{` (${tx("done")})`}</span> : null}
              {knot.state === "skipped" ? (
                <span className="sr-only">{` (${tx("skipped")})`}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AskStatusLine({ status }: { readonly status: NonNullable<GuideView["askStatus"]> }) {
  const tx = useTx();
  const text =
    status.kind === "planning"
      ? tx(ASK_PLANNING)
      : status.kind === "review"
        ? tx(ASK_IN_REVIEW)
        : status.kind === "fixing"
          ? tx(ASK_FIXING)
          : tx(ASK_WORKING, { done: status.done, total: status.total });
  return (
    <p className="text-xs text-muted-foreground" data-first-feature-status={status.kind}>
      {text}
    </p>
  );
}

function ReviewList({ view }: { readonly view: GuideView }) {
  const tx = useTx();
  return (
    <>
      {view.reviews.length > 0 ? (
        <ul className="grid gap-1" aria-label={tx("Reviews")} data-first-feature-reviews="">
          {view.reviews.map((review, index) => (
            <li key={`${review.at}:${index}`} className="flex min-w-0 items-center gap-2 text-xs">
              {review.brand === null ? null : (
                <ProviderLogo brand={review.brand} className="size-3.5" />
              )}
              <span className="min-w-0 truncate text-foreground">
                {review.model ?? tx(REVIEW_UNNAMED)}
              </span>
              <span
                className={
                  review.verdict === "ship"
                    ? "text-success-foreground"
                    : review.verdict === "fix first"
                      ? "text-warning-foreground"
                      : "text-muted-foreground"
                }
              >
                {tx(verdictLabel(review.verdict))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.reviewNote?.kind === "same-family" ? (
        <p className="text-xs text-muted-foreground" data-first-feature-note="same-family">
          {tx(REVIEW_SAME_FAMILY, { model: view.reviewNote.model })}
        </p>
      ) : null}
      {view.reviewNote?.kind === "none-recorded" ? (
        <p className="text-xs text-muted-foreground" data-first-feature-note="none-recorded">
          {tx(REVIEW_NONE_RECORDED)}
        </p>
      ) : null}
      {view.reviewNote?.kind === "no-second-family" ? (
        <p className="text-xs text-muted-foreground" data-first-feature-note="no-second-family">
          {renderRich(tx(REVIEW_NONE_NO_FAMILY), {
            codex: (
              <span className="inline-flex items-center gap-1 align-middle text-foreground">
                <ProviderLogo brand="openai" className="size-3.5" />
                Codex
              </span>
            ),
            muse: (
              <span className="inline-flex items-center gap-1 align-middle text-foreground">
                <ProviderLogo brand="meta" className="size-3.5" />
                Muse Code
              </span>
            ),
          })}
        </p>
      ) : null}
    </>
  );
}

export function FirstFeatureGuideView(props: FirstFeatureGuideViewProps) {
  const tx = useTx();
  const { view } = props;
  const disabled = props.disabled === true;
  const step = view.current;
  return (
    <section
      aria-labelledby="first-feature-guide-title"
      data-slot="first-feature-guide"
      data-step={step}
      className="mx-auto mb-3 grid w-full max-w-3xl gap-2 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground"
    >
      <h2 id="first-feature-guide-title" className="text-sm font-medium">
        {tx(GUIDE_TITLE)}
      </h2>
      <GuideKnots view={view} />
      {/* Keyed by the step, so its sentence follows the knot 40 ms later (first-feature.css). */}
      <div key={step} data-slot="first-feature-now" data-motion="setup" className="grid gap-2">
        {step === "specweave" ? (
          <>
            <p className="text-sm">{tx(SPECWEAVE_SENTENCE)}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={disabled} onClick={props.onShowMe}>
                {tx(SHOW_ME)}
              </Button>
            </div>
          </>
        ) : null}
        {step === "ask" ? (
          <>
            <p className="text-sm">
              {tx(
                view.reviewNote?.kind === "no-second-family"
                  ? ASK_SENTENCE_NO_REVIEW
                  : ASK_SENTENCE,
              )}
            </p>
            {view.askStatus ? <AskStatusLine status={view.askStatus} /> : null}
            <div className="flex flex-wrap gap-2">
              {view.card === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={props.onWriteRequest}
                >
                  {tx(WRITE_IT_FOR_ME)}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={view.card === null ? "ghost" : "outline"}
                onClick={props.onOpenThread}
              >
                {tx(OPEN_THE_THREAD)}
              </Button>
            </div>
          </>
        ) : null}
        {step === "review" ? (
          <>
            <p className="text-sm">{tx(REVIEW_SENTENCE)}</p>
            <ReviewList view={view} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={view.card === null}
                onClick={props.onOpenReview}
              >
                {tx(OPEN_THE_REVIEW)}
              </Button>
              {view.reviewNote?.kind === "no-second-family" ? (
                <Button size="sm" variant="ghost" onClick={props.onAddReviewer}>
                  {tx(ADD_ONE)}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {step === "end" ? <GuideEnd {...props} /> : null}
        {view.waiting ? (
          <p
            role="status"
            className="text-xs text-warning-foreground"
            data-first-feature-waiting=""
          >
            {tx(view.waiting)}
          </p>
        ) : null}
        {props.error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {tx(props.error)}
          </p>
        ) : null}
      </div>
      <p className="flex flex-wrap justify-end gap-4">
        {step === "end" ? null : (
          <Button
            size="xs"
            variant="link"
            className="text-muted-foreground"
            onClick={() => props.onSkip(step)}
          >
            {tx(SKIP_THIS_STEP)}
          </Button>
        )}
        <Button size="xs" variant="link" className="text-muted-foreground" onClick={props.onLeave}>
          {tx(LEAVE_THE_GUIDE)}
        </Button>
      </p>
    </section>
  );
}

/** AC-05: the end, with two actions and neither chosen for the person. */
function GuideEnd(props: FirstFeatureGuideViewProps) {
  const tx = useTx();
  const reviewAll = props.reviewAll ?? "offered";
  const removing = props.removing ?? "offered";
  return (
    <>
      <p className="text-sm">{tx(END_SENTENCE)}</p>
      <div className="grid gap-1">
        {reviewAll === "done" ? (
          <p
            role="status"
            className="text-xs text-success-foreground"
            data-first-feature-review-all="done"
          >
            {tx(END_REVIEW_ALL_DONE)}
          </p>
        ) : (
          <>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={props.disabled === true || reviewAll !== "offered"}
                onClick={props.onReviewAll}
              >
                {tx(END_REVIEW_ALL)}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground" data-first-feature-review-all={reviewAll}>
              {reviewAll === "not-allowed"
                ? tx(END_REVIEW_ALL_NOT_ALLOWED)
                : tx(END_REVIEW_ALL_NOTE)}
            </p>
          </>
        )}
      </div>
      {removing === "confirm" || removing === "removing" ? (
        <div className="grid gap-2" data-first-feature-remove="confirm">
          <p className="text-xs">{tx(END_REMOVE_CONFIRM, { name: props.projectTitle })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={removing === "removing"}
              onClick={props.onRemoveConfirm}
            >
              {tx(END_REMOVE_YES)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={removing === "removing"}
              onClick={props.onRemoveCancel}
            >
              {tx(END_CANCEL)}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled === true || !props.finishedStored}
            onClick={props.onRemove}
          >
            {tx(END_REMOVE)}
          </Button>
        </div>
      )}
    </>
  );
}
