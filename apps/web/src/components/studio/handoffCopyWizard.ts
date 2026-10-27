import type {
  FolderCopyMode,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { copyProblem } from "./handoffCopyNotices";
import type { CopyStage } from "./handoffCopySteps";

/**
 * The folder copy as a wizard: fixed steps per mode, which of them the copy is at, which
 * earlier ones can be looked at again, and where a reopened dialog lands. Pure: the
 * component owns the state, this only answers questions about it.
 */
export type CopyStepId = "where" | "what" | "review" | "copy" | "transfer" | "done";

export const COPY_STEP_IDS: ReadonlyArray<CopyStepId> = [
  "where",
  "what",
  "review",
  "copy",
  "transfer",
  "done",
];

export const COPY_STEP_LABELS: Readonly<Record<CopyStepId, string>> = {
  where: "Where",
  what: "What",
  review: "Review",
  copy: "Copy",
  transfer: "Transfer",
  done: "Done",
};

export const isCopyStepId = (value: unknown): value is CopyStepId =>
  typeof value === "string" && (COPY_STEP_IDS as ReadonlyArray<string>).includes(value);

const order = (id: CopyStepId) => COPY_STEP_IDS.indexOf(id);

/** True when `a` comes after `b` in the copy. */
export const isStepAfter = (a: CopyStepId, b: CopyStepId) => order(a) > order(b);

/** The later of two steps; the furthest a copy has been seen at. */
export const laterStep = (a: CopyStepId, b: CopyStepId) => (isStepAfter(a, b) ? a : b);

/** Where › What › Review › Copy › Done, with Transfer for a move. Only the mode changes it. */
export function copyStepList(mode: FolderCopyMode): ReadonlyArray<CopyStepId> {
  return mode === "copy-and-move" ? COPY_STEP_IDS : COPY_STEP_IDS.filter((id) => id !== "transfer");
}

interface ProgressInput {
  readonly stage: CopyStage;
  readonly mode: FolderCopyMode;
  readonly contextTransferred: boolean;
}

/** The step the copy is at. A finished move stays on Transfer until context transferred. */
export function progressStep({ stage, mode, contextTransferred }: ProgressInput): CopyStepId {
  switch (stage) {
    case "setup":
      return "where";
    case "scanning":
    case "select":
      return "what";
    case "planning":
    case "preview":
      return "review";
    case "copying":
    case "failed":
      return "copy";
    case "moving":
      return "transfer";
    case "done":
      return mode === "copy-and-move" && !contextTransferred ? "transfer" : "done";
    case "undone":
      return "done";
  }
}

export type CopyStepTone = "failed" | "held" | "attention";

/**
 * How the live step is marked: a failure, a held move, or a move whose files are copied
 * while coordinator context still waits. Other steps, and a copy going fine, get none.
 */
export function stepTone(
  id: CopyStepId,
  input: ProgressInput & { readonly held: boolean },
): CopyStepTone | null {
  if (id !== progressStep(input)) return null;
  if (input.stage === "failed") return input.held ? "held" : "failed";
  if (input.stage === "done" && id === "transfer") return "attention";
  return null;
}

/** Destination states that carry a compared plan. */
const PLANNED: ReadonlySet<FolderCopyStatus["state"]> = new Set([
  "previewed",
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
  "undone",
]);

export interface RevisitInput {
  readonly summary: FolderCopySourceSummary | null;
  readonly copy: Pick<FolderCopyStatus, "state" | "rows"> | null;
  readonly contextTransferred: boolean;
}

/**
 * Whether an earlier step has what its review shows: Where always, What once measured,
 * Review once compared, Copy once there is a copy, Transfer once context moved.
 */
export function canRevisit(id: CopyStepId, { summary, copy, contextTransferred }: RevisitInput) {
  switch (id) {
    case "where":
      return true;
    case "what":
      return summary !== null;
    case "review":
      return copy !== null && (copy.rows.length > 0 || PLANNED.has(copy.state));
    case "copy":
      return copy !== null;
    case "transfer":
      return contextTransferred;
    case "done":
      // Done is the last step: it is only ever live, never behind the copy.
      return false;
  }
}

export type CopyEditAction =
  | "change-where"
  | "save-folder"
  | "rechoose"
  | "start-new-with-settings";

export interface EditInput {
  readonly stage: CopyStage;
  readonly copy: Pick<FolderCopyStatus, "state"> | null;
  readonly failedBeforeApply: boolean;
  readonly transferRecovery: boolean;
}

/**
 * Nothing is written to the destination yet: the same stages where Cancel copy is offered.
 * Changing anything here costs a measure or a compare, never files on the destination.
 */
export function beforeApply({
  stage,
  copy,
  failedBeforeApply,
}: Omit<EditInput, "transferRecovery">) {
  switch (stage) {
    case "scanning":
    case "select":
    case "planning":
    case "preview":
      return true;
    case "copying":
      return copy?.state !== "applying" && copy?.state !== "applied";
    case "failed":
      return failedBeforeApply;
    default:
      return false;
  }
}

/**
 * The one change a review of `id` offers, or null. Before Apply, Where cancels the copy
 * (or only saves the folder while choosing, since the destination has not started) and
 * What measures again. After Apply the copy is read-only; Where can start a new copy with
 * the same settings once it finished or was undone, unless a coordinator transfer needs
 * recovering. A copy that failed or is held after Apply offers none: dropping it would
 * orphan a partly applied folder, so Retry or Undo on the live step come first.
 */
export function editActionFor(id: CopyStepId, input: EditInput): CopyEditAction | null {
  const { stage } = input;
  if (beforeApply(input)) {
    if (id === "where") return stage === "select" ? "save-folder" : "change-where";
    // What is live while measuring and choosing; it is only reviewed from later steps.
    if (id === "what" && stage !== "scanning" && stage !== "select") return "rechoose";
    return null;
  }
  const settled = stage === "done" || stage === "undone";
  if (id === "where" && settled && !input.transferRecovery) return "start-new-with-settings";
  return null;
}

/**
 * Where a reopened dialog lands, once the destination answered. The step that was on
 * screen comes back when the copy is still where it was; anything that moved on while the
 * window was closed shows live with a note. A failure, a held move or an Undo is always
 * shown live. A pointer saved before steps were remembered behaves as before.
 */
export function restoredView(input: {
  readonly viewed: CopyStepId | undefined;
  readonly seen: CopyStepId | undefined;
  readonly live: CopyStepId;
  readonly stage: CopyStage;
  readonly revisitable: (id: CopyStepId) => boolean;
}): { readonly view: CopyStepId | null; readonly note: boolean } {
  const { viewed, seen, live, stage } = input;
  if (seen === undefined) return { view: null, note: false };
  const movedOn = isStepAfter(live, seen);
  if (movedOn || stage === "failed" || stage === "undone") return { view: null, note: movedOn };
  if (viewed !== undefined && isStepAfter(live, viewed) && input.revisitable(viewed))
    return { view: viewed, note: false };
  return { view: null, note: false };
}

/** "42% copied", from the destination's progress; null before it counts bytes. */
function copiedShare(copy: Pick<FolderCopyStatus, "progress"> | null) {
  const progress = copy?.progress;
  if (!progress || progress.bytesTotal <= 0) return null;
  const share = Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100));
  return `${share}% copied.`;
}

/**
 * What happened while the window was closed, for a copy that moved past the step last
 * seen. Null when nothing moved on.
 */
export function resumeNote(input: {
  readonly seen: CopyStepId | undefined;
  readonly live: CopyStepId;
  readonly stage: CopyStage;
  readonly copy: Pick<
    FolderCopyStatus,
    "state" | "progress" | "error" | "checks" | "unstable"
  > | null;
  readonly held: boolean;
  readonly sourceLabel: string;
}): string | null {
  const { seen, live, stage, copy } = input;
  if (seen === undefined || !isStepAfter(live, seen)) return null;
  switch (stage) {
    case "select":
      return "Measuring finished while the window was closed. Choose what to copy.";
    case "planning":
      return "Measuring finished while the window was closed. Comparing has started.";
    case "preview":
      return "Comparing finished while the window was closed. Check what would change.";
    case "copying": {
      const share = copiedShare(copy);
      const started =
        seen === "review"
          ? "Copying started while the window was closed."
          : "Comparing finished and nothing would be replaced, so copying started.";
      return share ? `${started} ${share}` : started;
    }
    case "failed": {
      if (input.held) {
        const problem = copy ? copyProblem(copy, input.sourceLabel) : null;
        return `This move is held: ${problem ?? "a check failed"}.`;
      }
      const message = copy?.error?.message.trim().replace(/\.$/, "");
      return message ? `This copy stopped: ${message}.` : "This copy stopped.";
    }
    case "done":
      return live === "transfer"
        ? "The files finished copying while the window was closed. Coordinator context has not transferred yet."
        : "This copy finished while the window was closed.";
    case "undone":
      return copy?.state === "cancelled"
        ? "This copy was cancelled while the window was closed."
        : "This copy was undone while the window was closed.";
    default:
      return null;
  }
}
