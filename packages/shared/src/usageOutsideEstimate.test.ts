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

  it("leaves out a stale read the next reads undo", () => {
    // Half a point an hour, read every ten minutes; every hundredth read drops
    // far below, and the next one is back.
    const history = {
      ...series(0, () => 0),
      samples: Array.from({ length: 721 }, (_, step) => ({
        at: iso(t0 + step * 10 * 60_000),
        usedPercent: step > 0 && step % 100 === 0 ? 2 : 20 + (step / 6) * 0.5,
        resetsAt: iso(t0 + 7 * DAY),
      })),
    } as UsageLimitHistorySeries;
    const window = pickOutsideWindow([[history]], KEY)!;
    expect(limitResets(window)).toEqual([]);
    const result = estimateOutside(
      input(
        history,
        recorded(120, () => 5),
      ),
    );
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(60, 0);
    // A fall to under half could have been a restart: the estimate says how it was read.
    expect(result.reasons.some((reason) => reason.includes("taken as a misread"))).toBe(true);
    expect(result.confidence).not.toBe("high");
  });

  it("keeps a reset whose time had passed, though the next reads come straight back", () => {
    // 24, then 0 after the reset time, then 24 again ten minutes later.
    const reads = [24, 0, 24, 24.5];
    const history = {
      ...series(0, () => 0),
      samples: reads.map((usedPercent, step) => ({
        at: iso(t0 + step * 10 * 60_000),
        usedPercent,
        ...(step === 0 ? { resetsAt: iso(t0 + 5 * 60_000) } : {}),
      })),
    } as UsageLimitHistorySeries;
    const window = pickOutsideWindow([[history]], KEY)!;
    expect(limitResets(window)).toEqual([t0 + 5 * 60_000]);
    const result = estimateOutside(input(history, [], { periodEndMs: t0 + HOUR }));
    expect(result.kind).toBe("estimate");
    if (result.kind !== "estimate") return;
    expect(result.consumedPoints).toBeCloseTo(24.5, 1);
  });

  it("counts a reset once when the first read after it still carries the old reset time", () => {
    // Reset at minute 5. The read at minute 6 keeps the old reset time; the next has the new one.
    for (const [middle, expected] of [
      [10, 24],
      [14, 24],
      [0, 24],
    ] as const) {
      const minute = 60_000;
      const reads = [
        { at: 0, usedPercent: 24, resetsAt: 5 * minute },
        { at: 6 * minute, usedPercent: middle, resetsAt: 5 * minute },
        { at: 16 * minute, usedPercent: 24, resetsAt: 5 * minute + 7 * DAY },
      ];
      const history = {
        ...series(0, () => 0),
        samples: reads.map((read) => ({
          at: iso(t0 + read.at),
          usedPercent: read.usedPercent,
          resetsAt: iso(t0 + read.resetsAt),
        })),
      } as UsageLimitHistorySeries;
      const window = pickOutsideWindow([[history]], KEY)!;
      expect(window.samples).toHaveLength(3);
      expect(limitResets(window)).toEqual([t0 + 5 * minute]);
      const result = estimateOutside(input(history, [], { periodEndMs: t0 + HOUR }));
      expect(result.kind).toBe("estimate");
      if (result.kind !== "estimate") return;
      expect(result.consumedPoints).toBeCloseTo(expected, 1);
    }
  });

  it("still counts the next reset after one that was told late", () => {
    // Reset at minute 5, read at minute 6 with the old reset time; the next
    // read comes just after the following weekly reset.
    const minute = 60_000;
    const week = 7 * DAY;
    const reads = [
      { at: 0, usedPercent: 24, resetsAt: 5 * minute },
      { at: 6 * minute, usedPercent: 10, resetsAt: 5 * minute },
      { at: 5.5 * minute + week, usedPercent: 24, resetsAt: 5 * minute + 2 * week },
    ];
    for (const windowDurationMins of [7 * 24 * 60, undefined]) {
      const history = {
        ...series(0, () => 0),
        windowDurationMins,
        samples: reads.map((read) => ({
          at: iso(t0 + read.at),
          usedPercent: read.usedPercent,
          resetsAt: iso(t0 + read.resetsAt),
        })),
      } as UsageLimitHistorySeries;
      const window = pickOutsideWindow([[history]], KEY)!;
      // With a known length the second restart is placed at its own time, else at the read.
      expect(limitResets(window)).toEqual([
        t0 + 5 * minute,
        t0 + (windowDurationMins === undefined ? 5.5 : 5) * minute + week,
      ]);
      const result = estimateOutside(input(history, [], { periodEndMs: t0 + 8 * DAY }));
      expect(result.kind).toBe("estimate");
      if (result.kind !== "estimate") return;
      expect(result.consumedPoints).toBeCloseTo(34, 1);
    }
  });

  it("counts a late-told reset once however late in its window the next read comes", () => {
    // Reset at minute 5; the next read with the new reset time comes four days on.
    const minute = 60_000;
    const reads = [
      { at: 0, usedPercent: 24, resetsAt: 5 * minute },
      { at: 6 * minute, usedPercent: 14, resetsAt: 5 * minute },
      { at: 6000 * minute, usedPercent: 24, resetsAt: 5 * minute + 7 * DAY },
    ];
    for (const windowDurationMins of [7 * 24 * 60, undefined]) {
      const history = {
        ...series(0, () => 0),
        windowDurationMins,
        samples: reads.map((read) => ({
          at: iso(t0 + read.at),
          usedPercent: read.usedPercent,
          resetsAt: iso(t0 + read.resetsAt),
        })),
      } as UsageLimitHistorySeries;
      const window = pickOutsideWindow([[history]], KEY)!;
      expect(limitResets(window)).toEqual([t0 + 5 * minute]);
      const result = estimateOutside(input(history, [], { periodEndMs: t0 + 5 * DAY }));
      expect(result.kind).toBe("estimate");
      if (result.kind !== "estimate") return;
      expect(result.consumedPoints).toBeCloseTo(24, 1);
    }
  });

  it("counts the next reset when its first read still carries the reset time just passed", () => {
    // Resets at minute 5 and one window later; each first read after carries the passed time.
    const minute = 60_000;
    for (const [kind, days] of [
      ["weekly", 7],
      ["monthly", 30],
    ] as const) {
      const length = days * DAY;
      const reads = [
        { at: 0, usedPercent: 24, resetsAt: 5 * minute },
        { at: 6 * minute, usedPercent: 14, resetsAt: 5 * minute },
        { at: 6 * minute + length, usedPercent: 24, resetsAt: 5 * minute + length },
      ];
      const history = {
        ...series(0, () => 0),
        windowKind: kind,
        windowDurationMins: days * 24 * 60,
        samples: reads.map((read) => ({
          at: iso(t0 + read.at),
          usedPercent: read.usedPercent,
          resetsAt: iso(t0 + read.resetsAt),
        })),
      } as UsageLimitHistorySeries;
      const window = pickOutsideWindow([[history]], KEY)!;
      expect(window.samples).toHaveLength(3);
      expect(limitResets(window)).toEqual([t0 + 5 * minute, t0 + 5 * minute + length]);
      const result = estimateOutside(input(history, [], { periodEndMs: t0 + length + DAY }));
      expect(result.kind).toBe("estimate");
      if (result.kind !== "estimate") return;
      expect(result.consumedPoints).toBeCloseTo(38, 1);
    }
  });

  it("counts every reset of a regular schedule once, whenever its reset time is told", () => {
    // Random series on a fixed schedule, checked against that schedule: two
    // reads in one window add what was gained, a read in a later window adds
    // what it shows and marks one reset. Each series runs with every read
    // carrying the reset time ahead of it, and with a read in the five
    // minutes after a reset still carrying the one just passed.
    const minute = 60_000;
    const first = 5 * minute;
    let checked = 0;
    let mixed = 0;
    const openings = [0, 0, 0];
    for (const [kind, days] of [
      ["weekly", 7],
      ["monthly", 30],
    ] as const) {
      const length = days * DAY;
      const windowOf = (at: number) => Math.floor((at - first) / length);
      const startOf = (at: number) => first + windowOf(at) * length;
      for (let seed = 1; seed <= 600; seed += 1) {
        // Spread the seeds first: neighbouring seeds give neighbouring first draws.
        let state = (seed * 2_654_435_761) % 2 ** 32;
        const random = () => {
          state = (state * 1664525 + 1013904223) % 2 ** 32;
          return state / 2 ** 32;
        };
        random();
        // The history starts before the first reset, just after it with the
        // passed reset time still on the read, or somewhere inside a window.
        const opening = random();
        let at =
          opening < 0.4
            ? 0
            : opening < 0.7
              ? first + (0.5 + random() * 4) * minute
              : first + random() * 0.9 * length;
        at = Math.round(at / 30_000) * 30_000;
        openings[opening < 0.4 ? 0 : opening < 0.7 ? 1 : 2]! += 1;
        const times = [at];
        const reads = 2 + Math.floor(random() * 7);
        for (let read = 1; read < reads; read += 1) {
          const pick = random();
          at +=
            pick < 0.3
              ? (1 + Math.floor(random() * 20)) * minute
              : pick < 0.6
                ? (1 + random() * 30) * HOUR
                : (0.5 + random() * 0.9 * days) * DAY;
          // Often land just after a reset, this window's or the next one's.
          if (random() < 0.35) {
            at = startOf(at) + (random() < 0.5 ? 0 : length) + (0.5 + random() * 4) * minute;
          }
          at = Math.max(Math.round(at / 30_000) * 30_000, times[times.length - 1]! + minute);
          times.push(at);
        }
        const perDay = (2 + random() * 12) * (7 / days);
        const before = 20 + random() * 10;
        const fresh = random() * 6;
        const usedAt = (time: number) => {
          const start = startOf(time);
          const used =
            start < 0 ? before + (time / DAY) * perDay : fresh + ((time - start) / DAY) * perDay;
          return Math.min(100, Math.round(used * 10) / 10);
        };
        let resets = 0;
        let points = 0;
        for (let read = 1; read < times.length; read += 1) {
          const turned = windowOf(times[read]!) !== windowOf(times[read - 1]!);
          if (turned) resets += 1;
          points += turned
            ? usedAt(times[read]!)
            : Math.max(0, usedAt(times[read]!) - usedAt(times[read - 1]!));
        }
        const late = (time: number) => time - startOf(time) < 5 * minute;
        // A third run leaves the reset time off some reads. A restart seen
        // first on such a read shows only as a fall, so the run is made only
        // when every restart can be told: by a clear fall from a mark high
        // enough not to be taken for a stale read, or by a reset time on the
        // read with one on an earlier read to compare it with.
        const bare = times.map(() => random() < 0.3);
        const tellable = times.every((time, read) => {
          if (read === 0 || windowOf(time) === windowOf(times[read - 1]!)) return true;
          const mark = usedAt(times[read - 1]!);
          if (mark - usedAt(time) > 5 && mark > 12) return true;
          return !bare[read] && bare.slice(0, read).some((isBare) => !isBare);
        });
        const runs: Array<readonly [lag: boolean, drop: boolean]> = [
          [false, false],
          [true, false],
        ];
        if (tellable && bare.some(Boolean)) {
          mixed += 1;
          runs.push([random() < 0.5, true]);
        }
        for (const [lag, drop] of runs) {
          for (const withLength of [true, false]) {
            const history = {
              ...series(0, () => 0),
              windowKind: kind,
              windowDurationMins: withLength ? days * 24 * 60 : undefined,
              samples: times.map((time, read) => ({
                at: iso(t0 + time),
                usedPercent: usedAt(time),
                ...(drop && bare[read]
                  ? {}
                  : { resetsAt: iso(t0 + startOf(time) + (lag && late(time) ? 0 : length)) }),
              })),
            } as UsageLimitHistorySeries;
            const window = pickOutsideWindow([[history]], KEY)!;
            const result = estimateOutside(
              input(history, [], { periodEndMs: t0 + times[times.length - 1]! + minute }),
            );
            checked += 1;
            expect({
              kind,
              seed,
              lag,
              drop,
              withLength,
              resets: limitResets(window).length,
              // Under one point the estimate says the limit did not move.
              points:
                result.kind === "estimate"
                  ? result.consumedPoints
                  : result.reason === "noUse" && points < 1.05
                    ? points
                    : -1,
            }).toEqual({
              kind,
              seed,
              lag,
              drop,
              withLength,
              resets,
              points: expect.closeTo(points, 0),
            });
          }
        }
      }
    }
    expect(checked).toBe(4800 + 2 * mixed);
    expect(mixed).toBeGreaterThan(300);
    for (const count of openings) expect(count).toBeGreaterThan(200);
  });

  it("counts a later reset after one counted on a read without a reset time", () => {
    // Reset at minute 5, seen on a read that carries no reset time; the next
    // read names the following reset, a window on.
    const minute = 60_000;
    for (const [kind, days] of [
      ["weekly", 7],
      ["monthly", 30],
    ] as const) {
      const length = days * DAY;
      for (const withLength of [true, false]) {
        const history = {
          ...series(0, () => 0),
          windowKind: kind,
          windowDurationMins: withLength ? days * 24 * 60 : undefined,
          samples: [
            { at: iso(t0), usedPercent: 80, resetsAt: iso(t0 + 5 * minute) },
            { at: iso(t0 + 6 * minute), usedPercent: 10 },
            {
              at: iso(t0 + 6 * minute + length),
              usedPercent: 20,
              resetsAt: iso(t0 + 5 * minute + length),
            },
          ],
        } as UsageLimitHistorySeries;
        const window = pickOutsideWindow([[history]], KEY)!;
        expect(limitResets(window)).toEqual([t0 + 5 * minute, t0 + 5 * minute + length]);
        const result = estimateOutside(input(history, [], { periodEndMs: t0 + length + DAY }));
        expect(result.kind).toBe("estimate");
        if (result.kind !== "estimate") return;
        expect(result.consumedPoints).toBeCloseTo(30, 1);
      }
    }
  });

  it("says so when the only movement was a read taken as a misread", () => {
    const reads = [24, 0, 24];
    const history = {
      ...series(0, () => 0),
      samples: reads.map((usedPercent, step) => ({
        at: iso(t0 + step * 10 * 60_000),
        usedPercent,
      })),
    } as UsageLimitHistorySeries;
    const result = estimateOutside(input(history, [], { periodEndMs: t0 + HOUR }));
    expect(result).toMatchObject({ kind: "unavailable", reason: "noUse" });
    if (result.kind !== "unavailable") return;
    expect(result.detail).toContain("taken as a misread");
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
