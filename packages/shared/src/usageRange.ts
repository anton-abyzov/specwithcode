/**
 * The Usage page's date range (1456): one of the presets or a custom span of
 * whole days, at most {@link USAGE_CUSTOM_RANGE_MAX_DAYS}, ending today or
 * earlier. Cost, Tokens, Machines and Delivered all read this one range.
 *
 * @module usageRange
 */
import { UsageDay, type UsageSummaryInput } from "@specweave-studio/contracts";

import { formatDayShort, makeWindow } from "./usageFormat.ts";

/** One cap every range-driven tab can honour: the machine report's limit. */
export const USAGE_CUSTOM_RANGE_MAX_DAYS = 92;

export const USAGE_PRESET_DAYS = [1, 7, 30, 90] as const;
export type UsagePresetDays = (typeof USAGE_PRESET_DAYS)[number];

export type UsageRange =
  | { readonly kind: "preset"; readonly days: UsagePresetDays }
  | { readonly kind: "custom"; readonly sinceDay: string; readonly untilDay: string };

export type UsageRangeProblem = "invalid" | "future" | "reversed" | "tooLong";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayMs(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return ms;
}

/** Inclusive number of days between two `YYYY-MM-DD` bounds; null when either is not a day. */
export function rangeDayCount(sinceDay: string, untilDay: string): number | null {
  const since = dayMs(sinceDay);
  const until = dayMs(untilDay);
  if (since === null || until === null) return null;
  return Math.round((until - since) / DAY_MS) + 1;
}

/** Today's `YYYY-MM-DD` in `timeZone`, falling back to UTC for an unknown zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The first rule a custom range breaks, in the order the form shows them; null when it is valid. */
export function customRangeProblem(
  sinceDay: string,
  untilDay: string,
  today: string,
): UsageRangeProblem | null {
  const count = rangeDayCount(sinceDay, untilDay);
  if (count === null || dayMs(today) === null) return "invalid";
  if (untilDay > today) return "future";
  if (sinceDay > untilDay) return "reversed";
  if (count > USAGE_CUSTOM_RANGE_MAX_DAYS) return "tooLong";
  return null;
}

export const USAGE_RANGE_PROBLEM_TEXT: Record<UsageRangeProblem, string> = {
  invalid: "Enter both dates.",
  future: "Until cannot be after today.",
  reversed: "From cannot be after Until.",
  tooLong: `A range can span at most ${USAGE_CUSTOM_RANGE_MAX_DAYS} days.`,
};

/** The window a range requests, in the viewer's zone. A custom range keeps its own days. */
export function usageRangeWindow(
  range: UsageRange,
  now = new Date(),
  timeZone = viewerTimeZone(),
): UsageSummaryInput {
  if (range.kind === "preset") {
    return makeWindow(range.days, now, range.days === 1 ? "hour" : "day");
  }
  return {
    sinceDay: UsageDay.make(range.sinceDay),
    untilDay: UsageDay.make(range.untilDay),
    timeZone,
    resolution: "day",
  };
}

/** Whether the range ends before today, so "now" figures and the forecast do not apply. */
export function usageRangeIsPast(range: UsageRange, today: string): boolean {
  return range.kind === "custom" && range.untilDay < today;
}

/** `Nov 1 – Nov 15`, or `Nov 1, 2025 – Jan 2, 2026` when it leaves the current year. */
export function formatUsageRange(sinceDay: string, untilDay: string, today: string): string {
  const year = today.slice(0, 4);
  const label = (day: string) =>
    day.slice(0, 4) === year ? formatDayShort(day) : `${formatDayShort(day)}, ${day.slice(0, 4)}`;
  if (sinceDay === untilDay) return label(sinceDay);
  return `${label(sinceDay)} – ${label(untilDay)}`;
}

/** A saved range that still applies: a custom one must still pass every rule. */
export function restoreUsageRange(saved: UsageRange | undefined, today: string): UsageRange | null {
  if (saved === undefined) return null;
  if (saved.kind === "preset") return saved;
  return customRangeProblem(saved.sinceDay, saved.untilDay, today) === null ? saved : null;
}
