/**
 * What a usage-limit stop teaches the fallback sweep about the source it came
 * from, whatever that provider's usage read says (1460).
 *
 * A provider's refusal can be narrower than its account read: Copilot's
 * "monthly quota" for one model, or Cursor's "not included in your weekly
 * usage", while the account window still shows room. Trusting the read sent a
 * thread back and forth between two spent sources of one model 900 times.
 * So the exact source (instance and model) a stop came from is held until the
 * reset the stop names, or for a backoff when it names none, and an automatic
 * chain of limit hops is capped.
 *
 * @module orchestration-v2/limitSourceHolds
 */
import { fallbackSelectionKey } from "@specweave-studio/shared/providerFallback";

import { epochMs, LIMIT_STOP_MAX_AGE_MS } from "./providerOpenFailure.ts";
import type { FallbackThread } from "./unopenableFallback.ts";

/** How long a source that refused with no reset time is held (D-01). */
export const LIMIT_SOURCE_BACKOFF_MS = 60 * 60_000;

/** Automatic limit hops in one chain before the thread parks on its card (D-02). */
export const LIMIT_FALLBACK_MAX_HOPS = 4;

/** One held source: until when, and the stop that set it. */
export interface LimitSourceHold {
  readonly until: number;
  readonly stoppedAt: number;
}

/** Held sources, keyed by `fallbackSelectionKey` (instance and model). */
export type LimitSourceHolds = ReadonlyMap<string, LimitSourceHold>;

const stoppedOnLimit = (thread: FallbackThread): boolean =>
  thread.status === "failed" && thread.lastErrorClass === "usage_limit";

/** The stop still describes the source: its reset is ahead, or it is under a session window old. */
const stopIsCurrent = (thread: FallbackThread, nowMs: number): boolean => {
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  if (Number.isFinite(resetMs)) return resetMs > nowMs;
  const stoppedMs = epochMs(thread.latestRunCompletedAt);
  return Number.isFinite(stoppedMs) && nowMs - stoppedMs < LIMIT_STOP_MAX_AGE_MS;
};

/**
 * Folds the stops seen now into `previous`, releases a hold once a run on that
 * source started after its stop and completed, and drops expired holds.
 * `threads` carry the latest run's own source (see `usageHoldEvidence`).
 */
export function limitSourceHolds(
  previous: LimitSourceHolds,
  threads: ReadonlyArray<FallbackThread>,
  nowMs: number,
): LimitSourceHolds {
  const next = new Map(previous);
  for (const thread of threads) {
    if (!stoppedOnLimit(thread) || !stopIsCurrent(thread, nowMs)) continue;
    const stoppedAt = epochMs(thread.latestRunCompletedAt);
    if (!Number.isFinite(stoppedAt)) continue;
    const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
    const until =
      Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : stoppedAt + LIMIT_SOURCE_BACKOFF_MS;
    const key = fallbackSelectionKey(thread.modelSelection);
    const held = next.get(key);
    next.set(key, {
      until: Math.max(held?.until ?? 0, until),
      stoppedAt: Math.max(held?.stoppedAt ?? 0, stoppedAt),
    });
  }
  for (const thread of threads) {
    if (thread.status !== "completed") continue;
    const key = fallbackSelectionKey(thread.modelSelection);
    const held = next.get(key);
    // Only a run started after the stop shows the source took work again.
    const startedMs = epochMs(thread.latestRunStartedAt);
    if (held !== undefined && Number.isFinite(startedMs) && startedMs > held.stoppedAt)
      next.delete(key);
  }
  for (const [key, held] of next) if (held.until <= nowMs) next.delete(key);
  return next;
}

/** The keys held at `nowMs`. */
export function heldSourceKeys(holds: LimitSourceHolds, nowMs: number): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, held] of holds) if (held.until > nowMs) keys.add(key);
  return keys;
}

/** One thread's chain of consecutive limit stops: the stopped runs and the newest stop. */
export interface LimitChain {
  readonly runIds: ReadonlySet<string>;
  readonly lastStopAt: number;
}

/**
 * Counts consecutive limit stops per thread. A completed run ends the chain;
 * so does a quiet backoff since the newest stop, after which a new stop starts
 * a new chain.
 */
export function limitFallbackChains(
  previous: ReadonlyMap<string, LimitChain>,
  threads: ReadonlyArray<FallbackThread>,
  nowMs: number,
): ReadonlyMap<string, LimitChain> {
  const next = new Map(previous);
  for (const thread of threads) {
    if (thread.status === "completed") {
      next.delete(thread.id);
      continue;
    }
    if (!stoppedOnLimit(thread) || thread.latestRunId === null) continue;
    const stopAt = epochMs(thread.latestRunCompletedAt);
    const at = Number.isFinite(stopAt) ? stopAt : nowMs;
    const chain = next.get(thread.id);
    const fresh = chain === undefined || at - chain.lastStopAt >= LIMIT_SOURCE_BACKOFF_MS;
    const runIds = new Set(fresh ? [] : chain.runIds);
    runIds.add(thread.latestRunId);
    next.set(thread.id, { runIds, lastStopAt: Math.max(fresh ? 0 : chain.lastStopAt, at) });
  }
  return next;
}

/**
 * The chain has used its hops: the stop that would start one more automatic
 * hop parks instead. Stops 1..N each start a hop; stop N+1 parks.
 */
export function limitChainParked(chain: LimitChain | undefined): boolean {
  return chain !== undefined && chain.runIds.size > LIMIT_FALLBACK_MAX_HOPS;
}
