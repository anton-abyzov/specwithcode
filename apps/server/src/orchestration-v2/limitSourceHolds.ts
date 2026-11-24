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

import { epochMs, fallbackMove, LIMIT_STOP_MAX_AGE_MS } from "./providerOpenFailure.ts";
import type { FallbackThread } from "./unopenableFallback.ts";

/** How long a source that refused with no reset time is held (D-01). */
export const LIMIT_SOURCE_BACKOFF_MS = 60 * 60_000;

/** Automatic limit hops in one chain before the thread parks on its card (D-02). */
export const LIMIT_FALLBACK_MAX_HOPS = 4;

/** Sources remembered as recovered, at most; the oldest go first. */
const MAX_RECOVERED_SOURCES = 256;

/** One held source: until when, and the stop that set it. */
export interface LimitSourceHold {
  readonly until: number;
  readonly stoppedAt: number;
}

/**
 * Held sources, keyed by `fallbackSelectionKey` (instance and model), and when
 * each source last took work again: a stop from before that says nothing now.
 */
export interface LimitSourceHolds {
  readonly held: ReadonlyMap<string, LimitSourceHold>;
  readonly recoveredAt: ReadonlyMap<string, number>;
}

export const NO_LIMIT_SOURCE_HOLDS: LimitSourceHolds = { held: new Map(), recoveredAt: new Map() };

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
 * source started after its stop and completed, and drops expired holds. A
 * stop older than the source's latest recovery never holds it again, so an
 * old stopped thread cannot bring back a hold a later run cleared.
 * `threads` carry the latest run's own source (see `usageHoldEvidence`); the
 * caller leaves out simulated stops and plan limits that no longer bind.
 */
export function limitSourceHolds(
  previous: LimitSourceHolds,
  threads: ReadonlyArray<FallbackThread>,
  nowMs: number,
  /**
   * Whether a usage read the source took after `stoppedAt` shows room for
   * that exact model, on a provider whose reads can be trusted for it (see
   * `readReleasesHold`). Such a read releases the hold.
   */
  readShowsRoom: (key: string, stoppedAt: number) => boolean = () => false,
): LimitSourceHolds {
  const recoveredAt = new Map(previous.recoveredAt);
  for (const thread of threads) {
    if (thread.status !== "completed") continue;
    const startedMs = epochMs(thread.latestRunStartedAt);
    if (!Number.isFinite(startedMs)) continue;
    const key = fallbackSelectionKey(thread.modelSelection);
    if (startedMs > (recoveredAt.get(key) ?? Number.NEGATIVE_INFINITY)) {
      recoveredAt.delete(key);
      recoveredAt.set(key, startedMs);
    }
  }
  while (recoveredAt.size > MAX_RECOVERED_SOURCES)
    recoveredAt.delete(recoveredAt.keys().next().value!);
  const held = new Map(previous.held);
  for (const thread of threads) {
    if (!stoppedOnLimit(thread) || !stopIsCurrent(thread, nowMs)) continue;
    const stoppedAt = epochMs(thread.latestRunCompletedAt);
    if (!Number.isFinite(stoppedAt)) continue;
    const key = fallbackSelectionKey(thread.modelSelection);
    if (stoppedAt <= (recoveredAt.get(key) ?? Number.NEGATIVE_INFINITY)) continue;
    const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
    const until =
      Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : stoppedAt + LIMIT_SOURCE_BACKOFF_MS;
    const before = held.get(key);
    held.set(key, {
      until: Math.max(before?.until ?? 0, until),
      stoppedAt: Math.max(before?.stoppedAt ?? 0, stoppedAt),
    });
  }
  for (const [key, hold] of held) {
    // Only a run started after the stop shows the source took work again.
    const recovered = recoveredAt.get(key);
    if (hold.until <= nowMs || (recovered !== undefined && recovered > hold.stoppedAt)) {
      held.delete(key);
    } else if (readShowsRoom(key, hold.stoppedAt)) {
      held.delete(key);
      // The read answers this stop and any before it: an old stop still swept
      // never holds the source again.
      recoveredAt.delete(key);
      recoveredAt.set(key, hold.stoppedAt);
    }
  }
  return { held, recoveredAt };
}

/** The keys held at `nowMs`. */
export function heldSourceKeys(holds: LimitSourceHolds, nowMs: number): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, hold] of holds.held) if (hold.until > nowMs) keys.add(key);
  return keys;
}

/** A stop the sweep saw: its run, and the message that started that run. */
export interface LimitChainStop {
  readonly threadId: string;
  readonly runId: string;
  readonly startMessageId: string | null;
}

/** One thread's latest stop and how many automatic limit continuations led to it. */
export interface LimitChain {
  readonly lastRunId: string;
  readonly hops: number;
}

/**
 * Counts each thread's automatic limit continuations in a row. A stop on a run
 * the sweep's own `limit-fallback:` continuation of the previous stop started
 * (directly, or after a target that could not open) adds one hop; any other run (a person's message, a manual continue, a reset
 * resume, a turn after one that completed) starts over at zero. A stop seen on
 * several sweeps counts once. Threads no longer swept are dropped.
 */
export function limitFallbackChains(
  previous: ReadonlyMap<string, LimitChain>,
  stops: ReadonlyArray<LimitChainStop>,
  sweptThreadIds: ReadonlySet<string>,
): ReadonlyMap<string, LimitChain> {
  const next = new Map<string, LimitChain>();
  for (const [threadId, chain] of previous)
    if (sweptThreadIds.has(threadId)) next.set(threadId, chain);
  for (const stop of stops) {
    const chain = next.get(stop.threadId);
    if (chain?.lastRunId === stop.runId) continue;
    // `limit-fallback:<thread>:hop-N:<stop>` is the same continuation after a
    // target that could not open: it still answers that stop.
    const move =
      stop.startMessageId == null ? null : fallbackMove(stop.threadId, stop.startMessageId);
    const continuedFrom = move?.fromLimit === true ? move.runId : null;
    const hops =
      continuedFrom === null ? 0 : continuedFrom === chain?.lastRunId ? chain.hops + 1 : 1;
    next.set(stop.threadId, { lastRunId: stop.runId, hops });
  }
  return next;
}

/**
 * The chain has made its automatic hops and every one stopped on a limit: the
 * stop that would start one more parks instead.
 */
export function limitChainParked(chain: LimitChain | undefined): boolean {
  return chain !== undefined && chain.hops >= LIMIT_FALLBACK_MAX_HOPS;
}

/**
 * Drivers whose usage read covers each model exactly: the maker's own harness
 * (Claude Code reads per-model weeklies, Codex limits are account-wide). A
 * reseller (Copilot, Cursor, Devin, an ACP agent) can refuse one model while
 * its account read still shows room, so only its own refusal counts there.
 */
const MODEL_EXACT_READ_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function readReleasesHold(driver: string): boolean {
  return MODEL_EXACT_READ_DRIVERS.has(driver);
}
