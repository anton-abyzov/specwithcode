/**
 * The first feature guide (1398 AC-22 to AC-24), shown in the sample
 * project's window above the coordinator: three knots on one thread, the
 * current step's sentence and action, "Skip this step" and "Leave the guide".
 * It is not modal and blocks nothing.
 *
 * The server stores the guide's start and end (`projects.firstFeatureGuide`);
 * everything else is read from live state: the project's SpecWeave state, its
 * board, the coordinator's last run and the reviewer the app would pick. This
 * window keeps only its skips, whether the card was seen In review and whether
 * the review was opened from the guide.
 *
 * `FirstFeatureGuideView` is pure, for tests and the fixture;
 * `FirstFeatureGuide` reads the state and makes the presses.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProjectFirstFeatureGuideMark,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { resolveReviewer } from "@specweave-studio/shared/adversarialReview";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { txNow, useTx } from "../../../i18n";
import { renderRich } from "../../../i18n/rich";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { projectEnvironment } from "../../../state/projects";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { ProviderLogo } from "../../ProviderLogo";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
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
  guideShown,
  guideView,
  isFirstFeatureSample,
  type GuideStepId,
  type GuideView,
} from "./firstFeature.logic";

// ── What this window keeps ───────────────────────────────────────────────

const LocalGuideSchema = Schema.Struct({
  skipped: Schema.Array(Schema.Literals(["specweave", "ask", "review"])),
  seenInReview: Schema.Boolean,
  openedReview: Schema.Boolean,
  /** A finished guide's end was closed here. */
  closed: Schema.Boolean,
});
type LocalGuide = typeof LocalGuideSchema.Type;
const EMPTY_LOCAL: LocalGuide = { skipped: [], seenInReview: false, openedReview: false, closed: false };

/** The guide's window-only facts for one sample project. */
export function useFirstFeatureLocal(environmentId: EnvironmentId, projectId: ProjectId) {
  return useLocalStorage(
    `swc:first-feature:${environmentId}:${projectId}`,
    EMPTY_LOCAL,
    LocalGuideSchema,
  );
}

/** This window saw a guide on the machine finish: the offer stays gone after the sample is removed. */
export function useFirstFeatureFinishedHere(environmentId: EnvironmentId | null) {
  return useLocalStorage(
    `swc:first-feature-finished:${environmentId ?? "none"}`,
    false,
    Schema.Boolean,
  );
}

/** Records a guide mark; resolves to an error line, or null. */
export function useFirstFeatureMark(environmentId: EnvironmentId, projectId: ProjectId) {
  const mark = useAtomCommand(projectWorkspace.firstFeatureGuide, { reportFailure: false });
  return useCallback(
    async (next: ProjectFirstFeatureGuideMark): Promise<string | null> => {
      try {
        const result = await mark({ environmentId, input: { projectId, mark: next } });
        return result._tag === "Failure" ? "The guide could not be updated. Try again." : null;
      } catch {
        return "The guide could not be updated. Try again.";
      }
    },
    [environmentId, mark, projectId],
  );
}

/**
 * The project menu's "First feature guide" for a sample whose guide was left
 * (opened again on the server) or whose end was closed here; undefined otherwise.
 */
export function useFirstFeatureReopen(project: EnvironmentProject): (() => void) | undefined {
  const [local, setLocal] = useFirstFeatureLocal(project.environmentId, project.id);
  const mark = useFirstFeatureMark(project.environmentId, project.id);
  const shown = guideShown(project, local.closed);
  if (shown === "left")
    return () =>
      void mark("started").then((failed) => {
        if (failed !== null)
          toastManager.add(stackedThreadToast({ type: "error", title: txNow(failed) }));
      });
  if (shown === "closed") return () => setLocal((held) => ({ ...held, closed: false }));
  return undefined;
}

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
  return verdict === "ship" ? REVIEW_SHIP : verdict === "fix first" ? REVIEW_FIX_FIRST : REVIEW_NO_VERDICT;
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
              {review.brand === null ? null : <ProviderLogo brand={review.brand} className="size-3.5" />}
              <span className="min-w-0 truncate text-foreground">{review.model ?? tx(REVIEW_UNNAMED)}</span>
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
              {tx(view.reviewNote?.kind === "no-second-family" ? ASK_SENTENCE_NO_REVIEW : ASK_SENTENCE)}
            </p>
            {view.askStatus ? <AskStatusLine status={view.askStatus} /> : null}
            <div className="flex flex-wrap gap-2">
              {view.card === null ? (
                <Button size="sm" variant="outline" disabled={disabled} onClick={props.onWriteRequest}>
                  {tx(WRITE_IT_FOR_ME)}
                </Button>
              ) : null}
              <Button size="sm" variant={view.card === null ? "ghost" : "outline"} onClick={props.onOpenThread}>
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
              <Button size="sm" variant="outline" disabled={view.card === null} onClick={props.onOpenReview}>
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
        {step === "end" ? (
          <GuideEnd {...props} />
        ) : null}
        {view.waiting ? (
          <p role="status" className="text-xs text-warning-foreground" data-first-feature-waiting="">
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
          <Button size="xs" variant="link" className="text-muted-foreground" onClick={() => props.onSkip(step)}>
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
          <p role="status" className="text-xs text-success-foreground" data-first-feature-review-all="done">
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
            <p className="text-xs text-muted-foreground">{tx(END_REVIEW_ALL_NOTE)}</p>
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
            <Button size="sm" variant="ghost" disabled={removing === "removing"} onClick={props.onRemoveCancel}>
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

// ── Reading the state ────────────────────────────────────────────────────

/**
 * Whether a model of another family than the builder's can review, by the
 * rule the app picks a reviewer with: `resolveReviewer` over this project's
 * review order, with the builder as the author. Null while it cannot be told.
 */
export function secondFamilyReady(input: {
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly settings: ServerSettings | undefined;
  readonly project: Parameters<typeof resolveProjectSettings>[2];
  readonly projectId: ProjectId;
  readonly author: ModelSelection | null;
  readonly nowMs: number;
}): boolean | null {
  if (!input.providers || !input.settings || input.author === null) return null;
  const settings = resolveProjectSettings(input.settings, input.projectId, input.project).settings;
  const review = settings.adversarialReview ?? DEFAULT_ADVERSARIAL_REVIEW_SETTINGS;
  const resolution = resolveReviewer({
    providers: input.providers,
    author: settings.defaultModelSelection ?? input.author,
    reviewers: review.reviewers,
    tier: review.tier,
    tiers: settings.modelTiers,
    sourceOrder: settings.defaultModelProviders,
    excludedModels: settings.providerLimitExcludedModels,
    nowMs: input.nowMs,
  });
  return resolution.reviewer !== null;
}

/** How often a running guide reads the board again; the Board tab reads every 30 s. */
const GUIDE_BOARD_REFRESH_MS = 15_000;
const RING_ATTEMPTS = 40;

/** Rings the Board tab's setup button twice once it is on screen (first-feature.css). */
function ringBoardSetupButton() {
  let attempt = 0;
  const look = () => {
    const button = document.querySelector<HTMLButtonElement>(
      ".sws-board-setup-actions button:not(:disabled)",
    );
    if (button === null) {
      if (++attempt < RING_ATTEMPTS) requestAnimationFrame(look);
      return;
    }
    button.removeAttribute("data-first-feature-ring");
    void button.offsetWidth;
    button.setAttribute("data-first-feature-ring", "");
    button.addEventListener(
      "animationend",
      (event) => {
        if (event.animationName === "first-feature-ring")
          button.removeAttribute("data-first-feature-ring");
      },
    );
    button.focus({ preventScroll: false });
  };
  requestAnimationFrame(look);
}

export interface FirstFeatureGuideProps {
  readonly project: EnvironmentProject;
  /** `specweaveStateOf(snapshot)` for this project. */
  readonly specweave: string | undefined;
  /** SpecWeave's setup failed or needs Node.js. */
  readonly specweaveWaiting: boolean;
  /** The coordinator's last run failed or hit a limit. */
  readonly askWaiting: boolean;
  /** The model the work starts on: the coordinator's. */
  readonly author: ModelSelection | null;
  readonly canOperate: boolean;
  readonly onShowBoard: () => void;
  readonly onOpenIncrement: (incrementId: string) => void;
  readonly onAsk: ((text: string) => void) | undefined;
  readonly onOpenThread: () => void;
}

/** Mounts nothing, and reads nothing, outside the first feature sample. */
export function FirstFeatureGuide(props: FirstFeatureGuideProps) {
  return isFirstFeatureSample(props.project) ? <FirstFeatureGuideHost {...props} /> : null;
}

function FirstFeatureGuideHost(props: FirstFeatureGuideProps) {
  const { project } = props;
  const navigate = useNavigate();
  const [local, setLocal] = useFirstFeatureLocal(project.environmentId, project.id);
  const [, setFinishedHere] = useFirstFeatureFinishedHere(project.environmentId);
  const shown = guideShown(project, local.closed);
  const mark = useFirstFeatureMark(project.environmentId, project.id);
  const [error, setError] = useState<string | null>(null);
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const canWriteSettings = useEnvironmentScope(project.environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const remove = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const [reviewAll, setReviewAll] = useState<"offered" | "saving" | "done">("offered");
  const [removing, setRemoving] = useState<"offered" | "confirm" | "removing">("offered");
  const active = shown === "running" || shown === "finished";
  const boardQuery = useEnvironmentQuery(
    useMemo(
      () =>
        active && props.specweave === "on"
          ? projectWorkspace.board({
              environmentId: project.environmentId,
              input: { projectId: project.id },
            })
          : null,
      [active, project.environmentId, project.id, props.specweave],
    ),
  );
  const refreshBoard = boardQuery.refresh;
  useEffect(() => {
    if (shown !== "running" || props.specweave !== "on") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshBoard();
    }, GUIDE_BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [props.specweave, refreshBoard, shown]);
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const secondFamily = secondFamilyReady({
    providers: config?.providers,
    settings: config?.settings,
    project,
    projectId: project.id,
    author: props.author,
    nowMs,
  });
  const view = guideView({
    specweave: props.specweave,
    specweaveWaiting: props.specweaveWaiting,
    cards: boardQuery.data?.cards ?? null,
    askWaiting: props.askWaiting,
    secondFamily,
    seenInReview: local.seenInReview,
    openedReview: local.openedReview,
    skipped: local.skipped,
  });
  // Seen In review once, so a card back in Active reads as fixing what the review found.
  const inReview = view.card?.column === "review";
  useEffect(() => {
    if (inReview && !local.seenInReview) setLocal((held) => ({ ...held, seenInReview: true }));
  }, [inReview, local.seenInReview, setLocal]);
  // The end is reached: stored as finished, once. A failure says so and tries again on the next change.
  const finishing = useRef(false);
  const reachedEnd = view.current === "end" && shown === "running";
  useEffect(() => {
    if (!reachedEnd || finishing.current) return;
    finishing.current = true;
    void mark("finished").then((failed) => {
      finishing.current = false;
      setError(failed);
      if (failed === null) setFinishedHere(true);
    });
  }, [mark, reachedEnd, setFinishedHere]);

  if (!active) return null;
  const canReviewAll = canWriteSettings && config?.settings !== undefined;
  return (
    <FirstFeatureGuideView
      view={view}
      projectTitle={project.title}
      finishedStored={shown === "finished"}
      disabled={!props.canOperate}
      error={error}
      reviewAll={canReviewAll ? reviewAll : "not-allowed"}
      removing={removing}
      onShowMe={() => {
        props.onShowBoard();
        ringBoardSetupButton();
      }}
      onWriteRequest={() => props.onAsk?.(view.request)}
      onOpenThread={props.onOpenThread}
      onOpenReview={() => {
        if (view.card === null) return;
        setLocal((held) => ({ ...held, openedReview: true }));
        props.onOpenIncrement(view.card.incrementId);
      }}
      onAddReviewer={() => void navigate({ to: "/settings/providers" })}
      onSkip={(step) =>
        setLocal((held) => ({
          ...held,
          skipped: held.skipped.includes(step) ? held.skipped : [...held.skipped, step],
        }))
      }
      onLeave={() => {
        if (shown === "finished") {
          setLocal((held) => ({ ...held, closed: true }));
          return;
        }
        void mark("left").then(setError);
      }}
      onReviewAll={() => {
        setReviewAll("saving");
        void updateSettings({
          environmentId: project.environmentId,
          input: { patch: { adversarialReview: { autoOnFeatureComplete: true } } },
        })
          .then((result) => {
            if (result._tag === "Failure") throw new Error("not saved");
            setReviewAll("done");
          })
          .catch(() => {
            setReviewAll("offered");
            setError("The setting was not saved. Try again.");
          });
      }}
      onRemove={() => setRemoving("confirm")}
      onRemoveCancel={() => setRemoving("offered")}
      onRemoveConfirm={() => {
        setRemoving("removing");
        void remove({
          environmentId: project.environmentId,
          input: { projectId: project.id, force: true, confirmationTitle: project.title },
        }).then((result) => {
          if (result._tag === "Failure") {
            setRemoving("confirm");
            setError("The sample project was not removed. Try again.");
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: txNow("Removed {name}", { name: project.title }),
              description: txNow("Its folder and files stay on disk."),
            }),
          );
          void navigate({ to: "/" });
        });
      }}
    />
  );
}
