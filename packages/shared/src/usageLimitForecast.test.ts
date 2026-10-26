import { ProviderDriverKind, type UsageLimitHistorySeries } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  burnPerHour,
  forecastHorizonMs,
  forecastPool,
  formatBurnPerHour,
  indexLimitHistory,
} from "./usageLimitForecast.ts";
import { type LimitAccount, collectLimitPools } from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-26T12:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const claude = ProviderDriverKind.make("claudeAgent");

const weekly = (usedPercent: number, resetsAt: number) =>
  ({
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    usedPercent,
    resetsAt: iso(resetsAt),
  }) as const;

const account = (
  name: string,
  email: string | undefined,
  windows: LimitAccount["limits"]["windows"],
): LimitAccount => ({
  key: `env:${name}`,
  driver: claude,
  displayName: name,
  email,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: "Hub",
  offline: false,
  redeem: null,
  limits: { checkedAt: iso(now), windows },
});

const series = (
  email: string,
  samples: Array<[at: number, usedPercent: number, resetsAt: number]>,
): UsageLimitHistorySeries => ({
  accountKey: `claudeAgent:${email}`,
  driver: claude,
  windowId: "seven_day",
  windowKind: "weekly",
  windowDurationMins: 7 * 24 * 60,
  samples: samples.map(([at, usedPercent, resetsAt]) => ({
    at: iso(at),
    usedPercent,
    resetsAt: iso(resetsAt),
  })),
});

const sample = (at: number, usedPercent: number, resetsAt: number | null = now + DAY) => ({
  at,
  usedPercent,
  resetsAt,
});

describe("burnPerHour", () => {
  it("is the rise over the span of reads", () => {
    expect(burnPerHour([sample(now - 3 * HOUR, 34), sample(now, 40)], now)).toBeCloseTo(2);
  });

  it("counts a new reset period from zero", () => {
    const burn = burnPerHour(
      [sample(now - 2 * HOUR, 95, now - HOUR), sample(now, 5, now + 7 * DAY)],
      now,
    );
    expect(burn).toBeCloseTo(2.5);
  });

  it("treats small falls and a sliding reset time as no spend, not as resets", () => {
    // A rolling window: usage ages out as fast as it is added, and the reset slides forward.
    const rolling = Array.from({ length: 19 }, (_, index) => {
      const at = now - 3 * HOUR + index * 10 * MINUTE;
      return sample(at, index % 2 === 0 ? 39.5 : 40.5, at + 5 * HOUR);
    });
    expect(burnPerHour(rolling, now)!).toBeLessThan(5);
    // Two machines reading one account round differently: only the rise past 60 is spend.
    expect(
      burnPerHour(
        [
          sample(now - HOUR, 60),
          sample(now - 45 * MINUTE, 59.5),
          sample(now - 30 * MINUTE, 60),
          sample(now - 15 * MINUTE, 59.5),
          sample(now, 60.5),
        ],
        now,
      ),
    ).toBeCloseTo(0.5);
  });

  it("counts a reset only once the reset time has passed and the window moved on", () => {
    const resetAt = now - HOUR;
    // Read after the reset time, but still showing the old period: not evidence of anything.
    expect(
      burnPerHour([sample(now - 2 * HOUR, 80, resetAt), sample(now, 82, resetAt)], now),
    ).toBeNull();
    // The window moved on: the new period counts from zero.
    expect(
      burnPerHour([sample(now - 2 * HOUR, 80, resetAt), sample(now, 10, resetAt + 7 * DAY)], now),
    ).toBeCloseTo(5);
  });

  it("does not book usage ageing out of a rolling window as a reset", () => {
    // Reads every 15 minutes; the reset slides with the clock, and a 6-point burst ages out midway.
    const reads = Array.from({ length: 13 }, (_, index) => {
      const at = now - 3 * HOUR + index * 15 * MINUTE;
      return sample(at, index < 6 ? 43 + index * 0.5 : 37 + (index - 6) * 0.5, at + 5 * HOUR);
    });
    expect(burnPerHour(reads, now, undefined, 5 * HOUR)).toBeCloseTo(5.5 / 3);
  });

  it("ignores a kept read from before a reset that another machine restamped later", () => {
    const resetAt = now - 2 * HOUR;
    const reads = [
      sample(now - 3 * HOUR, 80, resetAt),
      sample(resetAt + 10 * MINUTE, 1, resetAt + 7 * DAY),
      // Machine B: the old period's read, restamped after the reset.
      sample(resetAt + 40 * MINUTE, 80, resetAt),
      sample(now - 30 * MINUTE, 4, resetAt + 7 * DAY),
      sample(now, 5, resetAt + 7 * DAY),
    ];
    expect(burnPerHour(reads, now, undefined, 7 * DAY)).toBeCloseTo(5 / 3);
  });

  it("counts a reset across a read gap of a whole window", () => {
    // Asleep for 5h30m on a 5h window that resets on a fixed grid.
    const reads = [
      sample(now - 6 * HOUR, 66, now - 3 * HOUR - 40 * MINUTE),
      sample(now - 5 * HOUR - 30 * MINUTE, 70, now - 3 * HOUR - 40 * MINUTE),
      sample(now - 30 * MINUTE, 40, now + HOUR + 20 * MINUTE),
      sample(now, 45, now + HOUR + 20 * MINUTE),
    ];
    expect(burnPerHour(reads, now, undefined, 5 * HOUR)!).toBeGreaterThan(5);
  });

  it("counts an early weekly reset that moves the reset by a day", () => {
    const reads = [sample(now - HOUR, 68, now + 6 * DAY), sample(now, 2, now + 7 * DAY)];
    expect(burnPerHour(reads, now, undefined, 7 * DAY)).toBeCloseTo(2);
  });

  it("anchors on the read just before the lookback, and needs twenty minutes of reads", () => {
    // Flat since four hours ago, then a rise: the anchor keeps the quiet stretch in the rate.
    expect(burnPerHour([sample(now - 4 * HOUR, 10), sample(now, 14)], now)).toBeCloseTo(1);
    expect(burnPerHour([sample(now - 10 * MINUTE, 10), sample(now, 14)], now)).toBeNull();
    expect(burnPerHour([sample(now, 14)], now)).toBeNull();
  });
});

describe("indexLimitHistory", () => {
  it("interleaves the same account from two machines and drops repeated times", () => {
    const index = indexLimitHistory([
      [
        series("a@example.com", [
          [now - 2 * HOUR, 10, now + DAY],
          [now, 20, now + DAY],
        ]),
      ],
      [
        series("a@example.com", [
          [now - HOUR, 15, now + DAY],
          [now, 20, now + DAY],
        ]),
      ],
    ]);
    expect(
      index.get("claudeAgent:a@example.com|weekly:seven_day")?.map((s) => s.usedPercent),
    ).toEqual([10, 15, 20]);
  });
});

describe("forecastPool", () => {
  const accounts = [
    account("A", "a@example.com", [weekly(40, now + 3 * DAY)]),
    account("B", "b@example.com", [weekly(90, now + DAY)]),
  ];
  const [pool] = collectLimitPools(accounts, now);
  const window = pool!.windows[0]!;
  const history = indexLimitHistory([
    [
      series("a@example.com", [[now - 3 * HOUR, 34, now + 3 * DAY]]),
      series("b@example.com", [[now - 3 * HOUR, 87, now + DAY]]),
    ],
  ]);

  it("adds the accounts up and measures the pool's burn", () => {
    const forecast = forecastPool(window, history, now);
    expect(forecast.capacity).toBe(200);
    expect(forecast.remaining).toBe(70);
    expect(forecast.burnPerHour).toBeCloseTo(3);
    expect(forecast.measuredAccounts).toBe(2);
    expect(forecast.emptyNow).toBe(0);
    expect(forecast.nextReset).toMatchObject({ at: now + DAY, restores: 90 });
    expect(forecast.nextReset?.accounts.map((a) => a.displayName)).toEqual(["B"]);
  });

  it("runs the busiest account dry first, then moves its spend to the rest", () => {
    const forecast = forecastPool(window, history, now);
    // B has 10% left at 1%/h; A then carries all 3%/h with 40% left.
    expect(forecast.firstEmpty?.account.displayName).toBe("B");
    expect(forecast.firstEmpty!.at - now).toBeGreaterThanOrEqual(9.5 * HOUR);
    expect(forecast.firstEmpty!.at - now).toBeLessThanOrEqual(10.5 * HOUR);
    expect(forecast.poolEmptyAt! - now).toBeGreaterThanOrEqual(23 * HOUR);
    expect(forecast.poolEmptyAt! - now).toBeLessThanOrEqual(24 * HOUR);
    // B refills at its reset, so the projection climbs again after a day.
    const afterReset = forecast.projected.find((point) => point.at > now + DAY + HOUR);
    expect(afterReset?.remaining).toBeGreaterThan(90);
    expect(forecast.projected[0]).toEqual({ at: now, remaining: 70 });
    expect(forecast.horizonEnd - now).toBe(forecastHorizonMs(window));
  });

  it("draws the recorded pool only where every account has a read", () => {
    const forecast = forecastPool(window, history, now);
    expect(forecast.recorded.length).toBeGreaterThan(2);
    expect(forecast.recorded[0]!.at).toBeGreaterThanOrEqual(now - 3 * HOUR);
    expect(forecast.recorded[0]!.remaining).toBeCloseTo(79);
    expect(forecast.recorded[forecast.recorded.length - 1]).toEqual({ at: now, remaining: 70 });
  });

  it("projects nothing until some account has a measured rate", () => {
    const forecast = forecastPool(window, new Map(), now);
    expect(forecast.burnPerHour).toBeNull();
    expect(forecast.projected).toEqual([]);
    expect(forecast.recorded).toEqual([]);
    expect(forecast.firstEmpty).toBeNull();
    expect(forecast.nextReset?.restores).toBe(90);
  });

  it("names an account that is already dry apart from the next one to run out", () => {
    const dry = collectLimitPools(
      [
        account("A", "a@example.com", [weekly(40, now + 3 * DAY)]),
        account("C", undefined, [weekly(100, now + 2 * DAY)]),
      ],
      now,
    )[0]!.windows[0]!;
    const forecast = forecastPool(dry, history, now);
    expect(forecast.emptyNow).toBe(1);
    expect(forecast.firstEmpty?.account.displayName).toBe("A");
    // A carries the whole 2%/h with 60% left: thirty hours.
    expect(Math.abs(forecast.firstEmpty!.at - now - 30 * HOUR)).toBeLessThanOrEqual(HOUR);
  });
});

describe("forecastPool refills", () => {
  const session = (usedPercent: number, resetsAt: number | undefined) =>
    ({
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt: iso(resetsAt) }),
    }) as const;
  const sessionSeries = (
    email: string,
    samples: Array<[at: number, usedPercent: number, resetsAt: number]>,
  ): UsageLimitHistorySeries => ({
    ...series(email, samples),
    windowId: "five_hour",
    windowKind: "session",
    windowDurationMins: 300,
  });

  it("opens an idle window on first use, so it refills a window length later", () => {
    const pool = collectLimitPools(
      [
        account("A", "a@example.com", [session(50, now + 4 * HOUR)]),
        account("B", "b@example.com", [session(0, undefined)]),
      ],
      now,
    )[0]!.windows[0]!;
    const history = indexLimitHistory([
      [sessionSeries("a@example.com", [[now - 3 * HOUR, 0, now + 4 * HOUR]])],
    ]);
    const forecast = forecastPool(pool, history, now);
    expect(forecast.burnPerHour).toBeCloseTo(50 / 3);
    // B starts spending once A runs dry and refills five hours after that.
    const late = forecast.projected.filter((point) => point.at > now + 8 * HOUR);
    expect(Math.max(...late.map((point) => point.remaining))).toBeGreaterThan(100);
  });

  it("carries a reset that passed since the read forward by the window length", () => {
    const pool = collectLimitPools(
      [account("A", "a@example.com", [session(90, now - HOUR)])],
      now,
    )[0]!.windows[0]!;
    const history = indexLimitHistory([
      [
        sessionSeries("a@example.com", [
          [now - 4 * HOUR, 10, now - HOUR],
          [now - 2 * HOUR, 70, now - HOUR],
        ]),
      ],
    ]);
    const forecast = forecastPool(pool, history, now);
    expect(forecast.burnPerHour).toBeCloseTo(30);
    // Read as open again now: dry at about +3.3h, then refilled at the next reset, now + 4h.
    const before = forecast.projected.find((point) => point.at > now + 3.9 * HOUR);
    const after = forecast.projected.find((point) => point.at > now + 4.1 * HOUR);
    expect(after!.remaining).toBeGreaterThan(before!.remaining);
  });

  it("names an account that is dry now once it refills and runs out again", () => {
    const pool = collectLimitPools(
      [account("A", "a@example.com", [session(100, now + HOUR)])],
      now,
    )[0]!.windows[0]!;
    const history = indexLimitHistory([
      [sessionSeries("a@example.com", [[now - 3 * HOUR, 10, now + HOUR]])],
    ]);
    const forecast = forecastPool(pool, history, now);
    expect(forecast.emptyNow).toBe(1);
    expect(forecast.burnPerHour).toBeCloseTo(30);
    // Refills at +1h, then 100% at 30%/h: dry again about 4h20m from now.
    expect(Math.abs(forecast.firstEmpty!.at - now - (HOUR + (100 / 30) * HOUR))).toBeLessThan(
      0.2 * HOUR,
    );
  });
});

describe("forecastPool steps", () => {
  it("refills at the reset itself, not at the end of the step it falls in", () => {
    const session = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent: 99,
      resetsAt: iso(now + 61 * MINUTE),
    } as const;
    const pool = collectLimitPools([account("A", "a@example.com", [session])], now)[0]!.windows[0]!;
    const history = indexLimitHistory([
      [
        {
          ...series("a@example.com", [[now - 3 * HOUR, 9, now + 61 * MINUTE]]),
          windowId: "five_hour",
          windowKind: "session",
          windowDurationMins: 300,
        },
      ],
    ]);
    const forecast = forecastPool(pool, history, now);
    // 30%/h with 1% left: dry within minutes, then 100% again at +61m and dry about 3h20m later.
    expect(forecast.burnPerHour).toBeCloseTo(30);
    expect(forecast.firstEmpty!.at - now).toBeLessThan(10 * MINUTE);
    expect(forecast.poolEmptyAt! - now).toBeLessThan(10 * MINUTE);
    const refilled = forecast.projected.find((point) => point.at >= now + 62 * MINUTE)!;
    expect(refilled.remaining).toBeGreaterThan(95);
  });
});

describe("forecastPool run-dry times", () => {
  it("names the account that runs dry first at the moment it does, even on a weekly pool", () => {
    const pool = collectLimitPools(
      [
        account("A", "a@example.com", [weekly(99.1, now + 5 * DAY)]),
        account("B", "b@example.com", [weekly(99.9, now + 5 * DAY)]),
      ],
      now,
    )[0]!.windows[0]!;
    const history = indexLimitHistory([
      [
        series("a@example.com", [[now - 3 * HOUR, 93.1, now + 5 * DAY]]),
        series("b@example.com", [[now - 3 * HOUR, 93.9, now + 5 * DAY]]),
      ],
    ]);
    const forecast = forecastPool(pool, history, now);
    // Both burn 2%/h. B has 0.1% left: 3 minutes. Then A carries 4%/h with 0.9% - 0.1% left.
    expect(forecast.firstEmpty?.account.displayName).toBe("B");
    expect(Math.abs(forecast.firstEmpty!.at - now - 3 * MINUTE)).toBeLessThan(MINUTE);
    expect(Math.abs(forecast.poolEmptyAt! - now - 15 * MINUTE)).toBeLessThan(MINUTE);
  });
});

describe("formatBurnPerHour", () => {
  it("keeps one decimal under ten", () => {
    expect(formatBurnPerHour(3.74)).toBe("3.7%/h");
    expect(formatBurnPerHour(12.4)).toBe("12%/h");
  });
});
