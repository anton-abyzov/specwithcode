import { ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DashboardOptions,
  accountWidePeriods,
  dashboardColumns,
  efficiencyDashboard,
  periodScore,
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

  it("weighs each account equally and gives a spare its own target", () => {
    const plain = efficiencyDashboard(ledger, now, options());
    // Codex averages 55, Muse 30: the mean of the two accounts.
    expect(plain.score).toBeCloseTo(42.5);
    expect(plain.unusedPercent).toBeCloseTo(57.5);
    expect(plain.weightedByPrice).toBe(false);

    const spare = efficiencyDashboard(ledger, now, options({ targets: { "muse:a@x.dev": 30 } }));
    // Muse: 31 of 30 is 100, 29 of 30 is 96.67.
    expect(spare.score).toBeCloseTo((55 + (100 + (29 / 30) * 100) / 2) / 2);
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
    expect(priced.score).toBeCloseTo((55 * 200 + 30 * 50) / 250);
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
  });

  it("puts one account in every machine group it is signed in on", () => {
    const dashboard = efficiencyDashboard(
      ledger,
      now,
      options({
        groupBy: "machine",
        groupsOf: ({ accountKey }) =>
          accountKey.startsWith("codex")
            ? [
                { key: "m1", label: "m1" },
                { key: "m4", label: "m4" },
              ]
            : [{ key: "m4", label: "m4" }],
      }),
    );
    expect(dashboard.groups.map((group) => [group.key, group.resets])).toEqual([
      ["m1", 4],
      ["m4", 6],
    ]);
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
