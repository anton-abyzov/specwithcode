import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";

import {
  CONTEXT_HANDOFF_TOO_LARGE_MESSAGE,
  LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE,
  LIVE_THREAD_ERROR_WINDOW_MS,
  LOCAL_STORAGE_FAILURE_CODE,
  LOCAL_STORAGE_FAILURE_MESSAGE,
  PREVIOUS_TURN_ACTIVE_FAILURE_CODE,
  PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE,
  resumableRunId,
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

  it("keeps a failed latest run's failure current however old it is", () => {
    const failed = { ...base, latestRunFailed: true };
    expect(timelineFailureIsHistory({ ...failed, occurredAt: minutesAgo(5 * 60) })).toBe(false);
    expect(timelineFailureIsHistory({ ...failed, occurredAt: minutesAgo(3 * 24 * 60) })).toBe(
      false,
    );
  });

  it("ages out a failed item of a latest run that went on", () => {
    expect(timelineFailureIsHistory({ ...base, occurredAt: minutesAgo(5 * 60) })).toBe(true);
    expect(
      timelineFailureIsHistory({ ...base, latestRunFailed: false, occurredAt: minutesAgo(5) }),
    ).toBe(false);
  });

  it("treats an old failure as history when its run is unknown", () => {
    expect(
      timelineFailureIsHistory({ ...base, runId: null, occurredAt: minutesAgo(3 * 24 * 60) }),
    ).toBe(true);
    expect(
      timelineFailureIsHistory({ ...base, latestRunId: null, occurredAt: minutesAgo(3 * 24 * 60) }),
    ).toBe(true);
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

describe("resumableRunId", () => {
  const at = (minutes: number) => DateTime.makeUnsafe(NOW - minutes * 60_000);
  const run = (status: OrchestrationV2Run["status"]) =>
    ({
      id: "run:29",
      ordinal: 29,
      status,
      rootNodeId: "node:29",
      startedAt: at(20),
      completedAt: status === "running" ? null : at(5),
    }) as unknown as OrchestrationV2Run;
  const failed = (failure: Pick<OrchestrationV2ProviderFailure, "class" | "code" | "message">) => ({
    runs: [run("failed")],
    turnItems: [
      {
        id: "turn-item:error",
        type: "error",
        status: "failed",
        runId: "run:29",
        nodeId: "node:29",
        ordinal: 1,
        updatedAt: at(5),
        failure: { retryable: null, ...failure },
      } as unknown as OrchestrationV2TurnItem,
    ],
  });

  it("continues a run the disk or a busy provider turn stopped", () => {
    expect(
      resumableRunId({
        ...failed({
          class: "unknown",
          code: LOCAL_STORAGE_FAILURE_CODE,
          message: LOCAL_STORAGE_FAILURE_MESSAGE,
        }),
        lastErrorClass: "unknown",
      }),
    ).toBe("run:29");
    expect(
      resumableRunId({
        ...failed({
          class: "provider_error",
          code: PREVIOUS_TURN_ACTIVE_FAILURE_CODE,
          message: PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE,
        }),
        lastErrorClass: "provider_error",
      }),
    ).toBe("run:29");
  });

  it("continues provider errors and unclassified failures", () => {
    for (const failureClass of ["provider_error", "unknown"] as const) {
      expect(
        resumableRunId({
          ...failed({
            class: failureClass,
            code: null,
            message: "The provider could not start this turn.",
          }),
          lastErrorClass: failureClass,
        }),
      ).toBe("run:29");
    }
  });

  it("offers no Continue where it would only fail again", () => {
    for (const failure of [
      { class: "validation_error", code: null, message: "Bad model." },
      { class: "permission_error", code: null, message: "Sign in again." },
      {
        class: "provider_error",
        code: null,
        message: "prompt is too long: 210000 tokens > 200000 maximum",
      },
      {
        class: "provider_error",
        code: "context_handoff_budget",
        message: CONTEXT_HANDOFF_TOO_LARGE_MESSAGE,
      },
    ] as const) {
      expect(resumableRunId({ ...failed(failure), lastErrorClass: failure.class })).toBeNull();
    }
  });

  it("keeps stopped and usage-limited runs resumable as before", () => {
    expect(
      resumableRunId({ runs: [run("interrupted")], turnItems: [], lastErrorClass: null }),
    ).toBe("run:29");
    const limited = failed({ class: "usage_limit", code: null, message: "Limit reached." });
    expect(resumableRunId({ ...limited, lastErrorClass: "usage_limit" })).toBe("run:29");
    expect(resumableRunId({ ...limited, lastErrorClass: null })).toBeNull();
    expect(
      resumableRunId({ runs: [run("running")], turnItems: [], lastErrorClass: null }),
    ).toBeNull();
  });
});
