/**
 * The effectiveness index in the usage ring's panel: how much of each
 * subscription's weekly quota was used before it reset, over the last four
 * weeks, with the two weeks before this one and this week's projection.
 *
 * Pure: closed periods come from the reset ledger, this week's numbers from the
 * live windows, and nothing unknown becomes a number.
 */
import type { ServerProvider, UsageResetPeriod } from "@specweave-studio/contracts";
import { projectedUnusedPercent } from "@specweave-studio/shared/quotaAlerts";

import { accountWidePeriods } from "./efficiency";
import { type ProviderGroup, groupResolver, providerGroupOf } from "./providerGroups";
import { weekStartOf } from "./resetReportModel";
import type { SubscriptionRow } from "./subscriptionRows";

const DAY = 24 * 60 * 60_000;
/** The index looks back four weeks: long enough to average, short enough to act on. */
export const INDEX_DAYS = 28;
/** A window younger than this has no pace worth projecting. */
const MIN_PACE_MS = DAY;

export interface IndexWeek {
  /** Monday of the week, local time. */
  readonly start: number;
  /** Average used at the resets that week; null when none was recorded. */
  readonly usedPercent: number | null;
}

export interface IndexNextReset {
  readonly at: number;
  /** What the pace so far leaves unused at that reset; null before the window has run a day. */
  readonly projectedLeftPercent: number | null;
}

export interface IndexProvider {
  readonly driver: ServerProvider["driver"];
  /** The provider this row counts: a built-in driver, or one ACP Registry agent. */
  readonly group: ProviderGroup;
  /** Average used before reset over the last four weeks; null with no reset recorded yet. */
  readonly usedPercent: number | null;
  readonly resets: number;
  /** The newest recorded reset, or null with none. */
  readonly lastResetAt: number | null;
  /** The two weeks before this one, oldest first. */
  readonly pastWeeks: readonly [IndexWeek, IndexWeek];
  /** This week's projected use at its reset; null when no window has a pace yet. */
  readonly projectedUsedPercent: number | null;
  readonly nextReset: IndexNextReset | null;
  /** Used so far in the soonest window, as read now; null with no live window. */
  readonly usedNowPercent: number | null;
  /** Every live account of the provider has used its whole account-wide window. */
  readonly atLimit: boolean;
  /** The soonest of those windows' resets, while at the limit; null when none is known. */
  readonly atLimitUntil: number | null;
}

export interface EffectivenessIndex {
  /** Average used before reset over every reset of the last four weeks; null with none. */
  readonly usedPercent: number | null;
  readonly resets: number;
  readonly providers: readonly IndexProvider[];
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** The window a subscription is judged by now: its account-wide weekly or monthly one. */
function mainWindow(row: SubscriptionRow) {
  const long = row.windows.filter((window) => window.long && !window.scoped);
  return (
    long.find((window) => window.durationMs !== null && window.durationMs <= 8 * DAY) ?? long[0]
  );
}

export function effectivenessIndex(
  rows: readonly SubscriptionRow[],
  periods: readonly UsageResetPeriod[],
  now: number,
): EffectivenessIndex {
  const closed = accountWidePeriods(periods);
  const since = now - INDEX_DAYS * DAY;
  const thisWeek = weekStartOf(now);
  // Half a day past each Monday, so a daylight-saving week still lands on its own Monday.
  const lastWeek = weekStartOf(thisWeek - 7 * DAY + DAY / 2);
  const weekBefore = weekStartOf(lastWeek - 7 * DAY + DAY / 2);

  const groupOf = groupResolver(rows);
  const groups = new Map<string, ProviderGroup>();
  const rowGroup = new Map<SubscriptionRow, ProviderGroup>();
  for (const row of rows) {
    const group = providerGroupOf(row);
    rowGroup.set(row, group);
    if (!groups.has(group.key)) groups.set(group.key, group);
  }
  const periodGroup = (period: (typeof closed)[number]) =>
    groupOf(period.accountKey, period.driver).key;
  for (const period of closed) {
    if (period.endedAt < since) continue;
    const group = groupOf(period.accountKey, period.driver);
    if (!groups.has(group.key)) groups.set(group.key, group);
  }

  const providers = [...groups.values()].map((group): IndexProvider => {
    const own = closed.filter((period) => periodGroup(period) === group.key);
    const recent = own.filter((period) => period.endedAt >= since && period.endedAt <= now);
    const week = (start: number, end: number): IndexWeek => ({
      start,
      usedPercent: mean(
        own
          .filter((period) => period.endedAt >= start && period.endedAt < end)
          .map((period) => period.usedPercent),
      ),
    });
    // Only a window with a reset time and a length has a pace, and not before it has run a
    // day: an hour into a week, one busy hour would project the whole quota spent. A provider
    // with no reset recorded yet has no history to say its pace holds, so it shows its
    // reading instead of a projection.
    const projects = own.length > 0;
    const live = rows
      .filter((row) => rowGroup.get(row)?.key === group.key && !row.offline)
      .flatMap((row) => {
        const window = mainWindow(row);
        if (!window || window.resetsAt === null || window.resetsAt <= now) return [];
        const elapsed =
          window.durationMs === null ? null : window.durationMs - (window.resetsAt - now);
        return [
          {
            resetsAt: window.resetsAt,
            leftNow: window.leftPercent,
            left:
              !projects || elapsed === null || elapsed < MIN_PACE_MS
                ? null
                : projectedUnusedPercent(
                    {
                      leftPercent: window.leftPercent,
                      resetsAt: window.resetsAt,
                      durationMs: window.durationMs,
                    },
                    now,
                  ),
          },
        ];
      });
    const soonest = live.toSorted((left, right) => left.resetsAt - right.resetsAt)[0];
    const projectedLeft = mean(live.flatMap((entry) => (entry.left === null ? [] : [entry.left])));
    // At its limit when every live account is blocked, as its own row decides it (the
    // provider's run permission and spend controls first, then a spent account-wide window,
    // never a rounded 0% left). It frees up when the first account does: an account blocked
    // only by spent windows frees when the last of them resets; any other block has no date.
    const liveRows = rows.filter((row) => rowGroup.get(row)?.key === group.key && !row.offline);
    const spent = liveRows.length > 0 && liveRows.every((row) => row.atLimit);
    const freeAt = (row: SubscriptionRow): number | null => {
      const blocking = row.windows.filter((window) => window.accountWide && window.spent);
      if (blocking.length === 0) return null;
      const resets = blocking.map((window) => window.resetsAt);
      if (resets.some((at) => at === null || at <= now)) return null;
      return Math.max(...(resets as number[]));
    };
    const spentResets = liveRows.flatMap((row) => {
      const at = freeAt(row);
      return at === null ? [] : [at];
    });
    return {
      driver: group.driver,
      group,
      usedPercent: mean(recent.map((period) => period.usedPercent)),
      resets: recent.length,
      lastResetAt: own.at(-1)?.endedAt ?? null,
      pastWeeks: [week(weekBefore, lastWeek), week(lastWeek, thisWeek)],
      projectedUsedPercent: projectedLeft === null ? null : 100 - projectedLeft,
      nextReset: soonest ? { at: soonest.resetsAt, projectedLeftPercent: soonest.left } : null,
      usedNowPercent: soonest ? 100 - soonest.leftNow : null,
      atLimit: spent,
      atLimitUntil: spent && spentResets.length > 0 ? Math.min(...spentResets) : null,
    };
  });

  const recent = closed.filter((period) => period.endedAt >= since && period.endedAt <= now);
  return {
    usedPercent: mean(recent.map((period) => period.usedPercent)),
    resets: recent.length,
    // Most recorded resets first, then the soonest reset: the rows worth reading lead.
    providers: providers
      .filter((provider) => provider.resets > 0 || provider.nextReset !== null || provider.atLimit)
      .toSorted(
        (left, right) =>
          right.resets - left.resets ||
          (left.nextReset?.at ?? Number.POSITIVE_INFINITY) -
            (right.nextReset?.at ?? Number.POSITIVE_INFINITY),
      ),
  };
}
