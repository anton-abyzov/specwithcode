import type {
  FolderCopyMode,
  FolderCopySourceStatus,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { formatBytes } from "../../studio/folderCopy";
import type { ReplaceAllOutcome } from "./handoffFolderCopyPending";
import { DestinationContextPreviewError, messageOf } from "./useCoordinatorTransfer";

export type CopyStage =
  | "setup"
  | "scanning"
  | "select"
  | "planning"
  | "preview"
  | "copying"
  | "moving"
  | "done"
  | "undone"
  | "failed";

/**
 * Why the destination is comparing again: a per-item choice, or Replace all that will copy
 * once nothing is open ("replace-kept" when some items keep the destination's version).
 * Null for the first compare.
 */
export type CopyRecompare = "choices" | "replace-all" | "replace-kept" | null;

/** The re-compare a Replace all click leads to; a pointer from before outcomes were kept copies. */
export function recompareFor(outcome: ReplaceAllOutcome | undefined): CopyRecompare {
  return outcome === "ask" ? "choices" : outcome === "copy-kept" ? "replace-kept" : "replace-all";
}

/** One plain sentence saying what the next click, or the wait, does. */
export function nextStepText(input: {
  readonly stage: CopyStage;
  readonly auto: boolean;
  readonly mode: FolderCopyMode;
  readonly targetLabel: string;
  readonly sourceLabel: string;
  /** A pointer from an earlier session that has not been checked again yet. */
  readonly unfinished: boolean;
  /** A copy cancelled while measuring whose source has not confirmed dropping it. */
  readonly cancelledPending?: boolean;
  readonly bytes: number | null;
  /** "3 files", when the preview would replace something. */
  readonly replaced: string | null;
  readonly approveLabel: string;
  readonly failedBeforeApply: boolean;
  /** A move held after Apply because checks failed: the coordinator stayed on the source. */
  readonly held?: boolean;
  readonly contextTransferred: boolean;
  readonly copyAgain: boolean;
  readonly secretFiles: number;
  /** "4 more conflicts in app still need a choice.", when Replace all leaves some open. */
  readonly replaceLeft?: string | null;
  readonly recompare?: CopyRecompare;
}): string | null {
  const machine = input.targetLabel;
  const move = input.mode === "copy-and-move";
  // What one-click copying stops for; anything it cannot rule out also stops it.
  const stops = `It stops for you first if files on ${machine} would be replaced, a branch there would move, or ${machine} is short of disk space.`;
  switch (input.stage) {
    case "setup":
      if (input.cancelledPending)
        return `Tells ${input.sourceLabel} again to drop the cancelled copy. Nothing is copied.`;
      if (input.unfinished)
        return `Checks the unfinished copy on ${machine} and continues where it stopped.`;
      return input.auto
        ? `Measures the folder, then copies it to ${machine}. Nothing on ${machine} is replaced without asking.${move ? ` Then transfers coordinator context if work on ${input.sourceLabel} is idle; otherwise you retry once it is.` : ""}`
        : `Measures the folder, then you choose what to copy. Nothing is written to ${machine} until you approve.`;
    case "scanning":
      return input.auto
        ? `When measuring finishes, copying starts on its own. ${stops} You can close this window; you'll get a notice when it's done.`
        : "When measuring finishes, you choose what to copy. You can close this window; you'll get a notice.";
    case "select":
      return input.auto
        ? `${input.approveLabel} compares with ${machine}'s folder again and continues. Nothing is replaced without asking.`
        : `Preview compares with ${machine}'s folder. Nothing is written until you approve.`;
    case "planning":
      // Only the first automatic compare copies on its own; a choice shows the plan again.
      if (input.recompare === "choices") return "Comparing again with your choices…";
      if (input.recompare === "replace-all")
        return "Comparing again, then copying with every conflict replaced.";
      if (input.recompare === "replace-kept")
        return "Comparing again, then copying with every other conflict replaced and your choices kept.";
      return input.auto
        ? `Copying starts on its own when comparing finishes. ${stops} You can close this window.`
        : "You see what would change before anything is written. You can close this window.";
    case "preview":
      if (input.replaced && input.replaceLeft)
        return `Replace all takes ${input.sourceLabel}'s version of what it can and does not copy yet. ${input.replaceLeft} Answer them with an “All” choice below, then Copy with these choices.`;
      if (input.replaced)
        return `Replace all starts copying now. To keep some of ${machine}'s versions, choose per item below, then Copy with these choices.`;
      return `Copying starts when you click ${input.approveLabel}.${input.secretFiles > 0 ? " Secret files stay here unless you tick them." : ""}`;
    case "copying":
      return `Copying${input.bytes ? ` ${formatBytes(input.bytes)}` : " the files"}. You can close this window; you'll get a notice when it's done.`;
    case "moving":
      return `Starting the coordinator on ${machine}. Keep this window open until it finishes.`;
    case "failed":
      if (input.held)
        return `Copy again to bring over what changed; it compares first and moves only changed files. Move anyway transfers coordinator context with these differences; Undo puts ${machine}'s folder back.`;
      // Before Apply the destination cannot resume: Retry runs the same copy from measuring.
      if (input.failedBeforeApply)
        return `Retry starts the copy again: ${input.auto ? "it measures and compares again, then copies unless it needs you" : "it measures again, then you choose what to copy and preview it"}. Nothing on ${machine} changed, so Cancel copy leaves it as it was.`;
      return "Retry continues where the copy stopped.";
    case "done":
      if (move && !input.contextTransferred)
        return input.copyAgain
          ? "Copy again to include the latest changes, then transfer coordinator context."
          : `Transfer coordinator context when work on ${input.sourceLabel} is idle.`;
      if (move) return `Open the project on ${machine} to continue there.`;
      return input.copyAgain
        ? "Copy again to bring over what changed since; it compares first and moves only changed files."
        : `Open the copy on ${machine}, or close this window. Undo stays available for 14 days.`;
    case "undone":
      return "Start a new copy whenever you are ready.";
  }
}

/** Closing the dialog leaves these running on the machines; reopening resumes them. */
export const CLOSABLE_WHILE_WORKING: ReadonlySet<CopyStage> = new Set([
  "setup",
  "scanning",
  "planning",
  "copying",
]);

/** The step a destination's copy status puts the dialog on; a cancelled copy reads as undone. */
export function stageForStatus(next: FolderCopyStatus): CopyStage {
  if (next.state === "previewed") return "preview";
  if (next.state === "failed") return "failed";
  if (next.state === "undone" || next.state === "cancelled") return "undone";
  if (next.state === "applied" && next.committed && next.projectId) return "done";
  return "copying";
}

type SourceProgress = NonNullable<FolderCopySourceStatus["progress"]>;

/** What the source is doing right now, from its progress; older sources only count files. */
export function sourceProgressText(progress: SourceProgress, sourceLabel: string): string {
  const files = (value: number) => `${value.toLocaleString()} ${value === 1 ? "file" : "files"}`;
  switch (progress.step) {
    case "checking-worktrees":
      return "Checking worktrees for uncommitted changes…";
    case "git-snapshot":
      return `Copying Git data on ${sourceLabel}… ${formatBytes(progress.bytes)}`;
    case "hashing":
      return progress.totalFiles
        ? `Reading the selected files on ${sourceLabel}… ${progress.files.toLocaleString()} of ${files(progress.totalFiles)}${progress.totalBytes ? `, ${formatBytes(progress.bytes)} of ${formatBytes(progress.totalBytes)}` : ""}`
        : `Reading the selected files on ${sourceLabel}… ${files(progress.files)}, ${formatBytes(progress.bytes)}`;
    default:
      return `Measuring the folder… ${files(progress.files)}, ${formatBytes(progress.bytes)}`;
  }
}

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;

/**
 * What a refused coordinator transfer leaves: its notice, whether the recovery pointer
 * stays (the request may have fenced the source) and whether Copy again is the answer
 * (null leaves that as it was). `published` is true once context reached the destination.
 */
export function transferRefusal(
  cause: unknown,
  published: boolean,
  targetLabel: string,
  sourceLabel: string,
): { readonly notice: string; readonly recovery: boolean; readonly copyAgain: boolean | null } {
  if (cause instanceof DestinationContextPreviewError)
    // No publish was attempted. Starting fresh still asks the source to release the
    // operation, so a fence from an older session cannot be lost.
    return {
      notice: `The files are copied. ${targetLabel} is not ready for coordinator context: ${cause.message} Retry this step, or start a new copy to update the destination.`,
      recovery: false,
      copyAgain: null,
    };
  if (codeOf(cause) === "busy" && !published)
    return {
      notice: `The files are copied. Work is still running on ${sourceLabel}, so coordinator context has not transferred. Retry this step when that work is idle.`,
      recovery: false,
      copyAgain: null,
    };
  if (codeOf(cause) === "source_changed" && !published)
    return {
      notice:
        "The files are copied, but the source has changed. Copy again before transferring coordinator context.",
      recovery: false,
      copyAgain: true,
    };
  return {
    notice: `The files are copied. Coordinator context transfer is pending: ${messageOf(cause)}`,
    recovery: true,
    copyAgain: false,
  };
}
