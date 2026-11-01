import { describe, expect, it } from "vite-plus/test";

import {
  limitRunOutWarning,
  runOutWarningApplies,
  runOutWarningText,
  type RunOutWindow,
} from "./usageRunOut.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-01T12:00:00.000Z");

const session = (usedPercent: number, resetsIn: number, extra: Partial<RunOutWindow> = {}) =>
  ({
    id: "five_hour",
    label: "Session",
    usedPercent,
    resetsAt: now + resetsIn,
    durationMins: 300,
    ...extra,
  }) satisfies RunOutWindow;

const weekly = (usedPercent: number, resetsIn: number, extra: Partial<RunOutWindow> = {}) =>
  ({
    id: "seven_day",
    label: "Weekly",
    usedPercent,
    resetsAt: now + resetsIn,
    durationMins: 10080,
    ...extra,
  }) satisfies RunOutWindow;

describe("limitRunOutWarning", () => {
  it("warns when the 5-hour pace empties it before its reset", () => {
    // 2h in, 60% used: 30%/h, so the last 40% goes in 80 minutes, before the 3h reset.
    expect(limitRunOutWarning([session(60, 3 * HOUR), weekly(10, 5 * DAY)], now)).toEqual({
      kind: "pace",
      name: "5-hour",
      resetsAt: now + 3 * HOUR,
      runsOutAt: now + 80 * MIN,
    });
  });

  it("warns on the weekly when its pace runs out first and the 5-hour is fine", () => {
    // Weekly: 3.5 days in, 70% used, empties in 1.5 days, before its 3.5-day reset.
    const warning = limitRunOutWarning([session(10, 4 * HOUR), weekly(70, 3.5 * DAY)], now);
    expect(warning).toEqual({
      kind: "pace",
      name: "weekly",
      resetsAt: now + 3.5 * DAY,
      runsOutAt: now + 1.5 * DAY,
    });
  });

  it("picks the window that runs out first when both are ahead of pace", () => {
    const warning = limitRunOutWarning([weekly(70, 3.5 * DAY), session(60, 3 * HOUR)], now);
    expect(warning?.name).toBe("5-hour");
  });

  it("says nothing on an even pace", () => {
    expect(limitRunOutWarning([session(40, 3 * HOUR), weekly(50, 3.5 * DAY)], now)).toBeNull();
  });

  it("puts a spent window ahead of any pace, the latest reset binding", () => {
    expect(limitRunOutWarning([session(100, 2 * HOUR), weekly(100, 2 * DAY)], now)).toEqual({
      kind: "reached",
      name: "weekly",
      resetsAt: now + 2 * DAY,
    });
    expect(limitRunOutWarning([session(100, 2 * HOUR), weekly(70, 3.5 * DAY)], now)).toEqual({
      kind: "reached",
      name: "5-hour",
      resetsAt: now + 2 * HOUR,
    });
  });

  it("ignores missing, stale and unread data instead of inventing a pace", () => {
    expect(limitRunOutWarning([], now)).toBeNull();
    // An unused session has no reset yet.
    expect(limitRunOutWarning([session(0, 0, { resetsAt: null })], now)).toBeNull();
    expect(limitRunOutWarning([session(90, 3 * HOUR, { stale: true })], now)).toBeNull();
    expect(limitRunOutWarning([session(90, -HOUR)], now)).toBeNull();
    expect(limitRunOutWarning([session(Number.NaN, 3 * HOUR)], now)).toBeNull();
    expect(
      limitRunOutWarning([session(90, 3 * HOUR, { durationMins: undefined })], now),
    ).toBeNull();
    expect(limitRunOutWarning([session(60, 3 * HOUR)], Number.NaN)).toBeNull();
  });

  it("waits until enough of the window has passed to read a pace", () => {
    // Four minutes into a 5-hour window, 10% used: a burst, not a pace.
    expect(limitRunOutWarning([session(10, 296 * MIN)], now)).toBeNull();
  });

  it("leaves a model-scoped weekly out of the account warning", () => {
    expect(
      limitRunOutWarning(
        [
          {
            id: "seven_day_fable",
            label: "Weekly · Fable",
            usedPercent: 100,
            resetsAt: now + DAY,
            durationMins: 10080,
            modelScope: "Fable",
          },
        ],
        now,
      ),
    ).toBeNull();
  });
});

describe("runOutWarningApplies", () => {
  it("shows the warning for Claude Code only", () => {
    expect(runOutWarningApplies("claudeAgent")).toBe(true);
    for (const driver of ["codex", "acpRegistry", "cursor", "grok", "opencode", "pi"]) {
      expect(runOutWarningApplies(driver)).toBe(false);
    }
  });
});

describe("runOutWarningText", () => {
  it("phrases a pace warning and a reached limit", () => {
    expect(
      runOutWarningText(
        { kind: "pace", name: "5-hour", resetsAt: now, runsOutAt: now },
        "at 3:40 PM",
        "1h 20m",
      ),
    ).toBe(
      "Heads up. At this pace you'll hit your 5-hour limit in 1h 20m, before it resets at 3:40 PM.",
    );
    expect(
      runOutWarningText({ kind: "reached", name: "5-hour", resetsAt: now }, "at 3:40 PM", ""),
    ).toBe("5-hour limit reached. It resets at 3:40 PM.");
  });
});

describe("limitRunOutWarning with a spent window of unknown reset", () => {
  it("gives no pace warning that the blocked 5-hour row would contradict", () => {
    expect(
      limitRunOutWarning([session(60, 3 * HOUR), weekly(100, 0, { resetsAt: null })], now),
    ).toBeNull();
  });
});
