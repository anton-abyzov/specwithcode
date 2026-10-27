import { useEffect, useState, type RefObject } from "react";
import type {
  FolderCopyMode,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import type { CopyStage } from "./handoffCopySteps";
import type { PendingCopy } from "./handoffFolderCopyPending";
import type { CopyStepItem } from "./HandoffCopyGuide";
import {
  canRevisit,
  COPY_STEP_LABELS,
  copyStepList,
  isStepAfter,
  laterStep,
  progressStep,
  restoredView,
  resumeNote,
  stepTone,
  type CopyStepId,
} from "./handoffCopyWizard";

/** A reopened copy while its destination answers, or after it could not be reached. */
export type CopyChecking = "checking" | "unreachable" | null;

const PICKED_UP = "Picked up where you left off.";
const RESTARTED = "Retry started this copy again from the beginning.";

/**
 * Which step of the folder copy is on screen: the live one, or an earlier one opened for
 * looking only. It remembers both in the pointer, and after a reopen brings back the step
 * that was on screen, or says what happened while the window was closed.
 */
export function useCopyStepView({
  stage,
  mode,
  auto,
  contextTransferred,
  summary,
  copy,
  held,
  closeLocked,
  working,
  pending,
  latestPending,
  remember,
  sourceLabel,
  doneReached,
}: {
  readonly stage: CopyStage;
  readonly mode: FolderCopyMode;
  readonly auto: boolean;
  readonly contextTransferred: boolean;
  readonly summary: FolderCopySourceSummary | null;
  readonly copy: FolderCopyStatus | null;
  readonly held: boolean;
  readonly closeLocked: boolean;
  readonly working: boolean;
  readonly pending: PendingCopy | null;
  readonly latestPending: RefObject<PendingCopy | null>;
  readonly remember: (value: PendingCopy) => void;
  readonly sourceLabel: string;
  /** Done is live for a committed copy-only copy with nothing left to fix or link. */
  readonly doneReached: boolean;
}) {
  // An earlier step of one copy on screen for looking only; null shows the live step.
  const [view, setView] = useState<{
    readonly step: CopyStepId;
    readonly operationId: string | null;
  } | null>(null);
  // The copy whose compared plan the person saw, so its Review was not skipped automatically.
  const [planShownFor, setPlanShownFor] = useState<string | null>(null);
  // The reopened pointer whose step comes back once the destination answers.
  const [restoring, setRestoring] = useState<PendingCopy | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // Said once above the step of the copy it was written for; looking elsewhere drops it.
  // A restart's note waits (operationId null) for the copy the restart begins.
  const [note, setNote] = useState<{
    readonly text: string;
    readonly live: CopyStepId;
    readonly view: CopyStepId | null;
    readonly operationId: string | null;
  } | null>(null);

  const operationId = pending?.operationId ?? null;
  const stepInput = { stage, mode, contextTransferred };
  const live = progressStep(stepInput);
  const revisitable = (id: CopyStepId) => canRevisit(id, { summary, copy, contextTransferred });
  if (stage === "preview" && operationId !== null && planShownFor !== operationId)
    setPlanShownFor(operationId);
  // Kept in the pointer too: after a reopen the plan is no longer on screen to tell.
  const planShown =
    operationId !== null && (planShownFor === operationId || pending?.planShown === true);
  if (note?.operationId === null) {
    if (operationId !== null) setNote({ ...note, operationId });
    // The restart never began a copy: the note is for nothing.
    else if (stage === "setup" && !working) setNote(null);
  }

  // The restore fires the first time the stage leaves setup, not when the run ends: a
  // one-click copy can poll until it finishes.
  if (restoring && stage !== "setup") {
    setRestoring(null);
    setUnreachable(false);
    if (restoring.operationId === operationId) {
      // What waits for the folder summary, still loading while the copy is polled; its
      // review shows once the summary arrives.
      const restored = restoredView({
        viewed: restoring.viewed,
        seen: restoring.seen,
        live,
        stage,
        revisitable: (id) => revisitable(id) || (id === "what" && working),
      });
      const text = restored.note
        ? resumeNote({ seen: restoring.seen, live, stage, copy, held, sourceLabel })
        : null;
      if (restored.view) {
        setView({ step: restored.view, operationId });
        setNote({ text: PICKED_UP, live, view: restored.view, operationId });
      } else if (text) setNote({ text, live, view: null, operationId });
    }
  } else if (restoring && !working && !unreachable) {
    // The check ended on setup: the destination did not answer, or the copy was dropped.
    if (operationId === restoring.operationId) setUnreachable(true);
    else setRestoring(null);
  }

  // A step stays on screen only for its own copy, behind it, while it has what it shows.
  const viewing =
    view !== null &&
    view.operationId === operationId &&
    isStepAfter(live, view.step) &&
    revisitable(view.step)
      ? view.step
      : null;
  const checking: CopyChecking = restoring ? (unreachable ? "unreachable" : "checking") : null;
  // While checking, the bar shows the step last seen, and nothing in it can be opened.
  const shown = restoring ? (restoring.seen ?? live) : live;
  const steps: ReadonlyArray<CopyStepItem> = copyStepList(mode).map((id) => {
    const behind = isStepAfter(shown, id);
    return {
      id,
      label: COPY_STEP_LABELS[id],
      state: behind ? "done" : id === shown ? "current" : "next",
      // One click skips choosing, and comparing too when the plan replaced nothing.
      auto: !restoring && auto && behind && (id === "what" || (id === "review" && !planShown)),
      tone: restoring ? null : stepTone(id, { ...stepInput, held }),
    };
  });

  // Saves where the person is. Only changed values are written, onto the newest pointer of
  // the same copy: a write on every render would loop, and a stale one would undo a
  // concurrent Replace all or Move anyway. A pointer on setup is being checked or cancelled.
  const doneSeen = doneReached && viewing === null;
  useEffect(() => {
    const saved = latestPending.current;
    if (!saved || saved.cancelled || restoring || stage === "setup") return;
    if (saved.operationId !== operationId) return;
    const seen = saved.seen ? laterStep(saved.seen, live) : live;
    const viewed = viewing ?? live;
    const done = doneSeen || saved.doneSeen === true;
    const shown = planShown || saved.planShown === true;
    // An undone copy is no longer one to keep as the last copy.
    const { reopened, ...rest } = saved;
    const keep = reopened === true && stage !== "undone";
    if (
      seen === saved.seen &&
      viewed === saved.viewed &&
      done === (saved.doneSeen === true) &&
      shown === (saved.planShown === true) &&
      keep === (reopened === true)
    )
      return;
    remember({
      ...rest,
      seen,
      viewed,
      ...(done ? { doneSeen: true as const } : {}),
      ...(shown ? { planShown: true as const } : {}),
      ...(keep ? { reopened: true as const } : {}),
    });
  }, [pending, operationId, restoring, stage, live, viewing, doneSeen, planShown]);

  /** Opens a step for looking, or the live step for null; any note was for the old one. */
  const look = (step: CopyStepId | null) => {
    setNote(null);
    setView(step === null || step === live ? null : { step, operationId });
  };
  // Locked while closing would interrupt a step or a reopen is checked; otherwise passed
  // steps and the way back.
  const stepDisabled = (id: CopyStepId) =>
    closeLocked ||
    restoring !== null ||
    id === viewing ||
    !(id === live ? viewing !== null : isStepAfter(live, id) && revisitable(id));
  // Back looks at the nearest earlier step that has something to show; Where always does.
  const backFrom = (from: CopyStepId) => {
    const to = copyStepList(mode).findLast((id) => isStepAfter(from, id) && revisitable(id));
    return to ? () => look(to) : null;
  };
  /** Checks a reopened copy: the bar holds the step last seen until the destination answers. */
  const armRestore = (saved: PendingCopy) => {
    setView(null);
    setNote(null);
    setUnreachable(false);
    // A copy cancelled while measuring only tells the source again; it shows the setup form.
    setRestoring(saved.cancelled ? null : saved);
  };
  /** Stops waiting for a reopened copy's destination: the dialog moves on without it. */
  const dropRestore = () => {
    setRestoring(null);
    setUnreachable(false);
  };
  /** Retry ran a failed copy again from measuring: What says so, so it is not a reset. */
  const restarted = () => setNote({ text: RESTARTED, live: "what", view: null, operationId: null });

  return {
    live,
    steps,
    viewing,
    planShown,
    checking,
    note:
      note && note.operationId === operationId && note.live === live && note.view === viewing
        ? note.text
        : null,
    look,
    stepDisabled,
    backFrom,
    armRestore,
    dropRestore,
    restarted,
  };
}
