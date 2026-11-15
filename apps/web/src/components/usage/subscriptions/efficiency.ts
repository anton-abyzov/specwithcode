/**
 * The efficiency score behind the Subscriptions dashboard: of the quota a
 * person planned to use, how much was used before each reset. A subscription
 * kept as a spare gets a target below 100%, and meeting the target counts as
 * full marks, so it does not pull the score down.
 *
 * Everything here is pure and works on closed periods from the reset ledger.
 */
import type { UsageResetPeriod } from "@specweave-studio/contracts";
import { lossIsUpperBound } from "@specweave-studio/shared/usageResetLedger";

import { weekStartOf } from "./resetReportModel";

const DAY = 24 * 60 * 60_000;
const COLUMNS = 12;

export type DashboardRange = "1w" | "4w" | "12w" | "1y";
export type DashboardGroupBy = "provider" | "account" | "machine";

export const DASHBOARD_RANGES: ReadonlyArray<{
  readonly value: DashboardRange;
  readonly label: string;
  /** Columns of the chart that the range covers, counted from the newest. */
  readonly columns: number;
}> = [
  { value: "1w", label: "1W", columns: 1 },
  { value: "4w", label: "4W", columns: 4 },
  { value: "12w", label: "12W", columns: 12 },
  { value: "1y", label: "1Y", columns: 12 },
];

/** One reset of an account's account-wide window, with times as numbers. */
export interface EfficiencyPeriod {
  readonly accountKey: string;
  readonly driver: UsageResetPeriod["driver"];
  readonly windowId: string;
  readonly windowKind: UsageResetPeriod["windowKind"];
  readonly startedAt: number | null;
  readonly endedAt: number;
  readonly lastReadAt: number;
  readonly usedPercent: number;
  readonly lostPercent: number;
  readonly cause: UsageResetPeriod["cause"];
  /** Read long before the reset: used is at least, and lost at most, what is shown. */
  readonly upperBound: boolean;
}

/**
 * Each account's resets on its account-wide window, the weekly one where it
 * has both, oldest first. A model family's window is a slice of the same
 * quota and would count twice.
 */
export function accountWidePeriods(periods: readonly UsageResetPeriod[]): EfficiencyPeriod[] {
  const byAccount = new Map<string, UsageResetPeriod[]>();
  for (const period of periods) {
    if (period.modelScope !== undefined) continue;
    const list = byAccount.get(period.accountKey) ?? [];
    list.push(period);
    byAccount.set(period.accountKey, list);
  }
  const result: EfficiencyPeriod[] = [];
  for (const all of byAccount.values()) {
    const kind = all.some((period) => period.windowKind === "weekly")
      ? "weekly"
      : (all[0]?.windowKind ?? "weekly");
    const own = all.filter((period) => period.windowKind === kind);
    const windowId = own.toSorted(
      (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
    )[0]?.windowId;
    for (const period of own) {
      if (period.windowId !== windowId) continue;
      const endedAt = Date.parse(period.endedAt);
      const lastReadAt = Date.parse(period.lastReadAt);
      if (!Number.isFinite(endedAt) || !Number.isFinite(lastReadAt)) continue;
      const startedAt = period.startedAt === undefined ? null : Date.parse(period.startedAt);
      result.push({
        accountKey: period.accountKey,
        driver: period.driver,
        windowId: period.windowId,
        windowKind: period.windowKind,
        startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null,
        endedAt,
        lastReadAt,
        usedPercent: period.usedPercentAtReset,
        lostPercent: period.lostPercent,
        cause: period.cause,
        upperBound: lossIsUpperBound({ endedAt, lastReadAt }),
      });
    }
  }
  return result.toSorted((left, right) => left.endedAt - right.endedAt);
}

/** The planned share of a subscription; 100 unless the person set less. */
export function targetOf(targets: Readonly<Record<string, number>>, accountKey: string): number {
  const target = targets[accountKey];
  return target !== undefined && target >= 1 && target <= 100 ? target : 100;
}

/** How much of the plan a reset met, 0 to 100. Using more than planned is still 100. */
export function periodScore(usedPercent: number, targetPercent: number): number {
  return Math.min(100, (Math.max(0, usedPercent) / targetPercent) * 100);
}

export interface DashboardGroup {
  readonly key: string;
  readonly label: string;
  /** Accounts in the group; a target can be edited where there is exactly one. */
  readonly accountKeys: readonly string[];
  readonly usedPercent: number;
  readonly targetPercent: number;
  readonly score: number;
  readonly resets: number;
}

export interface DashboardColumn {
  readonly start: number;
  readonly end: number;
  /** Null when no reset was recorded in the column. */
  readonly score: number | null;
  readonly resets: number;
  /** A reset in the column was read long before it happened, so the score is a floor. */
  readonly upperBound: boolean;
  readonly inRange: boolean;
  /** The column's groups, for the hover readout. */
  readonly groups: readonly DashboardGroup[];
}

export interface EfficiencyDashboard {
  readonly columns: readonly DashboardColumn[];
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Null with fewer than two resets in the range: one reset is not a score. */
  readonly score: number | null;
  /**
   * The same score over the equally long span before the range. Null for the
   * year: the ledger keeps one year, so the year before it is not there.
   */
  readonly previousScore: number | null;
  /** Average left unused per reset in the range. */
  readonly unusedPercent: number | null;
  readonly upperBound: boolean;
  readonly resets: number;
  readonly groups: readonly DashboardGroup[];
  /** Resets in the range, newest first. */
  readonly periods: readonly EfficiencyPeriod[];
  /** True when every account in the range has a price, so the score is weighted by it. */
  readonly weightedByPrice: boolean;
}

export interface DashboardOptions {
  readonly range: DashboardRange;
  readonly groupBy: DashboardGroupBy;
  readonly targets: Readonly<Record<string, number>>;
  readonly prices: Readonly<Record<string, number>>;
  /** The group an account belongs to under `groupBy`; one each, so no reset counts twice. */
  readonly groupsOf: (
    period: Pick<EfficiencyPeriod, "accountKey" | "driver">,
  ) => ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

function monthStart(at: number, monthsBack = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth() - monthsBack, 1).getTime();
}

/** The chart's twelve columns, oldest first: weeks, or months for the year range. */
export function dashboardColumns(
  now: number,
  range: DashboardRange,
): Array<{ readonly start: number; readonly end: number }> {
  if (range === "1y") {
    return Array.from({ length: COLUMNS }, (_, index) => ({
      start: monthStart(now, COLUMNS - 1 - index),
      end: monthStart(now, COLUMNS - 2 - index),
    }));
  }
  const thisWeek = weekStartOf(now);
  return Array.from({ length: COLUMNS }, (_, index) => {
    // Half a day past each Monday, so a daylight-saving week still lands on its own Monday.
    const start = weekStartOf(thisWeek - (COLUMNS - 1 - index) * 7 * DAY + DAY / 2);
    return { start, end: weekStartOf(start + 7 * DAY + DAY / 2) };
  });
}

interface Weighted {
  readonly period: EfficiencyPeriod;
  readonly weight: number;
  readonly target: number;
}

function weighted(
  periods: readonly EfficiencyPeriod[],
  options: Pick<DashboardOptions, "targets" | "prices">,
): { readonly entries: Weighted[]; readonly byPrice: boolean } {
  const byPrice =
    periods.length > 0 &&
    periods.every((period) => (options.prices[period.accountKey] ?? 0) > 0);
  // Every closed period counts once, or by its plan's price: a week of a 200 plan left unused
  // costs more than a week of a 20 one.
  return {
    byPrice,
    entries: periods.map((period) => ({
      period,
      weight: byPrice ? (options.prices[period.accountKey] ?? 0) : 1,
      target: targetOf(options.targets, period.accountKey),
    })),
  };
}

function mean(entries: readonly Weighted[], value: (entry: Weighted) => number): number | null {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (entries.length === 0 || total <= 0) return null;
  return entries.reduce((sum, entry) => sum + value(entry) * entry.weight, 0) / total;
}

const scoreOf = (entry: Weighted) => periodScore(entry.period.usedPercent, entry.target);

function groupsOf(
  periods: readonly EfficiencyPeriod[],
  options: DashboardOptions,
): DashboardGroup[] {
  const { entries } = weighted(periods, options);
  const groups = new Map<string, { label: string; entries: Weighted[] }>();
  for (const entry of entries) {
    for (const group of options.groupsOf(entry.period)) {
      const existing = groups.get(group.key) ?? { label: group.label, entries: [] };
      existing.entries.push(entry);
      groups.set(group.key, existing);
    }
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      label: group.label,
      accountKeys: [...new Set(group.entries.map((entry) => entry.period.accountKey))],
      usedPercent: mean(group.entries, (entry) => entry.period.usedPercent) ?? 0,
      targetPercent: mean(group.entries, (entry) => entry.target) ?? 100,
      score: mean(group.entries, scoreOf) ?? 0,
      resets: group.entries.length,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

function scoreBetween(
  periods: readonly EfficiencyPeriod[],
  from: number,
  to: number,
  options: DashboardOptions,
): { readonly score: number | null; readonly inside: EfficiencyPeriod[] } {
  const inside = periods.filter((period) => period.endedAt >= from && period.endedAt < to);
  const { entries } = weighted(inside, options);
  return { score: inside.length < 2 ? null : mean(entries, scoreOf), inside };
}

/** Everything the dashboard shows for one range and grouping. */
export function efficiencyDashboard(
  ledger: readonly UsageResetPeriod[],
  now: number,
  options: DashboardOptions,
): EfficiencyDashboard {
  const periods = accountWidePeriods(ledger);
  const spans = dashboardColumns(now, options.range);
  const covered = DASHBOARD_RANGES.find((range) => range.value === options.range)?.columns ?? 4;
  const rangeStart = spans[spans.length - covered]!.start;
  const rangeEnd = spans[spans.length - 1]!.end;
  const columns = spans.map((span, index): DashboardColumn => {
    const inside = periods.filter(
      (period) => period.endedAt >= span.start && period.endedAt < span.end,
    );
    const { entries } = weighted(inside, options);
    return {
      ...span,
      score: mean(entries, scoreOf),
      resets: inside.length,
      upperBound: inside.some((period) => period.upperBound),
      inRange: index >= spans.length - covered,
      groups: groupsOf(inside, options),
    };
  });
  const current = scoreBetween(periods, rangeStart, rangeEnd, options);
  const previous =
    options.range === "1y"
      ? { score: null }
      : scoreBetween(periods, rangeStart - (rangeEnd - rangeStart), rangeStart, options);
  const { entries, byPrice } = weighted(current.inside, options);
  return {
    columns,
    rangeStart,
    rangeEnd,
    score: current.score,
    previousScore: previous.score,
    unusedPercent: mean(entries, (entry) => entry.period.lostPercent),
    upperBound: current.inside.some((period) => period.upperBound),
    resets: current.inside.length,
    groups: groupsOf(current.inside, options),
    periods: current.inside.toSorted((left, right) => right.endedAt - left.endedAt),
    weightedByPrice: byPrice,
  };
}

/**
 * Tokens the unused quota of these resets would have bought. An account
 * counts only when every one of its losses can be measured, so a partial
 * figure never stands in for the range; null when no account can.
 */
export function rangeTokensLost(
  periods: readonly EfficiencyPeriod[],
  tokensLostOf: (period: EfficiencyPeriod) => number | null,
): number | null {
  const byAccount = new Map<string, number | null>();
  for (const period of periods) {
    const sofar = byAccount.has(period.accountKey) ? byAccount.get(period.accountKey)! : 0;
    const lost = sofar === null ? null : tokensLostOf(period);
    byAccount.set(period.accountKey, sofar === null || lost === null ? null : sofar + lost);
  }
  const measured = [...byAccount.values()].filter((value): value is number => value !== null && value > 0);
  return measured.length === 0 ? null : Math.round(measured.reduce((sum, value) => sum + value, 0));
}

/**
 * The local day that took the most of the quota, from the samples read
 * through a period; null with too few samples to tell days apart.
 */
export function busiestDay(
  samples: ReadonlyArray<{ readonly at: number; readonly usedPercent: number }>,
): { readonly day: number; readonly percent: number } | null {
  if (samples.length < 3) return null;
  const ordered = samples.toSorted((left, right) => left.at - right.at);
  const byDay = new Map<number, number>();
  for (let index = 1; index < ordered.length; index += 1) {
    const rise = ordered[index]!.usedPercent - ordered[index - 1]!.usedPercent;
    if (rise <= 0) continue;
    const date = new Date(ordered[index]!.at);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    byDay.set(day, (byDay.get(day) ?? 0) + rise);
  }
  const top = [...byDay].toSorted((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  return top === undefined ? null : { day: top[0], percent: top[1] };
}
