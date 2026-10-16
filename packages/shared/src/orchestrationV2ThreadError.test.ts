import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE,
  LIVE_THREAD_ERROR_WINDOW_MS,
  providerFailureDisplayMessage,
  providerFailureFallbackMessage,
  threadErrorIsLive,
  threadErrorSummary,
  timelineFailureIsHistory,
} from "./orchestrationV2ThreadError.ts";

const NOW = Date.parse("2026-10-15T21:00:00.000Z");
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const minutesAgo = (minutes: number) => isoAt(NOW - minutes * 60_000);

describe("threadErrorSummary", () => {
  const failure = {
    class: "provider_error",
    message: "Turn failed upstream.",
    code: null,
    retryable: null,
  } as const;

  it("keeps a session error while the latest run failed", () => {
    expect(threadErrorSummary(failure, "Session crashed.", "failed").lastError).toBe(
      "Session crashed.",
    );
  });

  it("drops a session error left over from before a completed run", () => {
    const summary = threadErrorSummary(null, "Provider runtime failed.", "completed");
    expect(summary.lastError).toBeNull();
    expect(summary.lastErrorClass).toBeNull();
  });

  it("drops a session error after a cancelled run", () => {
    expect(threadErrorSummary(null, "Provider runtime failed.", "cancelled").lastError).toBeNull();
  });

  it("keeps the previous behaviour when the run status is unknown", () => {
    expect(threadErrorSummary(null, "Session crashed.").lastError).toBe("Session crashed.");
  });
});

describe("threadErrorIsLive", () => {
  it("shows an error from a turn that just failed", () => {
    expect(threadErrorIsLive({ errorAt: minutesAgo(2), settled: false, nowMs: NOW })).toBe(true);
  });

  it("shows an error whose run has not ended", () => {
    expect(threadErrorIsLive({ errorAt: null, settled: false, nowMs: NOW })).toBe(true);
  });

  it("hides an error from days ago", () => {
    expect(
      threadErrorIsLive({ errorAt: "2026-10-12T12:39:19.995Z", settled: false, nowMs: NOW }),
    ).toBe(false);
  });

  it("hides an error just past the live window", () => {
    const errorAt = isoAt(NOW - LIVE_THREAD_ERROR_WINDOW_MS - 1);
    expect(threadErrorIsLive({ errorAt, settled: false, nowMs: NOW })).toBe(false);
  });

  it("hides any error on a resolved thread", () => {
    expect(threadErrorIsLive({ errorAt: minutesAgo(1), settled: true, nowMs: NOW })).toBe(false);
    expect(threadErrorIsLive({ errorAt: null, settled: true, nowMs: NOW })).toBe(false);
  });
});

describe("timelineFailureIsHistory", () => {
  const base = { runId: "run:1", latestRunId: "run:1", settled: false, nowMs: NOW };

  it("keeps the latest run's fresh failure prominent", () => {
    expect(timelineFailureIsHistory({ ...base, occurredAt: minutesAgo(5) })).toBe(false);
  });

  it("treats a failure a later run superseded as history", () => {
    expect(
      timelineFailureIsHistory({ ...base, latestRunId: "run:2", occurredAt: minutesAgo(1) }),
    ).toBe(true);
  });

  it("treats an old failure as history", () => {
    expect(timelineFailureIsHistory({ ...base, occurredAt: minutesAgo(3 * 24 * 60) })).toBe(true);
  });

  it("treats every failure on a resolved thread as history", () => {
    expect(timelineFailureIsHistory({ ...base, settled: true, occurredAt: minutesAgo(1) })).toBe(
      true,
    );
  });
});

describe("providerFailureDisplayMessage", () => {
  it("replaces the legacy generic message with its class's explanation", () => {
    expect(
      providerFailureDisplayMessage({
        class: "transport_error",
        message: LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE,
      }),
    ).toBe(providerFailureFallbackMessage("transport_error"));
  });

  it("keeps a real provider message", () => {
    expect(
      providerFailureDisplayMessage({ class: "provider_error", message: "Model not supported." }),
    ).toBe("Model not supported.");
  });

  it("never falls back to the generic text", () => {
    for (const failureClass of [
      "usage_limit",
      "provider_error",
      "transport_error",
      "permission_error",
      "validation_error",
      "unknown",
    ] as const) {
      expect(providerFailureFallbackMessage(failureClass)).not.toBe(
        LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE,
      );
    }
  });
});
