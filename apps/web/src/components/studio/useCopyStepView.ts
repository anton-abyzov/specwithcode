import { useEffect, useState, type RefObject } from "react";
import type { FolderCopyMode, FolderCopyStatus } from "@specweave-studio/contracts";
import type { CopyStage } from "./handoffCopySteps";
import type { PendingCopy } from "./handoffFolderCopyPending";
import type { CopyStepItem } from "./HandoffCopyGuide";
import {
  COPY_STEP_LABELS,
  copyStepList,
  isStepAfter,
  laterStep,
  progressStep,
  resumeNote,
  stepTone,
  type CopyStepId,
} from "./handoffCopyWizard";

/** A reopened copy while its destination answers, or after it could not be reached. */
export type CopyChecking = "checking" | "unreachable" | null;

const RESTARTED = "Retry started this copy again from the beginning.";

/**
 * Which step of the folder copy is live, for the step line. It remembers the furthest step
 * seen in the pointer, and after a reopen says what happened while the window was closed.
 */
export function useCopyStepView({
  stage,
  mode,
  auto,
  contextTransferred,
  copy,
  held,
  errored = false,
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
  readonly copy: FolderCopyStatus | null;
  readonly held: boolean;
  /** An error is shown for the live step: the bar marks it stopped. */
  readonly errored?: boolean;
  readonly working: boolean;
  readonly pending: PendingCopy | null;
  readonly latestPending: RefObject<PendingCopy | null>;
  readonly remember: (value: PendingCopy) => void;
  readonly sourceLabel: string;
  /** Done is live for a committed copy-only copy with nothing left to fix or link. */
  readonly doneReached: boolean;
}) {
  // The copy whose compared plan the person saw, so its Review was not skipped automatically.
  const [planShownFor, setPlanShownFor] = useState<string | null>(null);
  // The reopened pointer whose step comes back once the destination answers.
  const [restoring, setRestoring] = useState<PendingCopy | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // Said once above the step of the copy it was written for.
  // A restart's note waits (operationId null) for the copy the restart begins.
  const [note, setNote] = useState<{
    readonly text: string;
    readonly live: CopyStepId;
    readonly operationId: string | null;
  } | null>(null);

  const operationId = pending?.operationId ?? null;
  const stepInput = { stage, mode, contextTransferred };
  const live = progressStep(stepInput);
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

  // The check ends the first time the stage leaves setup, not when the run ends: a
  // one-click copy can poll until it finishes.
  if (restoring && stage !== "setup") {
    setRestoring(null);
    setUnreachable(false);
    const seen = restoring.seen;
    // A failure, a held move or an Undo always shows live; the note says what moved on.
    if (restoring.operationId === operationId && seen !== undefined && isStepAfter(live, seen)) {
      const text = resumeNote({ seen, live, stage, copy, held, sourceLabel });
      if (text) setNote({ text, live, operationId });
    }
  } else if (restoring && !working && !unreachable) {
    // The check ended on setup: the destination did not answer, or the copy was dropped.
    if (operationId === restoring.operationId) setUnreachable(true);
    else setRestoring(null);
  }

  const checking: CopyChecking = restoring ? (unreachable ? "unreachable" : "checking") : null;
  // While checking, the line shows the step last seen.
  const shown = restoring ? (restoring.seen ?? live) : live;
  const steps: ReadonlyArray<CopyStepItem> = copyStepList(mode).map((id) => {
    const behind = isStepAfter(shown, id);
    return {
      id,
      label: COPY_STEP_LABELS[id],
      state: behind ? "done" : id === shown ? "current" : "next",
      // One click skips choosing, and comparing too when the plan replaced nothing.
      skipped: auto && (id === "what" || (id === "review" && !planShown)),
      tone: restoring ? null : stepTone(id, { ...stepInput, held, errored: errored && !working }),
    };
  });

  // Saves how far the copy got. Only changed values are written, onto the newest pointer of
  // the same copy: a write on every render would loop, and a stale one would undo a
  // concurrent Replace everything or Move anyway. A pointer on setup is being checked or cancelled.
  useEffect(() => {
    const saved = latestPending.current;
    if (!saved || saved.cancelled || restoring || stage === "setup") return;
    if (saved.operationId !== operationId) return;
    const seen = saved.seen ? laterStep(saved.seen, live) : live;
    const done = doneReached || saved.doneSeen === true;
    const shown = planShown || saved.planShown === true;
    // An undone copy is no longer one to keep as the last copy.
    const { reopened, ...rest } = saved;
    const keep = reopened === true && stage !== "undone";
    if (
      seen === saved.seen &&
      done === (saved.doneSeen === true) &&
      shown === (saved.planShown === true) &&
      keep === (reopened === true)
    )
      return;
    remember({
      ...rest,
      seen,
      ...(done ? { doneSeen: true as const } : {}),
      ...(shown ? { planShown: true as const } : {}),
      ...(keep ? { reopened: true as const } : {}),
    });
  }, [pending, operationId, restoring, stage, live, doneReached, planShown]);

  /** Checks a reopened copy: the line holds the step last seen until the destination answers. */
  const armRestore = (saved: PendingCopy) => {
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
  const restarted = () => setNote({ text: RESTARTED, live: "what", operationId: null });

  return {
    live,
    steps,
    planShown,
    checking,
    note: note && note.operationId === operationId && note.live === live ? note.text : null,
    armRestore,
    dropRestore,
    restarted,
  };
}
