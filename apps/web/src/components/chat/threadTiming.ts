import type {
  RunAwaitingPerson,
  RunHealth,
} from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import { presentPendingBackgroundWork } from "@specweave-studio/client-runtime/state/thread-execution";

/** Use the same settled-turn gate as the composer's background-work strip. */
export function threadTimingBackground(
  tasks: Parameters<typeof presentPendingBackgroundWork>[0],
  isWorking: boolean,
  hasActiveThread: boolean,
) {
  const pending = presentPendingBackgroundWork(!isWorking && hasActiveThread ? tasks : []);
  return pending === null
    ? null
    : { label: pending.title, waiting: pending.waiting, kind: pending.kind };
}

/** Recorded app turns, not provider-session age or measured active work. */
export interface ThreadTimingRun {
  readonly id?: string;
  readonly runId?: string;
  readonly status?: string;
  readonly queueHeld?: boolean | undefined;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}
export interface ThreadTimingInput {
  readonly run: ThreadTimingRun | null;
  readonly recordedRuns?: readonly ThreadTimingRun[] | undefined;
  readonly historyComplete?: boolean;
  readonly nowMs: number;
  readonly awaitingPerson?: RunAwaitingPerson | null;
  readonly health?: RunHealth | null;
  readonly background?: {
    readonly label: string;
    readonly waiting: boolean;
    readonly kind?: string;
  } | null;
}
const LIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const millis = (value: string | null) => (value === null ? NaN : Date.parse(value));
const identity = (run: ThreadTimingRun) => run.runId ?? run.id;

export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "Unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Union valid recorded spans. Never extend an unknown terminal end to now. */
export function deriveThreadTiming(input: ThreadTimingInput) {
  const records = new Map<string, ThreadTimingRun>();
  for (const [index, run] of (input.recordedRuns ?? []).entries()) {
    records.set(identity(run) ?? `record:${index}`, run);
  }
  const currentId = input.run === null ? undefined : identity(input.run);
  const historyMatch = currentId === undefined ? undefined : records.get(currentId);
  const run = input.run === null ? null : { ...historyMatch, ...input.run };
  if (run !== null) records.set(currentId ?? "current", run);
  if (run === null && records.size === 0 && !input.background) return null;
  const live =
    run !== null &&
    run.completedAt === null &&
    (run.status === undefined ? Number.isFinite(millis(run.startedAt)) : LIVE.has(run.status));
  const span = (record: ThreadTimingRun, current: boolean): [number, number] | null => {
    if (record.status === "queued") return null;
    const start = millis(record.startedAt);
    const end = current && live ? input.nowMs : millis(record.completedAt);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [start, end] : null;
  };
  const currentSpan = run === null ? null : span(run, true);
  const elapsedMs = currentSpan === null ? null : currentSpan[1] - currentSpan[0];
  const intervals: [number, number][] = [];
  let timedCount = 0;
  for (const [key, record] of records) {
    const measured = span(record, run !== null && key === (currentId ?? "current"));
    if (measured !== null) {
      intervals.push(measured);
      timedCount++;
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let recordedMs = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of intervals) {
    recordedMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  const duration = elapsedMs === null ? null : formatRunDuration(elapsedMs);
  let state: "running" | "waiting" | "done" | "queued" | "unknown" = live ? "running" : "done";
  let label = duration === null ? "Last turn · timing unknown" : `Last turn ${duration}`;
  if (run?.status === "failed")
    label = duration === null ? "Failed turn" : `Failed · ${duration} elapsed`;
  else if (run?.status === "interrupted" || run?.status === "cancelled")
    label = duration === null ? "Stopped" : `Stopped · ${duration} elapsed`;
  else if (!live && input.background) {
    state = "waiting";
    label = input.background.waiting
      ? input.background.kind === "monitor"
        ? "Watching"
        : "Background wait"
      : "Background task";
  } else if (live) {
    if (run?.status === "queued") {
      state = "queued";
      label = run.queueHeld ? "Queue held" : "Queued";
    } else if (run?.startedAt === null)
      label = run.status === "preparing" ? "Preparing" : "Starting";
    else if (input.awaitingPerson) {
      state = "waiting";
      label = "Waiting on you";
    } else if (input.health?.state === "stalled") {
      state = "waiting";
      label = "No recent progress";
    } else {
      state =
        input.health?.state === "waiting" || run?.status === "waiting" ? "waiting" : "running";
      const prefix = state === "waiting" ? "Waiting" : "Running";
      label = duration === null ? prefix : `${prefix} · ${duration} elapsed`;
    }
  } else if (run === null) {
    state = "unknown";
    label = "Turn timing";
  }
  return {
    label,
    state,
    live,
    elapsedMs,
    recordedMs: intervals.length ? recordedMs : null,
    timedCount,
    recordedCount: records.size,
    partial: input.historyComplete !== true,
    notStarted: live && run?.startedAt === null,
    statusDetail:
      input.health?.state === "waiting" ? input.health.label : (input.background?.label ?? null),
  };
}
