import type { UsageLimitHistorySeries } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type OutsideEstimateInput,
  type RecordedHour,
  currentWindowStart,
  estimateOutside,
  limitResets,
  pickOutsideWindow,
} from "./usageOutsideEstimate.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = Date.parse("2026-11-09T00:00:00.000Z");
const KEY = "claudeAgent:a@example.com";
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const dayOf = (at: number) => iso(at).slice(0, 10);

/** A weekly series read every hour; `percentAt` gives the percent at each hour. */
function series(
  hours: number,
  percentAt: (hour: number) => number,
  overrides: Partial<UsageLimitHistorySeries> = {},
  resetsAt: (hour: number) => number = () => t0 + 7 * DAY,
): UsageLimitHistorySeries {
  return {
    accountKey: KEY,
    driver: "claudeAgent",
    windowId: "seven_day",
    windowKind: "weekly",
    windowDurationMins: 7 * 24 * 60,
    samples: Array.from({ length: hours + 1 }, (_, hour) => ({
      at: iso(t0 + hour * HOUR),
      usedPercent: Math.min(100, percentAt(hour)),
      resetsAt: iso(resetsAt(hour)),
    })),
    ...overrides,
  } as UsageLimitHistorySeries;
}

function recorded(hours: number, weightAt: (hour: number) => number): RecordedHour[] {
  return Array.from({ length: hours }, (_, hour) => ({
    hourStartMs: t0 + hour * HOUR,
    weight: weightAt(hour),
  }));
}

function input(
  history: UsageLimitHistorySeries,
  hours: RecordedHour[],
  overrides: Partial<OutsideEstimateInput> = {},
): OutsideEstimateInput {
  return {
    window: pickOutsideWindow([[history]], KEY),
    recorded: hours,
    recordedSinceMs: t0,
    periodStartMs: t0,
    periodEndMs: t0 + 5 * DAY,
    silentHolders: [],
    dayOf,
    ...overrides,
  };
}

describe("pickOutsideWindow", () => {
  it("prefers the account-wide weekly window", () => {
    const weekly = series(10, (hour) => hour);
    const scoped = series(40, (hour) => hour, { windowId: "seven_day_opus" });
    const session = series(40, (hour) => hour, { windowId: "five_hour", windowKind: "session" });
    const monthly = series(40, (hour) => hour, { windowId: "month", windowKind: "monthly" });
    const picked = pickOutsideWindow(
      [
        [session, scoped],
        [monthly, weekly],
      ],
      KEY,
      new Set(["seven_day_opus"]),
    );
    expect(picked?.windowId).toBe("seven_day");
    expect(pickOutsideWindow([[session]], KEY)).toBeNull();
    expect(pickOutsideWindow([[monthly]], KEY)?.windowKind).toBe("monthly");
    expect(pickOutsideWindow([[weekly]], "claudeAgent:other@example.com")).toBeNull();
  });
});

describe("estimateOutside", () => {
  it("says why when the provider reports no percent", () => {
    const result = estimateOutside({
      ...input(
        series(10, () => 0),
        [],
      ),
      window: null,
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "noReading" });
  });

  it("gives no estimate while a machine that holds the account is silent", () => {
    const result = estimateOutside(
      input(
        series(120, (hour) => hour * 0.5),
        recorded(120, () => 5),
        { silentHolders: ["Studio Mac"] },
      ),
    );
    expect(result).toMatchObject({ kind: "unavailable", reason: "holderSilent" });
    expect(result.kind === "unavailable" && result.detail).toContain("Studio Mac");
  });

  it("detects nothing when the machines explain the whole limit", () => {
    // Half a point an hour, ten dollars a point, every hour.
    const result = estimateOutside(
      input(
        series(120, (hour) => hour * 0.5),
        recorded(120, () => 5),
      ),
    );
    expect(result).toMatchObject({ kind: "estimate", detected: false, confidence: "high" });
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(60, 0);
    expect(result.outsidePoints).toBeLessThan(1);
    expect(result.weightPerPoint).toBeCloseTo(10, 0);
  });

  it("finds use the machines did not record", () => {
    // Day three: the limit climbs twice as fast with the same recorded use.
    const percentAt = (hour: number) => {
      let percent = 0;
      for (let index = 0; index < hour; index += 1) percent += index >= 48 && index < 72 ? 1 : 0.5;
      return percent;
    };
    const result = estimateOutside(
      input(
        series(120, percentAt),
        recorded(120, () => 5),
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.detected).toBe(true);
    expect(result.consumedPoints).toBeCloseTo(72, 0);
    expect(result.outsidePoints).toBeGreaterThan(9);
    expect(result.outsidePoints).toBeLessThan(15);
    expect(result.lowPoints).toBeLessThanOrEqual(result.outsidePoints);
    expect(result.highPoints).toBeGreaterThanOrEqual(result.outsidePoints);
    expect(result.outsideWeight).toBeCloseTo(result.outsidePoints * result.weightPerPoint!, 3);
    const peak = result.days.reduce((a, b) => (b.points > a.points ? b : a));
    expect(peak.day).toBe("2026-11-11");
    expect(result.days.reduce((sum, day) => sum + day.points, 0)).toBeCloseTo(
      result.outsidePoints,
      0,
    );
  });

  it("counts use across a reset", () => {
    // Climbs to 60, resets after hour 60, then climbs again.
    const percentAt = (hour: number) => (hour <= 60 ? hour : (hour - 60) * 0.5);
    const resetsAt = (hour: number) =>
      hour <= 60 ? t0 + 60 * HOUR + 30 * 60_000 : t0 + 60 * HOUR + 7 * DAY;
    const history = series(120, percentAt, {}, resetsAt);
    const window = pickOutsideWindow([[history]], KEY)!;
    expect(limitResets(window)).toEqual([t0 + 60 * HOUR + 30 * 60_000]);
    expect(currentWindowStart(window, t0 + 120 * HOUR)).toBe(t0 + 60 * HOUR + 30 * 60_000);
    const result = estimateOutside(
      input(
        history,
        recorded(120, (hour) => (hour < 60 ? 10 : 5)),
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(90, 0);
    expect(result.resets).toHaveLength(1);
    expect(result.detected).toBe(false);
  });

  it("does not count a rounding dip twice", () => {
    // Half a point an hour, with a one-point dip and recovery every tenth hour.
    const percentAt = (hour: number) => Math.floor(hour / 2) - (hour % 10 === 5 ? 1 : 0);
    const result = estimateOutside(
      input(
        series(120, percentAt),
        recorded(120, () => 5),
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(60, 0);
    expect(result.resets).toHaveLength(0);
  });

  it("sees a restart the reset time did not announce", () => {
    // Climbs to 90, drops to zero at hour 61 with the same reset time, climbs again.
    const percentAt = (hour: number) => (hour <= 60 ? hour * 1.5 : (hour - 61) * 0.5);
    const history = series(120, percentAt);
    const window = pickOutsideWindow([[history]], KEY)!;
    expect(limitResets(window)).toEqual([t0 + 61 * HOUR]);
    const result = estimateOutside(
      input(
        history,
        recorded(120, (hour) => (hour < 60 ? 15 : 5)),
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(119.5, 0);
    expect(result.detected).toBe(false);
  });

  it("leaves out what the limit gained before the period, in the same hour", () => {
    // Read every half hour: ten points gained in the half hour before the period starts.
    const half = HOUR / 2;
    const history = {
      ...series(0, () => 0),
      samples: [0, 10, 10, 10, 10].map((usedPercent, index) => ({
        at: iso(t0 + index * half),
        usedPercent,
        resetsAt: iso(t0 + 7 * DAY),
      })),
    } as UsageLimitHistorySeries;
    const result = estimateOutside(
      input(history, [], { periodStartMs: t0 + half, periodEndMs: t0 + 2 * HOUR }),
    );
    expect(result).toMatchObject({ kind: "unavailable", reason: "noUse" });
    // The period that holds the gain still sees it.
    expect(estimateOutside(input(history, [], { periodEndMs: t0 + 2 * HOUR }))).toMatchObject({
      kind: "estimate",
      consumedPoints: 10,
    });
  });

  it("counts recorded use in an hour the period cuts in proportion", () => {
    const history = series(120, (hour) => hour * 0.5);
    const whole = estimateOutside(
      input(
        history,
        recorded(120, () => 5),
      ),
    );
    const cut = estimateOutside(
      input(
        history,
        recorded(120, () => 5),
        { periodStartMs: t0 + HOUR / 2 },
      ),
    );
    expect(whole.kind).toBe("estimate");
    expect(cut.kind).toBe("estimate");
    if (whole.kind !== "estimate" || cut.kind !== "estimate") return;
    expect(whole.consumedPoints - cut.consumedPoints).toBeCloseTo(0.25, 1);
    expect(cut.detected).toBe(false);
  });

  it("calls everything outside when no machine recorded anything", () => {
    const result = estimateOutside(
      input(
        series(120, (hour) => hour * 0.25),
        [],
      ),
    );
    expect(result).toMatchObject({
      kind: "estimate",
      detected: true,
      explainedPoints: 0,
      outsideWeight: null,
      weightPerPoint: null,
    });
    if (result.kind === "estimate") expect(result.outsidePoints).toBeCloseTo(30, 0);
  });

  it("gives no estimate from too little history", () => {
    const result = estimateOutside(
      input(
        series(12, (hour) => hour * 0.5),
        recorded(12, () => 5),
        { periodEndMs: t0 + 12 * HOUR },
      ),
    );
    expect(result).toMatchObject({ kind: "unavailable", reason: "shortHistory" });
  });

  it("says so when the limit did not move", () => {
    const result = estimateOutside(
      input(
        series(120, () => 40),
        recorded(120, () => 0),
      ),
    );
    expect(result).toMatchObject({ kind: "unavailable", reason: "noUse" });
  });

  it("covers only the part of the period that has history", () => {
    const result = estimateOutside(
      input(
        series(120, (hour) => hour * 0.5),
        recorded(120, () => 5),
        {
          periodStartMs: t0 - 10 * DAY,
        },
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.coveredFromMs).toBe(t0);
    expect(result.confidence).not.toBe("high");
    expect(result.reasons.join(" ")).toContain("only part");
  });
});
