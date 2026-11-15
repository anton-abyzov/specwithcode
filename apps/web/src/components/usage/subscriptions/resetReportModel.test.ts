import { ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resetReport, resetReportMarkdown, weekStartOf } from "./resetReportModel";

const DAY = 24 * 3_600_000;
// Saturday November 14, 2026, 8 PM local.
const now = new Date(2026, 10, 14, 20, 0).getTime();
const monday = (weeksAgo: number) => new Date(2026, 10, 9 - 7 * weeksAgo).getTime();
const iso = (at: number) => new Date(at).toISOString();
const codex = ProviderDriverKind.make("codex");

const period = (
  accountKey: string,
  endedAt: number,
  used: number,
  extra: Partial<UsageResetPeriod> = {},
): UsageResetPeriod => ({
  accountKey,
  driver: codex,
  windowId: "secondary",
  windowKind: "weekly",
  startedAt: iso(endedAt - 7 * DAY),
  endedAt: iso(endedAt),
  lastReadAt: iso(endedAt - 3_600_000),
  usedPercentAtReset: used,
  lostPercent: 100 - used,
  cause: "scheduled",
  ...extra,
});

describe("resetReport", () => {
  it("puts each reset in its week and averages the loss", () => {
    const report = resetReport(
      [
        period("codex:a@x.dev", monday(2) + 2 * DAY, 40),
        period("codex:a@x.dev", monday(1) + 2 * DAY, 55),
        period("codex:a@x.dev", monday(0) + 2 * DAY, 59),
      ],
      now,
    );
    expect(report.weekStarts).toEqual([monday(3), monday(2), monday(1), monday(0)]);
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]?.weeks).toEqual([
      null,
      { usedPercent: 40, lostPercent: 60, resets: 1, upperBound: false },
      { usedPercent: 55, lostPercent: 45, resets: 1, upperBound: false },
      { usedPercent: 59, lostPercent: 41, resets: 1, upperBound: false },
    ]);
    expect(report.accounts[0]?.latest?.lostPercent).toBe(41);
    expect(Math.round(report.accounts[0]?.averageLostPercent ?? 0)).toBe(49);
    expect(report.lostThisWeek).toBe(41);
    expect(report.lostAllWeeks).toBe(146);
  });

  it("adds two resets in one week, and lists the account losing most first", () => {
    const report = resetReport(
      [
        period("codex:a@x.dev", monday(0) + DAY, 90),
        period("codex:a@x.dev", monday(0) + 3 * DAY, 30, { cause: "early" }),
        period("codex:b@x.dev", monday(0) + 2 * DAY, 5),
      ],
      now,
    );
    expect(report.accounts.map((account) => account.accountKey)).toEqual([
      "codex:b@x.dev",
      "codex:a@x.dev",
    ]);
    expect(report.accounts[1]?.weeks[3]).toEqual({ usedPercent: 120, lostPercent: 80, resets: 2, upperBound: false });
  });

  it("reports the account-wide weekly window, never a model family or a second kind", () => {
    const report = resetReport(
      [
        period("claudeAgent:a@x.dev", monday(0) + DAY, 80, { windowId: "seven_day" }),
        period("claudeAgent:a@x.dev", monday(0) + DAY, 10, {
          windowId: "seven_day_fable",
          modelScope: "Fable",
        }),
        period("claudeAgent:a@x.dev", monday(0) + 2 * DAY, 20, {
          windowId: "month",
          windowKind: "monthly",
        }),
      ],
      now,
    );
    expect(report.accounts[0]?.weeks[3]).toEqual({ usedPercent: 80, lostPercent: 20, resets: 1, upperBound: false });
  });

  it("leaves out resets older than the report and accounts with none in it", () => {
    const report = resetReport([period("codex:a@x.dev", monday(6), 10)], now);
    expect(report.accounts).toEqual([]);
    expect(report.lostAllWeeks).toBe(0);
  });

  it("estimates lost tokens from the spend behind the used percent", () => {
    const spend = new Map([["codex:a@x.dev", 300_000_000]]);
    const report = resetReport(
      [
        period("codex:a@x.dev", monday(0) + 2 * DAY, 60),
        period("codex:b@x.dev", monday(0) + 2 * DAY, 60),
        period("codex:c@x.dev", monday(0) + 2 * DAY, 3),
        period("codex:d@x.dev", monday(0) + 2 * DAY, 60, { startedAt: undefined }),
      ],
      now,
      { tokensSpent: (account) => spend.get(account.accountKey) ?? (account.accountKey.endsWith("b@x.dev") ? null : 1_000) },
    );
    const estimate = (key: string) =>
      report.accounts.find((account) => account.accountKey === key)?.tokensLostEstimate;
    // 300M bought 60%, so the unused 40% was worth 200M.
    expect(estimate("codex:a@x.dev")).toBe(200_000_000);
    // Not attributable to one account, too little used, and a period with no known start.
    expect(estimate("codex:b@x.dev")).toBeNull();
    expect(estimate("codex:c@x.dev")).toBeNull();
    expect(estimate("codex:d@x.dev")).toBeNull();
  });

  it("gives no estimate at all without a spend source", () => {
    const report = resetReport([period("codex:a@x.dev", monday(0) + DAY, 60)], now);
    expect(report.accounts[0]?.tokensLostEstimate).toBeNull();
  });
});

describe("weekStartOf", () => {
  it("is the Monday on or before the time, at local midnight", () => {
    expect(weekStartOf(now)).toBe(monday(0));
    expect(weekStartOf(monday(0))).toBe(monday(0));
    expect(weekStartOf(monday(0) - 1)).toBe(monday(1));
  });
});

describe("resetReportMarkdown", () => {
  it("writes a table with unknowns in words, never as zero", () => {
    const report = resetReport(
      [period("codex:a@x.dev", monday(0) + 2 * DAY, 59)],
      now,
      { weeks: 2 },
    );
    const markdown = resetReportMarkdown(
      report,
      () => "Codex Pro · m1",
      (week) => new Date(week).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      String,
    );
    expect(markdown).toContain("| Account | Nov 2 | Nov 9 | Average lost | Tokens lost (estimate) |");
    expect(markdown).toContain(
      "| Codex Pro · m1 | No reset recorded | 59% used, 41% lost | 41% over 1 reset | Not measurable |",
    );
    expect(markdown).toContain("Lost this week: 41% of one window.");
  });

  it("marks a loss read long before its reset as an upper bound and withholds its tokens", () => {
    const report = resetReport(
      [
        period("codex:a@x.dev", monday(0) + 2 * DAY, 10, {
          lastReadAt: iso(monday(0) + 2 * DAY - 5 * DAY),
        }),
      ],
      now,
      { tokensSpent: () => 1_000_000 },
    );
    const account = report.accounts[0];
    expect(account?.weeks[3]).toMatchObject({ lostPercent: 90, upperBound: true });
    expect(account?.upperBound).toBe(true);
    expect(account?.tokensLostEstimate).toBeNull();
    expect(report.lostThisWeekUpperBound).toBe(true);
    expect(report.lostAllWeeksUpperBound).toBe(true);
    const markdown = resetReportMarkdown(
      report,
      () => "Codex Pro",
      () => "week",
      String,
    );
    expect(markdown).toContain("10% used, up to 90% lost");
    expect(markdown).toContain("Lost this week: up to 90% of one window.");
  });
});
