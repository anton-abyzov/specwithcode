import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  UsageProviderChart,
  buildPeriodColumns,
  niceScale,
  sampleIndex,
  sampledPaths,
} from "./UsageProviderChart";
import { providersWithUsage } from "./usageProviders";

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 30,
        totalTokens: 300,
        records: 1,
        unpricedRecords: 0,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100, records: 1, unpricedRecords: 0 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200, records: 1, unpricedRecords: 0 }],
        ]),
      },
    ],
    // 2026-08-02 is deliberately absent: a day with no activity.
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        records: 1,
        unpricedRecords: 0,
        byProvider: new Map([
          ["claude" as const, { costUsd: 5, totalTokens: 50, records: 1, unpricedRecords: 0 }],
        ]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildPeriodColumns(days, byDay, "cost").map((column) => column.total)).toEqual([
      30, 0, 5,
    ]);
  });

  it("reads the requested metric", () => {
    expect(buildPeriodColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      300, 0, 50,
    ]);
  });

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildPeriodColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });
});

describe("providersWithUsage", () => {
  it("omits providers with no cost or tokens", () => {
    expect(
      providersWithUsage([
        { provider: "codex", costUsd: 0, totalTokens: 0 },
        { provider: "claude", costUsd: 0, totalTokens: 200 },
      ]),
    ).toEqual(["claude"]);
  });
});

describe("hourly chart columns", () => {
  it("zero-fills inactive hours and preserves hourly provider values", () => {
    const byHour = new Map([
      [
        "2026-08-11T09:37:00.000Z",
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T09:37:00.000Z",
          costUsd: 4,
          totalTokens: 40,
          records: 1,
          unpricedRecords: 0,
          byProvider: new Map([
            ["codex" as const, { costUsd: 4, totalTokens: 40, records: 1, unpricedRecords: 0 }],
          ]),
        },
      ],
    ]);

    expect(
      buildPeriodColumns(
        ["2026-08-11T08:37:00.000Z", "2026-08-11T09:37:00.000Z", "2026-08-11T10:37:00.000Z"],
        byHour,
        "cost",
      ).map((column) => column.total),
    ).toEqual([0, 4, 0]);
  });
});

describe("exact samples and pointer access", () => {
  it("connects only the exact samples with straight segments", () => {
    const result = sampledPaths(
      [
        { x: 0, y: 100 },
        { x: 10, y: 0 },
        { x: 20, y: 80 },
      ],
      100,
    );
    expect(result.line).toBe("M0.00,100.00 L10.00,0.00 L20.00,80.00");
    expect(result.line).not.toMatch(/[CQ]/);
  });
  it("breaks unpriced intervals instead of inventing a zero or interpolated cost", () => {
    const result = sampledPaths([{ x: 0, y: 50 }, null, { x: 20, y: 30 }], 100);
    expect(result.line).toBe("M0.00,50.00 M20.00,30.00");
    expect(result.area.match(/Z/g)).toHaveLength(2);
  });
  it("maps a tap directly to the nearest shared date without a preceding hover", () => {
    expect(sampleIndex(150, 100, 100, 7)).toBe(3);
    expect(sampleIndex(0, 100, 100, 7)).toBe(0);
    expect(sampleIndex(500, 100, 100, 7)).toBe(6);
    expect(sampleIndex(120, 100, 100, 1)).toBe(0);
    expect(sampleIndex(120, 100, 0, 7)).toBeNull();
  });
});

it("keeps an isolated priced sample visible in the 90-day chart", () => {
  const days = Array.from({ length: 90 }, (_, index) =>
    new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  );
  const daily = days.map((day, index) => ({
    day,
    costUsd: index === 45 ? 10 : 0,
    totalTokens: 100,
    records: 1,
    unpricedRecords: index === 45 ? 0 : 1,
    byProvider: new Map([
      [
        "claude" as const,
        {
          costUsd: index === 45 ? 10 : 0,
          totalTokens: 100,
          records: 1,
          unpricedRecords: index === 45 ? 0 : 1,
        },
      ],
    ]),
  }));
  const markup = renderToStaticMarkup(
    createElement(UsageProviderChart, {
      providers: ["claude"],
      days,
      daily,
      hours: [],
      hourly: [],
      metric: "cost",
      referenceTime: undefined,
      resolution: "day",
      timeZone: "UTC",
    }),
  );
  expect(markup.match(/<circle/g)).toHaveLength(1);
  const position = markup.match(/<circle[^>]*cy="([^"]+)"/);
  expect(Number(position?.[1])).toBeLessThan(260);
});

it("centers a single pinned-day sample instead of clipping it at the left edge", () => {
  const day = "2026-10-22";
  const daily = [
    {
      day,
      costUsd: 10,
      totalTokens: 100,
      records: 1,
      unpricedRecords: 0,
      byProvider: new Map([
        ["claude" as const, { costUsd: 10, totalTokens: 100, records: 1, unpricedRecords: 0 }],
      ]),
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(UsageProviderChart, {
      providers: ["claude"],
      days: [day],
      daily,
      hours: [],
      hourly: [],
      metric: "cost",
      referenceTime: undefined,
      resolution: "day",
      timeZone: "UTC",
    }),
  );
  expect(markup).toMatch(/<circle[^>]*cx="480"/);
});
