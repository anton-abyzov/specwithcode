import type { FolderCopySourceStatus, FolderCopyStatus } from "@specweave-studio/contracts";
import { formatBytes, formatDuration } from "./folderCopy";

/**
 * One model of a running copy for every place that shows it: the dialog, the project's
 * banner and the sidebar row. A copy runs in three phases, each named by the machine
 * doing the work: Measure on the source, Send to the destination, Apply there.
 */

export type CopyPhase = "measure" | "send" | "apply";
export const COPY_PHASES: ReadonlyArray<CopyPhase> = ["measure", "send", "apply"];

export type CopyOutcome = "running" | "finished" | "failed";

export interface CopyCounts {
  readonly done: number;
  /** Null while the total is still being counted. */
  readonly total: number | null;
}

export interface CopyProgressView {
  readonly phase: CopyPhase;
  /** What is happening now, in a few words: "Sending files to m5". */
  readonly step: string;
  /** 0 to 1 within the phase when it can say how far it is; null otherwise. */
  readonly fraction: number | null;
  readonly bytes: CopyCounts | null;
  readonly files: CopyCounts | null;
  /** Bytes already on the destination, which count as done without being sent. */
  readonly bytesLocal: number;
  /**
   * Speed is measured within one step: a new key restarts it, so reading files on the
   * source does not set the pace for sending them.
   */
  readonly rateKey: string | null;
  readonly outcome: CopyOutcome;
}

/** A phase as two parts: what happens, and on which machine ("Send", "to m5"). */
export const phaseParts = (
  phase: CopyPhase,
  source: string,
  target: string,
): readonly [verb: string, place: string] =>
  phase === "measure"
    ? ["Measure", `on ${source}`]
    : phase === "send"
      ? ["Send", `to ${target}`]
      : ["Apply", `on ${target}`];

export const phaseLabel = (phase: CopyPhase, source: string, target: string): string =>
  phaseParts(phase, source, target).join(" ");

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ratio = (done: number, total: number | null | undefined) =>
  total && total > 0 ? clamp(done / total) : null;

type SourceProgress = NonNullable<FolderCopySourceStatus["progress"]>;

/** What the source is doing while it measures and reads the folder. */
export function sourceProgressView(
  progress: SourceProgress | null | undefined,
  sourceLabel: string,
): CopyProgressView {
  const base = { phase: "measure" as const, bytesLocal: 0, outcome: "running" as const };
  if (!progress)
    return {
      ...base,
      step: `Measuring the folder on ${sourceLabel}`,
      fraction: null,
      bytes: null,
      files: null,
      rateKey: null,
    };
  switch (progress.step) {
    case "checking-worktrees":
      return {
        ...base,
        step: "Checking worktrees for uncommitted changes",
        fraction: null,
        bytes: null,
        files: null,
        rateKey: null,
      };
    case "git-snapshot":
      return {
        ...base,
        step: `Packing Git history on ${sourceLabel}`,
        fraction: null,
        bytes: { done: progress.bytes, total: null },
        files: null,
        rateKey: "measure:git",
      };
    case "hashing":
      return {
        ...base,
        step: `Reading files on ${sourceLabel}`,
        fraction:
          ratio(progress.bytes, progress.totalBytes) ?? ratio(progress.files, progress.totalFiles),
        bytes: { done: progress.bytes, total: progress.totalBytes ?? null },
        files: { done: progress.files, total: progress.totalFiles ?? null },
        rateKey: "measure:hashing",
      };
    default:
      return {
        ...base,
        step: `Measuring the folder on ${sourceLabel}`,
        fraction: null,
        bytes: { done: progress.bytes, total: null },
        files: { done: progress.files, total: null },
        rateKey: "measure:listing",
      };
  }
}

/** What the destination's status says; null when it waits for the person or ended undone. */
export function statusProgressView(
  status: FolderCopyStatus,
  sourceLabel: string,
  targetLabel: string,
): CopyProgressView | null {
  const progress = status.progress;
  const counts = progress
    ? {
        bytes: { done: progress.bytesDone, total: progress.bytesTotal },
        files: { done: progress.filesDone, total: progress.filesTotal },
        bytesLocal: progress.bytesLocal,
      }
    : { bytes: null, files: null, bytesLocal: 0 };
  const running = { outcome: "running" as const };
  switch (status.state) {
    case "planned":
    case "scanning":
      return comparingProgressView(targetLabel);
    case "approved":
      return { ...startingSendView(targetLabel), ...counts };
    case "transferring": {
      if (!progress || progress.phase === "manifest")
        return {
          ...running,
          phase: "send",
          step: `Reading the file list from ${sourceLabel}`,
          fraction: null,
          bytes: null,
          files: null,
          bytesLocal: 0,
          rateKey: null,
        };
      return {
        ...running,
        phase: "send",
        step: `Sending files to ${targetLabel}`,
        fraction:
          ratio(progress.bytesDone, progress.bytesTotal) ??
          ratio(progress.filesDone, progress.filesTotal),
        ...counts,
        rateKey: "send:files",
      };
    }
    case "verifying":
      return {
        ...running,
        phase: "send",
        step: `Checking files on ${targetLabel}`,
        // Until the check reports its own counts, the send's finished counts would read 100%.
        fraction:
          progress?.phase === "verify"
            ? (ratio(progress.filesDone, progress.filesTotal) ??
              ratio(progress.bytesDone, progress.bytesTotal))
            : null,
        ...counts,
        rateKey: "send:verify",
      };
    case "applying":
      return {
        ...running,
        phase: "apply",
        step: `Putting files in place on ${targetLabel}`,
        fraction:
          progress?.phase === "apply" ? ratio(progress.filesDone, progress.filesTotal) : null,
        ...(progress?.phase === "apply" ? counts : { bytes: null, files: null, bytesLocal: 0 }),
        rateKey: null,
      };
    case "applied": {
      const finished = status.committed && status.projectId !== null;
      const totals = status.totals;
      return {
        phase: "apply",
        step: finished ? `Copied to ${targetLabel}` : `Adding the project on ${targetLabel}`,
        fraction: 1,
        bytes: totals ? { done: totals.bytesToMove, total: totals.bytesToMove } : null,
        files: totals ? { done: totals.filesToMove, total: totals.filesToMove } : null,
        bytesLocal: 0,
        rateKey: null,
        outcome: finished ? "finished" : "running",
      };
    }
    case "failed": {
      const phase = failedPhase(status);
      // How far the stopped phase got, when its counts belong to it: the red fill ends there.
      const reached =
        phase === "send" && progress?.phase === "files"
          ? (ratio(progress.bytesDone, progress.bytesTotal) ??
            ratio(progress.filesDone, progress.filesTotal))
          : null;
      return {
        phase,
        step: "Stopped",
        fraction: reached,
        bytes: null,
        files: null,
        bytesLocal: 0,
        rateKey: null,
        outcome: "failed",
      };
    }
    default:
      return null;
  }
}

/** The phase a copy stopped in, by the step it failed at; older machines name no step. */
function failedPhase(status: FolderCopyStatus): CopyPhase {
  switch (status.failedStep) {
    case "planned":
    case "scanning":
    case "previewed":
      return "measure";
    case "approved":
    case "transferring":
    case "verifying":
      return "send";
    case "applying":
    case "applied":
      return "apply";
    default:
      return status.progress?.phase === "apply" ? "apply" : status.progress ? "send" : "measure";
  }
}

/** The destination comparing its folder with the source's list, the end of Measure. */
export function comparingProgressView(
  targetLabel: string,
  /** What a re-compare after a choice does instead. */
  step?: string | null,
): CopyProgressView {
  return {
    phase: "measure",
    step: step ?? `Comparing with ${targetLabel}`,
    fraction: null,
    bytes: null,
    files: null,
    bytesLocal: 0,
    rateKey: null,
    outcome: "running",
  };
}

/** Approved, before the destination reports its first files. */
export function startingSendView(targetLabel: string): CopyProgressView {
  return {
    phase: "send",
    step: `Starting to send to ${targetLabel}`,
    fraction: null,
    bytes: null,
    files: null,
    bytesLocal: 0,
    rateKey: null,
    outcome: "running",
  };
}

/** The coordinator starting on the destination: the last step of a move. */
export function movingProgressView(targetLabel: string): CopyProgressView {
  return {
    phase: "apply",
    step: `Starting the coordinator on ${targetLabel}`,
    fraction: null,
    bytes: null,
    files: null,
    bytesLocal: 0,
    rateKey: null,
    outcome: "running",
  };
}

/** "2.1 GB of 7.5 GB", "34,210 of 121,868 files"; a count without a total reads as so far. */
export function countsText(view: Pick<CopyProgressView, "bytes" | "files">): {
  readonly bytes: string | null;
  readonly files: string | null;
} {
  const bytes = view.bytes
    ? view.bytes.total !== null && view.bytes.total > 0
      ? `${formatBytes(view.bytes.done)} of ${formatBytes(view.bytes.total)}`
      : formatBytes(view.bytes.done)
    : null;
  const fileWord = (count: number) => (count === 1 ? "file" : "files");
  const files = view.files
    ? view.files.total !== null && view.files.total > 0
      ? `${view.files.done.toLocaleString()} of ${view.files.total.toLocaleString()} ${fileWord(view.files.total)}`
      : `${view.files.done.toLocaleString()} ${fileWord(view.files.done)}`
    : null;
  return { bytes, files };
}

/** A reading of the counts at one moment, for the speed. */
export interface RateSample {
  readonly at: number;
  readonly bytes: number;
}

/** Speed is the change over the last few readings; a longer window steadies it. */
export const RATE_WINDOW_MS = 12_000;
/** Show no speed or time left before this much of a step has been watched. */
export const RATE_MIN_SPAN_MS = 3_000;
/**
 * No bytes moved for this long: stalled, so no speed. Longer than one batch takes on a slow
 * link (64 MB at 100 Mbit/s is about 5 s), so batch-sized steps do not blink the speed off.
 */
export const RATE_STALL_MS = 8_000;

/** Keeps the readings inside the window, dropping all of them when the count goes back. */
export function addRateSample(
  samples: ReadonlyArray<RateSample>,
  next: RateSample,
): ReadonlyArray<RateSample> {
  const last = samples.at(-1);
  if (last && (next.bytes < last.bytes || next.at < last.at)) return [next];
  if (last && last.bytes === next.bytes && next.at - last.at < 1_000) return samples;
  const kept = samples.filter((sample) => next.at - sample.at <= RATE_WINDOW_MS);
  return [...kept, next];
}

/** Bytes per second over the window, or null until enough of the step was watched. */
export function rateOf(samples: ReadonlyArray<RateSample>): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.at - first.at < RATE_MIN_SPAN_MS) return null;
  // Stalled: no bytes moved over the newest readings, so no speed or time left is shown.
  let flatSince = last.at;
  for (
    let index = samples.length - 2;
    index >= 0 && samples[index]!.bytes === last.bytes;
    index -= 1
  )
    flatSince = samples[index]!.at;
  if (last.at - flatSince >= RATE_STALL_MS) return null;
  const rate = ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
  return rate > 0 ? rate : null;
}

/** "48 MB/s". */
export const formatRate = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`;

/** "About 2 min 10 s left", rounded so it does not flicker; null without a speed or total. */
export function timeLeftText(view: CopyProgressView, rate: number | null): string | null {
  if (!rate || !view.bytes || view.bytes.total === null) return null;
  const left = view.bytes.total - view.bytes.done;
  if (left <= 0) return null;
  const seconds = left / rate;
  const rounded =
    seconds < 60
      ? Math.max(5, Math.ceil(seconds / 5) * 5)
      : seconds < 600
        ? Math.ceil(seconds / 10) * 10
        : Math.ceil(seconds / 60) * 60;
  return `About ${formatDuration(rounded * 1000)} left`;
}
