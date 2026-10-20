import * as DateTime from "effect/DateTime";
import { RunId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import {
  LIVE_ACTIVITY_QUIET_MS,
  formatActivityDuration,
  isQuiet,
  runLiveSignal,
  liveStepStartedAtMs,
  toolCallCountLabel,
} from "./liveActivity";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const run = RunId.make("run-1");

describe("runLiveSignal", () => {
  it("reads the active run's items only", () => {
    const items = [
      { runId: run, updatedAt: at("2026-10-19T20:00:00Z") },
      { runId: run, updatedAt: at("2026-10-19T20:05:00Z") },
      { runId: RunId.make("other"), updatedAt: at("2026-10-19T20:30:00Z") },
      { runId: null, updatedAt: at("2026-10-19T20:40:00Z") },
    ];
    expect(runLiveSignal(items, "run-1")?.lastActivityMs).toBe(Date.parse("2026-10-19T20:05:00Z"));
  });

  it("times a streaming thought from its start, not its latest token", () => {
    const signal = runLiveSignal(
      [
        {
          runId: run,
          startedAt: at("2026-10-19T20:00:00Z"),
          completedAt: at("2026-10-19T20:00:20Z"),
          updatedAt: at("2026-10-19T20:00:20Z"),
        },
        {
          runId: run,
          startedAt: at("2026-10-19T20:00:25Z"),
          completedAt: null,
          updatedAt: at("2026-10-19T20:01:10Z"),
        },
      ],
      "run-1",
    );
    expect(signal).toEqual({
      lastActivityMs: Date.parse("2026-10-19T20:01:10Z"),
      phaseStartedMs: Date.parse("2026-10-19T20:00:25Z"),
    });
  });

  it("knows nothing without a run or its items", () => {
    expect(runLiveSignal([], "run-1")).toBeNull();
    expect(runLiveSignal([{ runId: run, updatedAt: at("2026-10-19T20:00:00Z") }], null)).toBe(null);
  });
});

describe("quiet state", () => {
  const last = Date.parse("2026-10-19T20:00:00Z");
  it("is fresh under a minute and quiet from a minute on", () => {
    expect(isQuiet(last, last + LIVE_ACTIVITY_QUIET_MS - 1)).toBe(false);
    expect(isQuiet(last, last + LIVE_ACTIVITY_QUIET_MS)).toBe(true);
  });
  it("never calls an unknown run quiet", () => {
    expect(isQuiet(null, last + 10 * LIVE_ACTIVITY_QUIET_MS)).toBe(false);
  });
});

describe("liveStepStartedAtMs", () => {
  const entry = (startedAt: string | null): WorkLogEntry =>
    ({
      id: "e",
      createdAt: "2026-10-19T20:00:00Z",
      label: "Running",
      tone: "tool",
      ...(startedAt === null
        ? {}
        : { structuredPayload: { startedAt: at(startedAt) } as WorkLogEntry["structuredPayload"] }),
    }) as WorkLogEntry;
  it("times the step from the provider's start", () => {
    expect(liveStepStartedAtMs(entry("2026-10-19T20:01:30Z"))).toBe(
      Date.parse("2026-10-19T20:01:30Z"),
    );
  });
  it("falls back to the entry time", () => {
    expect(liveStepStartedAtMs(entry(null))).toBe(Date.parse("2026-10-19T20:00:00Z"));
  });
});

it("formats short durations and counts", () => {
  expect(formatActivityDuration(8_400)).toBe("8s");
  expect(formatActivityDuration(4 * 60_000 + 5_000)).toBe("4m");
  expect(formatActivityDuration(72 * 60_000)).toBe("1h 12m");
  expect(toolCallCountLabel(1)).toBe("1 call");
  expect(toolCallCountLabel(14)).toBe("14 calls");
});
