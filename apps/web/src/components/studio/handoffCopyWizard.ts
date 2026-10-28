import type { FolderCopyMode, FolderCopyStatus } from "@specweave-studio/contracts";
import { copyProblem } from "./handoffCopyNotices";
import type { CopyStage } from "./handoffCopySteps";

/**
 * The folder copy as a wizard: fixed steps per mode, which of them the copy is at, and
 * what a reopened dialog says happened while it was closed. Pure: the component owns the
 * state, this only answers questions about it.
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
  input: ProgressInput & { readonly held: boolean; readonly errored?: boolean },
): CopyStepTone | null {
  if (id !== progressStep(input)) return null;
  if (input.stage === "failed") return input.held ? "held" : "failed";
  // A refused start or step (an error in the footer) stopped here; trying again is fine.
  if (input.errored) return "failed";
  if (input.stage === "done" && id === "transfer") return "attention";
  return null;
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
        ? "The files finished copying while the window was closed. The coordinator has not moved yet."
        : "This copy finished while the window was closed.";
    case "undone":
      return copy?.state === "cancelled"
        ? "This copy was cancelled while the window was closed."
        : "This copy was undone while the window was closed.";
    default:
      return null;
  }
}
