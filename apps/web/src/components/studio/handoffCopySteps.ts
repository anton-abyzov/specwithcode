import type {
  FolderCopySourceStatus,
  FolderCopyStatus,
  MachineHandoffBusyThreads,
  MachineHandoffSourceChanges,
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

/**
 * One plain sentence for the few stages that need it: choosing file types, and a copy that
 * stopped. Working stages show one progress line instead; Review and Done say it in their
 * own title and helper.
 */
export function nextStepText(input: {
  readonly stage: CopyStage;
  readonly auto: boolean;
  readonly targetLabel: string;
  readonly approveLabel: string;
  readonly failedBeforeApply: boolean;
  /** A move held after Apply because checks failed: the coordinator stayed on the source. */
  readonly held?: boolean;
  /** A move says move, not copy: the person is moving the project. */
  readonly move?: boolean;
}): string | null {
  const machine = input.targetLabel;
  const action = input.move ? "move" : "copy";
  switch (input.stage) {
    case "select":
      return input.auto
        ? `${input.approveLabel} compares with ${machine}'s folder again and continues. Nothing is replaced without asking.`
        : `Preview compares with ${machine}'s folder. Nothing is written until you approve.`;
    case "failed":
      if (input.held)
        return `Copy again brings over what changed; it compares first and moves only changed files. Move anyway moves the coordinator with these differences. Undo puts ${machine}'s folder back.`;
      // Before Apply the destination cannot resume: Retry runs the same copy from measuring.
      if (input.failedBeforeApply)
        return `Retry starts the ${action} again: ${input.auto ? "it measures and compares again, then copies unless it needs you" : "it measures again, then you choose what to copy and preview it"}. Nothing on ${machine} changed, so Stop ${action} leaves it as it was.`;
      return `Retry continues where the ${action} stopped.`;
    default:
      return null;
  }
}

const files = (value: number) => `${value.toLocaleString()} ${value === 1 ? "file" : "files"}`;

/**
 * The one progress line while a copy works: Measuring… → Comparing with {machine}… →
 * Copying {size}…, or what a re-compare after a choice is doing.
 */
export function workingLine(input: {
  readonly stage: CopyStage;
  readonly targetLabel: string;
  readonly measured: FolderCopySourceStatus["progress"];
  readonly copy: FolderCopyStatus | null;
  readonly recompare: CopyRecompare;
}): string | null {
  const { stage, targetLabel, measured, copy } = input;
  switch (stage) {
    case "scanning":
      return measured ? measuringText(measured) : "Measuring…";
    case "planning":
      if (input.recompare === "choices") return "Comparing again with your choices…";
      if (input.recompare === "replace-all")
        return "Comparing again, then copying with every conflict replaced…";
      if (input.recompare === "replace-kept")
        return "Comparing again, then copying with your choices kept and the rest replaced…";
      return `Comparing with ${targetLabel}…`;
    case "copying": {
      const step = copy
        ? {
            verifying: "Checking copied files…",
            applying: "Applying to the folder…",
            applied: "Registering the folder…",
          }[copy.state as "verifying" | "applying" | "applied"]
        : undefined;
      if (step) return step;
      const bytes = copy?.progress?.bytesTotal || copy?.totals?.bytesToMove || null;
      return bytes ? `Copying ${formatBytes(bytes)}…` : "Copying…";
    }
    case "moving":
      return `Starting the coordinator on ${targetLabel}…`;
    default:
      return null;
  }
}

/** "Measuring… 1,204 files, 3 MB" while listing; the source's own step once it moves on. */
function measuringText(progress: SourceProgress): string {
  return progress.step && progress.step !== "listing"
    ? sourceProgressText(progress, "")
    : `Measuring… ${files(progress.files)}, ${formatBytes(progress.bytes)}`;
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
  const on = sourceLabel ? ` on ${sourceLabel}` : "";
  switch (progress.step) {
    case "checking-worktrees":
      return "Checking worktrees for uncommitted changes…";
    case "git-snapshot":
      return `Copying Git data${on}… ${formatBytes(progress.bytes)}`;
    case "hashing":
      return progress.totalFiles
        ? `Reading the selected files${on}… ${progress.files.toLocaleString()} of ${files(progress.totalFiles)}${progress.totalBytes ? `, ${formatBytes(progress.bytes)} of ${formatBytes(progress.totalBytes)}` : ""}`
        : `Reading the selected files${on}… ${files(progress.files)}, ${formatBytes(progress.bytes)}`;
    default:
      return `Measuring… ${files(progress.files)}, ${formatBytes(progress.bytes)}`;
  }
}

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;

/** The source's list of paths that changed after copying, when a newer source sent one. */
const changesOf = (cause: unknown): MachineHandoffSourceChanges | null => {
  const changes =
    typeof cause === "object" && cause !== null
      ? (cause as { changes?: unknown }).changes
      : undefined;
  return typeof changes === "object" &&
    changes !== null &&
    typeof (changes as MachineHandoffSourceChanges).digest === "string" &&
    typeof (changes as MachineHandoffSourceChanges).total === "number" &&
    Array.isArray((changes as MachineHandoffSourceChanges).rows)
    ? (changes as MachineHandoffSourceChanges)
    : null;
};

const BUSY_REASONS = new Set([
  "running",
  "waiting_for_answer",
  "waiting_for_sign_in",
  "pending_approval",
  "provider_session",
  "pending_effect",
]);

/** The threads a newer machine named in its busy refusal; null from an older one. */
export const busyThreadsOf = (cause: unknown): MachineHandoffBusyThreads | null => {
  const busy =
    typeof cause === "object" && cause !== null ? (cause as { busy?: unknown }).busy : undefined;
  if (typeof busy !== "object" || busy === null) return null;
  const { total, threads } = busy as { total?: unknown; threads?: unknown };
  if (typeof total !== "number" || !Array.isArray(threads)) return null;
  const named = threads.filter(
    (thread): thread is MachineHandoffBusyThreads["threads"][number] =>
      typeof thread === "object" &&
      thread !== null &&
      typeof thread.threadId === "string" &&
      typeof thread.title === "string" &&
      typeof thread.projectId === "string" &&
      BUSY_REASONS.has(thread.reason),
  );
  return named.length > 0 ? { total: Math.max(total, named.length), threads: named } : null;
};

/** The named threads of a busy refusal, or null for any other error or an older machine. */
export const refusedBusyOf = (cause: unknown): MachineHandoffBusyThreads | null =>
  codeOf(cause) === "busy" ? busyThreadsOf(cause) : null;

/** Which machine's threads hold the move, and which ones. */
export interface TransferBusy {
  readonly on: "source" | "destination";
  readonly busy: MachineHandoffBusyThreads;
}

/** The sentence that goes with a named list: what to do about the threads below. */
export const BUSY_NEXT_STEP =
  "Answer or close each question, or stop the work, then try again. A move waits for them because it would drop a question still waiting for you.";

const threadsText = (value: number) =>
  value === 1 ? "A thread is" : `${value.toLocaleString()} threads are`;

const paths = (value: number) => `${value.toLocaleString()} ${value === 1 ? "path" : "paths"}`;

/**
 * What a refused coordinator transfer leaves: its notice, whether the recovery pointer
 * stays (the request may have fenced the source), whether Copy again is the answer
 * (null leaves that as it was) and, from a newer source, exactly which paths changed.
 * `published` is true once context reached the destination.
 */
export function transferRefusal(
  cause: unknown,
  published: boolean,
  targetLabel: string,
  sourceLabel: string,
): {
  readonly notice: string;
  readonly recovery: boolean;
  readonly copyAgain: boolean | null;
  readonly changes?: MachineHandoffSourceChanges;
  /** The threads that keep a machine busy, when it named them. */
  readonly busy?: TransferBusy;
} {
  if (cause instanceof DestinationContextPreviewError) {
    const busy = codeOf(cause.cause) === "busy" ? busyThreadsOf(cause.cause) : null;
    if (busy)
      return {
        notice: `${threadsText(busy.total)} still working or waiting for you on ${targetLabel}, so the coordinator stayed on ${sourceLabel}. ${BUSY_NEXT_STEP}`,
        recovery: false,
        copyAgain: null,
        busy: { on: "destination", busy },
      };
    // No publish was attempted. Starting fresh still asks the source to release the
    // operation, so a fence from an older session cannot be lost.
    return {
      notice: `${targetLabel} is not ready for the coordinator: ${cause.message} Try again, or start a new copy to update ${targetLabel}.`,
      recovery: false,
      copyAgain: null,
    };
  }
  if (codeOf(cause) === "busy" && !published) {
    const busy = busyThreadsOf(cause);
    // Older sources name no threads: the plain notice stays.
    return busy
      ? {
          notice: `${threadsText(busy.total)} still working or waiting for you on ${sourceLabel}, so the coordinator stayed there. ${BUSY_NEXT_STEP}`,
          recovery: false,
          copyAgain: null,
          busy: { on: "source", busy },
        }
      : {
          notice: `Work is still running on ${sourceLabel}, so the coordinator stayed there. Move it once that work is idle.`,
          recovery: false,
          copyAgain: null,
        };
  }
  if (codeOf(cause) === "busy" && published) {
    // Once published, the source answers from its saved bundle without an idle check: a
    // busy refusal now comes from starting on the destination. The fence stays held.
    const busy = busyThreadsOf(cause);
    if (busy)
      return {
        notice: `${threadsText(busy.total)} still working or waiting for you on ${targetLabel}, so the coordinator hasn't started there yet. ${BUSY_NEXT_STEP}`,
        recovery: true,
        copyAgain: false,
        busy: { on: "destination", busy },
      };
  }
  if (codeOf(cause) === "source_changed" && !published) {
    const changes = changesOf(cause);
    // Older sources send no list: Copy again stays the only answer.
    return changes && changes.total > 0
      ? {
          notice: `${paths(changes.total)} changed on ${sourceLabel} after copying.`,
          recovery: false,
          copyAgain: true,
          changes,
        }
      : {
          notice: `${sourceLabel} changed after copying. Copy again before moving the coordinator.`,
          recovery: false,
          copyAgain: true,
        };
  }
  return {
    notice: `Moving the coordinator didn't finish: ${messageOf(cause)}`,
    recovery: true,
    copyAgain: false,
  };
}
