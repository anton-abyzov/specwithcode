import * as DateTime from "effect/DateTime";
import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import type { WorkLogEntry } from "../../session-logic";

/**
 * After this long without a turn-item change the live row stops saying
 * "Thinking": the app only knows nothing new has arrived.
 */
export const LIVE_ACTIVITY_QUIET_MS = 60_000;

type ActivityItem = Pick<OrchestrationV2TurnItem, "runId" | "updatedAt"> &
  Partial<Pick<OrchestrationV2TurnItem, "startedAt" | "completedAt">>;

export interface RunLiveSignal {
  /** The newest persisted change to any item of the run: the last provider event seen. */
  lastActivityMs: number;
  /**
   * When the current step began: the latest item start or finish. A streaming
   * thought keeps its start, so "Thinking" counts from it, not from each token.
   */
  phaseStartedMs: number;
}

/** What the run's own items say about liveness; null when none are loaded. Never the client clock. */
export function runLiveSignal(
  items: ReadonlyArray<ActivityItem>,
  runId: string | null,
): RunLiveSignal | null {
  if (runId === null) return null;
  let lastActivityMs: number | null = null;
  let phaseStartedMs: number | null = null;
  for (const item of items) {
    if (String(item.runId ?? "") !== runId) continue;
    const updatedMs = DateTime.toEpochMillis(item.updatedAt);
    if (!Number.isFinite(updatedMs)) continue;
    if (lastActivityMs === null || updatedMs > lastActivityMs) lastActivityMs = updatedMs;
    const boundary = item.completedAt ?? item.startedAt;
    const boundaryMs = boundary ? DateTime.toEpochMillis(boundary) : updatedMs;
    if (phaseStartedMs === null || boundaryMs > phaseStartedMs) phaseStartedMs = boundaryMs;
  }
  if (lastActivityMs === null || phaseStartedMs === null) return null;
  return { lastActivityMs, phaseStartedMs: Math.min(phaseStartedMs, lastActivityMs) };
}

/** When the step the live row names began: the provider's own start time. */
export function liveStepStartedAtMs(entry: WorkLogEntry): number | null {
  const startedAt = entry.structuredPayload?.startedAt;
  const ms = startedAt ? DateTime.toEpochMillis(startedAt) : Date.parse(entry.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

export function quietForMs(lastActivityMs: number | null, nowMs: number): number | null {
  if (lastActivityMs === null) return null;
  return Math.max(0, nowMs - lastActivityMs);
}

export function isQuiet(lastActivityMs: number | null, nowMs: number): boolean {
  const quiet = quietForMs(lastActivityMs, nowMs);
  return quiet !== null && quiet >= LIVE_ACTIVITY_QUIET_MS;
}

/** "8s", "4m", "1h 12m": short enough for a trailing chip. */
export function formatActivityDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function toolCallCountLabel(count: number): string {
  return `${count} ${count === 1 ? "call" : "calls"}`;
}
