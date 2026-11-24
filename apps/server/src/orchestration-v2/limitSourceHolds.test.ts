import { ProviderInstanceId, RunId, ThreadId } from "@specweave-studio/contracts";
import { fallbackSelectionKey } from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  heldSourceKeys,
  LIMIT_FALLBACK_MAX_HOPS,
  LIMIT_SOURCE_BACKOFF_MS,
  limitChainParked,
  limitFallbackChains,
  limitSourceHolds,
  NO_LIMIT_SOURCE_HOLDS,
} from "./limitSourceHolds.ts";

const now = Date.parse("2026-11-24T15:14:00.000Z");
const cursorId = ProviderInstanceId.make("cursor");
const neon = { instanceId: cursorId, model: "gemini-4-neon" };
const grok = { instanceId: cursorId, model: "grok-5" };

const stop = (overrides: Record<string, unknown> = {}) => ({
  id: ThreadId.make("t1"),
  providerInstanceId: cursorId,
  modelSelection: neon,
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  usageLimitResetAt: null as string | null,
  latestRunId: RunId.make("r1"),
  latestRunStartedAt: DateTime.makeUnsafe(now - 2_000),
  latestRunCompletedAt: DateTime.makeUnsafe(now),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  ...overrides,
});

describe("limitSourceHolds", () => {
  const none = NO_LIMIT_SOURCE_HOLDS;
  const completedAt = (startedAt: number) =>
    stop({
      status: "completed",
      lastErrorClass: null,
      latestRunStartedAt: DateTime.makeUnsafe(startedAt),
      latestRunCompletedAt: DateTime.makeUnsafe(startedAt + 4_000),
    });

  it("holds the exact source until the reset the stop names", () => {
    const resetAt = "2026-12-01T00:00:00.000Z";
    const holds = limitSourceHolds(none, [stop({ usageLimitResetAt: resetAt })], now);
    expect(holds.held.get(fallbackSelectionKey(neon))?.until).toBe(Date.parse(resetAt));
    // Another model on the same instance is not held.
    expect(heldSourceKeys(holds, now).has(fallbackSelectionKey(grok))).toBe(false);
    expect(heldSourceKeys(holds, Date.parse(resetAt) - 1).size).toBe(1);
  });

  it("backs off for an hour when the stop names no reset, then lets go", () => {
    const holds = limitSourceHolds(none, [stop()], now);
    expect(heldSourceKeys(holds, now + LIMIT_SOURCE_BACKOFF_MS - 1).size).toBe(1);
    expect(limitSourceHolds(holds, [], now + LIMIT_SOURCE_BACKOFF_MS).held.size).toBe(0);
  });

  it("outlives the stopped thread and is shared by every thread", () => {
    const holds = limitSourceHolds(none, [stop()], now);
    const moved = stop({ modelSelection: grok, status: "running", lastErrorClass: null });
    expect(heldSourceKeys(limitSourceHolds(holds, [moved], now + 60_000), now).size).toBe(1);
  });

  it("ends when a run on that source starts after the stop and completes", () => {
    const holds = limitSourceHolds(none, [stop()], now);
    expect(limitSourceHolds(holds, [completedAt(now - 10_000)], now + 1_000).held.size).toBe(1);
    expect(limitSourceHolds(holds, [completedAt(now + 5_000)], now + 10_000).held.size).toBe(0);
  });

  it("never brings back a hold from a stop older than the source's recovery", () => {
    const old = stop();
    const released = limitSourceHolds(
      limitSourceHolds(none, [old], now),
      [completedAt(now + 5_000)],
      now + 10_000,
    );
    // The thread that recovered is gone (archived); the old stop is still swept.
    expect(limitSourceHolds(released, [old], now + 20_000).held.size).toBe(0);
    // A newer stop holds again.
    const newer = stop({ latestRunCompletedAt: DateTime.makeUnsafe(now + 30_000) });
    expect(limitSourceHolds(released, [newer], now + 31_000).held.size).toBe(1);
  });
});

describe("limitFallbackChains", () => {
  const threads = new Set(["t1"]);
  const auto = (from: string) => `limit-fallback:t1:${from}`;
  /** Stops on r1..rN, each run after the first started by the sweep's continuation of the one before. */
  const stops = (count: number) => {
    let chains = new Map() as ReturnType<typeof limitFallbackChains>;
    for (let run = 1; run <= count; run++)
      chains = limitFallbackChains(
        chains,
        [
          {
            threadId: "t1",
            runId: `r${run}`,
            startMessageId: run === 1 ? "m1" : auto(`r${run - 1}`),
          },
        ],
        threads,
      );
    return chains;
  };

  it("parks once the cap's automatic hops have all stopped", () => {
    expect(stops(LIMIT_FALLBACK_MAX_HOPS).get("t1")?.hops).toBe(LIMIT_FALLBACK_MAX_HOPS - 1);
    expect(limitChainParked(stops(LIMIT_FALLBACK_MAX_HOPS).get("t1"))).toBe(false);
    expect(limitChainParked(stops(LIMIT_FALLBACK_MAX_HOPS + 1).get("t1"))).toBe(true);
  });

  it("counts a stop seen on several sweeps once", () => {
    const once = stops(2);
    const again = limitFallbackChains(
      once,
      [{ threadId: "t1", runId: "r2", startMessageId: auto("r1") }],
      threads,
    );
    expect(again.get("t1")?.hops).toBe(1);
  });

  it("never counts stops a person started", () => {
    let chains = new Map() as ReturnType<typeof limitFallbackChains>;
    for (let run = 1; run <= 8; run++)
      chains = limitFallbackChains(
        chains,
        [{ threadId: "t1", runId: `r${run}`, startMessageId: `person-${run}` }],
        threads,
      );
    expect(limitChainParked(chains.get("t1"))).toBe(false);
  });

  it("starts over after any run the sweep did not continue, and drops threads no longer swept", () => {
    const parked = stops(LIMIT_FALLBACK_MAX_HOPS + 1);
    const restarted = limitFallbackChains(
      parked,
      [{ threadId: "t1", runId: "r99", startMessageId: "person" }],
      threads,
    );
    expect(restarted.get("t1")?.hops).toBe(0);
    expect(limitFallbackChains(parked, [], new Set()).size).toBe(0);
  });
});
