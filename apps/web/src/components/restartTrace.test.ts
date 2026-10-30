import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginRestartPress,
  currentRestartPress,
  markRestartStep,
  resetRestartTrace,
} from "./restartTrace";

describe("restart to update trace", () => {
  afterEach(() => {
    resetRestartTrace();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gives a press one run id and clock, and sends each step with both", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-30T12:00:00.000Z") });
    const markRestartTrace = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { markRestartTrace } });
    const press = beginRestartPress();
    expect(press.runId).toMatch(/^[0-9a-f-]{36}$/);
    const startedAt = Date.now();
    vi.advanceTimersByTime(1_500);
    markRestartStep("feed-check", { startedAt, detail: "skipped: checked recently" });
    expect(markRestartTrace.mock.calls).toEqual([
      [{ runId: press.runId, t0: press.t0, phase: "press", at: press.t0 }],
      [
        {
          runId: press.runId,
          t0: press.t0,
          phase: "feed-check",
          at: press.t0 + 1_500,
          ms: 1_500,
          detail: "skipped: checked recently",
        },
      ],
    ]);
    // A new press starts its own clock.
    const next = beginRestartPress("idle wait came due");
    expect(next.runId).not.toBe(press.runId);
    expect(currentRestartPress()).toEqual(next);
  });

  it("sends nothing before a press, or to a desktop without the trace", () => {
    const markRestartTrace = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { markRestartTrace } });
    markRestartStep("prepare");
    expect(markRestartTrace).not.toHaveBeenCalled();
    vi.stubGlobal("window", { desktopBridge: {} });
    beginRestartPress();
    markRestartStep("prepare");
    expect(currentRestartPress()).not.toBeNull();
  });

  it("never fails the press when the desktop refuses a mark", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { markRestartTrace: vi.fn(async () => Promise.reject(new Error("gone"))) },
    });
    expect(() => beginRestartPress()).not.toThrow();
    await Promise.resolve();
  });
});
