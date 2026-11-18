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
 * `FirstFeatureGuideView` (its own file) is pure, for tests and the fixture;
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { txNow } from "../../../i18n";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { projectEnvironment } from "../../../state/projects";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { guideShown, guideView, isFirstFeatureSample } from "./firstFeature.logic";
import { FirstFeatureGuideView } from "./FirstFeatureGuideView";

// ── What this window keeps ───────────────────────────────────────────────

const LocalGuideSchema = Schema.Struct({
  skipped: Schema.Array(Schema.Literals(["specweave", "ask", "review"])),
  seenInReview: Schema.Boolean,
  openedReview: Schema.Boolean,
  /** A finished guide's end was closed here. */
  closed: Schema.Boolean,
});
type LocalGuide = typeof LocalGuideSchema.Type;
const EMPTY_LOCAL: LocalGuide = {
  skipped: [],
  seenInReview: false,
  openedReview: false,
  closed: false,
};

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
    author: input.author,
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
/** A "finished" mark that failed is tried again after this long. */
const FINISH_RETRY_MS = 15_000;

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
    button.addEventListener("animationend", (event) => {
      if (event.animationName === "first-feature-ring")
        button.removeAttribute("data-first-feature-ring");
    });
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
  const [requestWritten, setRequestWritten] = useState(false);
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
  // The end is reached: stored as finished, once. A failure says so and tries again a little later.
  const finishing = useRef(false);
  const [finishTry, setFinishTry] = useState(0);
  const reachedEnd = view.current === "end" && shown === "running";
  useEffect(() => {
    if (!reachedEnd || finishing.current) return;
    finishing.current = true;
    let retry: number | undefined;
    void mark("finished").then((failed) => {
      finishing.current = false;
      setError(failed);
      if (failed === null) setFinishedHere(true);
      else retry = window.setTimeout(() => setFinishTry((n) => n + 1), FINISH_RETRY_MS);
    });
    return () => window.clearTimeout(retry);
  }, [finishTry, mark, reachedEnd, setFinishedHere]);

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
      requestWritten={requestWritten}
      onWriteRequest={() => {
        if (props.onAsk === undefined) return;
        props.onAsk(view.request);
        setRequestWritten(true);
      }}
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
