/**
 * The time windows the owner's usage numbers are counted in: the last 24
 * hours, 7 days and 30 days, and whole weeks that start on a Monday in UTC.
 */
import {
  RELAY_ADMIN_USAGE_WEEKS,
  type RelayAdminUsageWeek,
  type RelayAdminUsageWindows,
} from "@specweave-studio/contracts/relayAdmin";
import * as DateTime from "effect/DateTime";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface UsageWindowStarts {
  readonly day: number;
  readonly week: number;
  readonly month: number;
}

/** Where each window starts, in milliseconds since the epoch. */
export function usageWindowStarts(nowMs: number): UsageWindowStarts {
  return { day: nowMs - DAY_MS, week: nowMs - 7 * DAY_MS, month: nowMs - 30 * DAY_MS };
}

/** The Monday 00:00 UTC of each week, oldest first; the last one is the running week. */
export function usageWeekStarts(nowMs: number): ReadonlyArray<number> {
  const daysSinceEpoch = Math.floor(nowMs / DAY_MS);
  // January 1, 1970 was a Thursday, three days after a Monday.
  const sinceMonday = (((daysSinceEpoch + 3) % 7) + 7) % 7;
  const thisWeek = (daysSinceEpoch - sinceMonday) * DAY_MS;
  return Array.from(
    { length: RELAY_ADMIN_USAGE_WEEKS },
    (_, index) => thisWeek - (RELAY_ADMIN_USAGE_WEEKS - 1 - index) * WEEK_MS,
  );
}

/** A moment as the ISO text the relay stores, in UTC. */
export const usageIso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** How many of the moments fall in each window. A moment after now is not counted. */
export function countInWindows(
  moments: ReadonlyArray<number>,
  nowMs: number,
): RelayAdminUsageWindows {
  const starts = usageWindowStarts(nowMs);
  const since = (start: number) =>
    moments.filter((moment) => moment >= start && moment <= nowMs).length;
  return { day: since(starts.day), week: since(starts.week), month: since(starts.month) };
}

/** The moments counted by the week they fall in. Ones outside the weeks are left out. */
export function countByWeek(
  moments: ReadonlyArray<number>,
  nowMs: number,
): ReadonlyArray<RelayAdminUsageWeek> {
  const starts = usageWeekStarts(nowMs);
  const counts = starts.map(() => 0);
  const first = starts[0] ?? nowMs;
  for (const moment of moments) {
    if (!Number.isFinite(moment) || moment < first || moment > nowMs) continue;
    const index = Math.min(Math.floor((moment - first) / WEEK_MS), counts.length - 1);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return starts.map((start, index) => ({
    weekStart: usageIso(start),
    count: counts[index] ?? 0,
  }));
}
