import { ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DashboardOptions,
  accountWidePeriods,
  busiestDay,
  dashboardColumns,
  efficiencyDashboard,
  periodScore,
  rangeTokensLost,
  targetOf,
} from "./efficiency";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Saturday November 14, 2026, 8 PM local.
const now = new Date(2026, 10, 14, 20, 0).getTime();
const monday = (weeksAgo: number) => new Date(2026, 10, 9 - 7 * weeksAgo).getTime();
const iso = (at: number) => new Date(at).toISOString();
const codex = ProviderDriverKind.make("codex");
const muse = ProviderDriverKind.make("muse");

const period = (
  accountKey: string,
  weeksAgo: number,
  used: number,
  extra: Partial<UsageResetPeriod> = {},
): UsageResetPeriod => {
  const endedAt = monday(weeksAgo) + 2 * DAY;
  return {
    accountKey,
    driver: accountKey.startsWith("muse") ? muse : codex,
    windowId: "weekly",
    windowKind: "weekly",
    startedAt: iso(endedAt - 7 * DAY),
    endedAt: iso(endedAt),
    lastReadAt: iso(endedAt - HOUR),
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled",
    ...extra,
  };
};

const options = (extra: Partial<DashboardOptions> = {}): DashboardOptions => ({
  range: "4w",
  groupBy: "provider",
  targets: {},
  prices: {},
  groupsOf: ({ driver }) => [{ key: String(driver), label: String(driver) }],
  ...extra,
});

describe("periodScore and targetOf", () => {
  it("scores use against the planned share and never above 100", () => {
    expect(periodScore(59, 100)).toBe(59);
    expect(periodScore(31, 30)).toBe(100);
    expect(periodScore(15, 30)).toBe(50);
  });

  it("plans the whole subscription unless a valid target is set", () => {
    expect(targetOf({}, "a")).toBe(100);
    expect(targetOf({ a: 30 }, "a")).toBe(30);
    expect(targetOf({ a: 0 }, "a")).toBe(100);
  });
});

describe("dashboardColumns", () => {
  it("draws twelve weeks ending with this one, or twelve months for the year", () => {
    const weeks = dashboardColumns(now, "4w");
    expect(weeks).toHaveLength(12);
    expect(weeks[11]?.start).toBe(monday(0));
    expect(weeks[0]?.start).toBe(monday(11));
    const months = dashboardColumns(now, "1y");
    expect(months[11]?.start).toBe(new Date(2026, 10, 1).getTime());
    expect(months[11]?.end).toBe(new Date(2026, 11, 1).getTime());
    expect(months[0]?.start).toBe(new Date(2025, 11, 1).getTime());
  });
});

describe("efficiencyDashboard", () => {
  const ledger = [
    period("codex:a@x.dev", 3, 40),
    period("codex:a@x.dev", 2, 50),
    period("codex:a@x.dev", 1, 60),
    period("codex:a@x.dev", 0, 70),
    period("muse:a@x.dev", 1, 31),
    period("muse:a@x.dev", 0, 29),
  ];

  it("averages over closed periods and gives a spare its own target", () => {
    const plain = efficiencyDashboard(ledger, now, options());
    // Six resets: 40, 50, 60, 70, 31 and 29.
    expect(plain.score).toBeCloseTo(280 / 6);
    expect(plain.unusedPercent).toBeCloseTo(100 - 280 / 6);
    expect(plain.weightedByPrice).toBe(false);

    const spare = efficiencyDashboard(ledger, now, options({ targets: { "muse:a@x.dev": 30 } }));
    // Muse: 31 of 30 is 100, 29 of 30 is 96.67.
    expect(spare.score).toBeCloseTo((220 + 100 + (29 / 30) * 100) / 6);
    const museGroup = spare.groups.find((group) => group.key === "muse");
    expect(museGroup).toMatchObject({ targetPercent: 30, usedPercent: 30, resets: 2 });
  });

  it("weighs by plan price only when every account in the range has one", () => {
    const partly = efficiencyDashboard(ledger, now, options({ prices: { "codex:a@x.dev": 200 } }));
    expect(partly.weightedByPrice).toBe(false);
    const priced = efficiencyDashboard(
      ledger,
      now,
      options({ prices: { "codex:a@x.dev": 200, "muse:a@x.dev": 50 } }),
    );
    expect(priced.weightedByPrice).toBe(true);
    // Each period carries its plan's price: four at 200, two at 50.
    expect(priced.score).toBeCloseTo((220 * 200 + 60 * 50) / (4 * 200 + 2 * 50));
  });

  it("marks the range's columns, scores each, and compares with the span before", () => {
    const older = [period("codex:a@x.dev", 5, 20), period("codex:a@x.dev", 4, 30)];
    const dashboard = efficiencyDashboard([...older, ...ledger], now, options());
    expect(dashboard.columns.filter((column) => column.inRange)).toHaveLength(4);
    expect(dashboard.columns[11]?.score).toBeCloseTo((70 + 29) / 2);
    expect(dashboard.columns[5]?.score).toBeNull();
    expect(dashboard.previousScore).toBeCloseTo(25);
    expect(dashboard.periods[0]?.endedAt).toBe(monday(0) + 2 * DAY);
  });

  it("gives no score from a single reset", () => {
    const dashboard = efficiencyDashboard([period("codex:a@x.dev", 0, 70)], now, options());
    expect(dashboard.score).toBeNull();
    expect(dashboard.resets).toBe(1);
    expect(dashboard.columns[11]).toMatchObject({ score: 70, resets: 1 });
  });

  it("does not compare a year with one the ledger never kept", () => {
    // Resets from thirteen months back would otherwise pass for the whole previous year.
    const old = [56, 55, 54].map((weeksAgo) => period("codex:a@x.dev", weeksAgo, 20));
    const year = efficiencyDashboard([...old, ...ledger], now, options({ range: "1y" }));
    expect(year.score).not.toBeNull();
    expect(year.previousScore).toBeNull();
  });

  it("flags a range holding a reset read long before it happened", () => {
    const dashboard = efficiencyDashboard(
      [
        period("codex:a@x.dev", 1, 60),
        period("codex:a@x.dev", 0, 10, { lastReadAt: iso(monday(0) - 3 * DAY) }),
      ],
      now,
      options(),
    );
    expect(dashboard.upperBound).toBe(true);
    expect(dashboard.columns[11]?.upperBound).toBe(true);
    expect(dashboard.columns[10]?.upperBound).toBe(false);
  });

  it("counts each reset in one group, so groups add up to the range", () => {
    const dashboard = efficiencyDashboard(
      ledger,
      now,
      options({
        groupBy: "machine",
        groupsOf: ({ accountKey }) =>
          accountKey.startsWith("codex")
            ? [{ key: "m1|m4", label: "m1 + m4" }]
            : [{ key: "m4", label: "m4" }],
      }),
    );
    expect(dashboard.groups.map((group) => [group.key, group.resets])).toEqual([
      ["m1|m4", 4],
      ["m4", 2],
    ]);
    expect(dashboard.groups.reduce((sum, group) => sum + group.resets, 0)).toBe(dashboard.resets);
  });
});

describe("rangeTokensLost and busiestDay", () => {
  it("sums accounts whose every loss is measurable and leaves the others out", () => {
    const periods = accountWidePeriods([
      period("codex:a@x.dev", 1, 60),
      period("codex:a@x.dev", 0, 70),
      period("muse:a@x.dev", 1, 31),
      period("muse:a@x.dev", 0, 29),
    ]);
    const lost = rangeTokensLost(periods, (entry) =>
      entry.accountKey.startsWith("muse") && entry.usedPercent === 29 ? null : entry.lostPercent,
    );
    // Codex lost 40 and 30; Muse has one reset that cannot be measured.
    expect(lost).toBe(70);
    expect(rangeTokensLost(periods, () => null)).toBeNull();
  });

  it("names the day that took the most of the quota", () => {
    const day = (index: number) => new Date(2026, 10, 3 + index, 12).getTime();
    const samples = [0, 4, 9, 30, 34].map((usedPercent, index) => ({ at: day(index), usedPercent }));
    expect(busiestDay(samples)).toEqual({ day: new Date(2026, 10, 6).getTime(), percent: 21 });
    expect(busiestDay(samples.slice(0, 2))).toBeNull();
  });
});

describe("accountWidePeriods", () => {
  it("keeps the weekly account-wide window and drops a model family's", () => {
    const kept = accountWidePeriods([
      period("codex:a@x.dev", 0, 70),
      period("codex:a@x.dev", 0, 10, { windowId: "opus", modelScope: "opus" }),
      period("codex:a@x.dev", 0, 5, { windowId: "monthly", windowKind: "monthly" }),
    ]);
    expect(kept.map((entry) => entry.usedPercent)).toEqual([70]);
  });
});
