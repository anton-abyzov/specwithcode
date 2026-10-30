import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  markRestartStep,
  pressAt,
  RESTART_TRACE_TTL_MS,
  recordWindowMark,
  resetRestartTrace,
  restartTraceFields,
} from "./restartTrace.ts";

const T0 = Date.parse("2026-10-30T12:00:00.000Z");

describe("restart to update trace", () => {
  afterEach(() => resetRestartTrace());

  it("writes each step with its time since the press", () => {
    expect(
      restartTraceFields({
        runId: "press-1",
        t0: T0,
        phase: "feed-check",
        at: T0 + 1_234.4,
        ms: 812.6,
        detail: "skipped",
      }),
    ).toEqual({
      runId: "press-1",
      phase: "feed-check",
      elapsedMs: 1_234,
      at: "2026-10-30T12:00:01.234Z",
      ms: 813,
      detail: "skipped",
    });
    expect(restartTraceFields({ runId: "p", t0: T0, phase: "press", at: T0 })).toEqual({
      runId: "p",
      phase: "press",
      elapsedMs: 0,
      at: "2026-10-30T12:00:00.000Z",
    });
  });

  it.effect("main's own steps belong to the latest press, only while it is recent", () =>
    Effect.gen(function* () {
      expect(pressAt(T0)).toBeNull();
      yield* TestClock.setTime(T0);
      // Nothing to time without a press: a no-op.
      yield* markRestartStep("quit-and-install");
      yield* recordWindowMark({ runId: "press-1", t0: T0, phase: "press", at: T0 });
      expect(pressAt(T0 + 5_000)).toEqual({ runId: "press-1", t0: T0 });
      yield* recordWindowMark({
        runId: "press-2",
        t0: T0 + 10_000,
        phase: "press",
        at: T0 + 10_000,
      });
      expect(pressAt(T0 + 10_000)?.runId).toBe("press-2");
      expect(pressAt(T0 + 10_000 + RESTART_TRACE_TTL_MS + 1)).toBeNull();
      yield* markRestartStep("verified-observed", { detail: "run-1" });
    }),
  );
});
