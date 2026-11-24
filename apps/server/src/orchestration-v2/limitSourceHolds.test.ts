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
  it("holds the exact source until the reset the stop names", () => {
    const resetAt = "2026-12-01T00:00:00.000Z";
    const holds = limitSourceHolds(new Map(), [stop({ usageLimitResetAt: resetAt })], now);
    expect(holds.get(fallbackSelectionKey(neon))?.until).toBe(Date.parse(resetAt));
    // Another model on the same instance is not held.
    expect(heldSourceKeys(holds, now).has(fallbackSelectionKey(grok))).toBe(false);
    expect(heldSourceKeys(holds, Date.parse(resetAt) - 1).size).toBe(1);
  });

  it("backs off for an hour when the stop names no reset, then lets go", () => {
    const holds = limitSourceHolds(new Map(), [stop()], now);
    expect(heldSourceKeys(holds, now + LIMIT_SOURCE_BACKOFF_MS - 1).size).toBe(1);
    expect(limitSourceHolds(holds, [], now + LIMIT_SOURCE_BACKOFF_MS).size).toBe(0);
  });

  it("outlives the stopped thread and is shared by every thread", () => {
    const holds = limitSourceHolds(new Map(), [stop()], now);
    const moved = stop({ modelSelection: grok, status: "running", lastErrorClass: null });
    expect(heldSourceKeys(limitSourceHolds(holds, [moved], now + 60_000), now).size).toBe(1);
  });

  it("ends when a run on that source starts after the stop and completes", () => {
    const holds = limitSourceHolds(new Map(), [stop()], now);
    const before = stop({
      status: "completed",
      lastErrorClass: null,
      latestRunStartedAt: DateTime.makeUnsafe(now - 10_000),
    });
    expect(limitSourceHolds(holds, [before], now + 1_000).size).toBe(1);
    const after = stop({
      status: "completed",
      lastErrorClass: null,
      latestRunStartedAt: DateTime.makeUnsafe(now + 5_000),
      latestRunCompletedAt: DateTime.makeUnsafe(now + 9_000),
    });
    expect(limitSourceHolds(holds, [after], now + 10_000).size).toBe(0);
  });
});

describe("limitFallbackChains", () => {
  const stops = (count: number, gapMs = 7_000) => {
    let chains = new Map() as ReturnType<typeof limitFallbackChains>;
    for (let run = 1; run <= count; run++)
      chains = limitFallbackChains(
        chains,
        [
          stop({
            latestRunId: RunId.make(`r${run}`),
            latestRunCompletedAt: DateTime.makeUnsafe(now + run * gapMs),
          }),
        ],
        now + run * gapMs,
      );
    return chains;
  };

  it("parks the stop after the last allowed hop", () => {
    expect(limitChainParked(stops(LIMIT_FALLBACK_MAX_HOPS).get("t1"))).toBe(false);
    expect(limitChainParked(stops(LIMIT_FALLBACK_MAX_HOPS + 1).get("t1"))).toBe(true);
  });

  it("counts a stop seen on several sweeps once", () => {
    const once = stops(1);
    const again = limitFallbackChains(once, [stop()], now + 30_000);
    expect(again.get("t1")?.runIds.size).toBe(1);
  });

  it("starts over after a completed run or a quiet backoff", () => {
    const parked = stops(LIMIT_FALLBACK_MAX_HOPS + 1);
    const done = limitFallbackChains(parked, [stop({ status: "completed" })], now);
    expect(done.has("t1")).toBe(false);
    expect(
      limitChainParked(stops(LIMIT_FALLBACK_MAX_HOPS + 1, LIMIT_SOURCE_BACKOFF_MS).get("t1")),
    ).toBe(false);
  });
});
