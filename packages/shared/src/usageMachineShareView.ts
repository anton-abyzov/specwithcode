/**
 * What the Machines views draw, from the merged reports: one view per
 * subscription with its period, bar parts, daily trend and outside estimate.
 * Pure, so web, desktop, the phone app and the headless fixture share it.
 *
 * @module usageMachineShareView
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type UsageLimitHistorySeries,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { maskEmail } from "./maskEmail.ts";
import {
  type MachineShare,
  type ShareMachineInput,
  type ShareMeasure,
  type ShareSegment,
  type ShareTrendDay,
  type SubscriptionShare,
  measureOf,
  mergeMachineShare,
  recordedHours,
  shareSegments,
  shareTrend,
} from "./usageMachineShare.ts";
import {
  type OutsideResult,
  type OutsideWindow,
  currentWindowStart,
  estimateOutside,
  limitResets,
  pickOutsideWindow,
} from "./usageOutsideEstimate.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SharePeriod =
  | { readonly kind: "days"; readonly days: 7 | 14 | 30 }
  | { readonly kind: "reset" }
  | { readonly kind: "custom"; readonly sinceDay: string; readonly untilDay: string };

export const SHARE_PERIOD_OPTIONS = [
  { value: "7", label: "Last 7 days", period: { kind: "days", days: 7 } },
  { value: "reset", label: "Reset window", period: { kind: "reset" } },
  { value: "14", label: "14 days", period: { kind: "days", days: 14 } },
  { value: "30", label: "30 days", period: { kind: "days", days: 30 } },
] as const satisfies readonly { value: string; label: string; period: SharePeriod }[];

export const SHARE_MEASURE_OPTIONS = [
  { value: "cost", label: "Cost equivalent" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
] as const satisfies readonly { value: ShareMeasure; label: string }[];

/** Days every machine is asked for, whatever period shows, so switching needs no new read. */
export const REPORT_DAYS = 30;
/** As far back as a custom range may start. */
export const CUSTOM_RANGE_DAYS = 92;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    };
    try {
      formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
    } catch {
      // An unknown zone degrades to UTC rather than breaking the view.
      formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zoneParts(atMs: number, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(atMs)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** The calendar day an instant falls on in `timeZone`, `YYYY-MM-DD`. */
export function zonedDay(atMs: number, timeZone: string): string {
  const parts = zoneParts(atMs, timeZone);
  const pad = (value: number | undefined) => String(value ?? 1).padStart(2, "0");
  return `${String(parts.year ?? 1970).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function zoneOffset(atMs: number, timeZone: string): number {
  const parts = zoneParts(atMs, timeZone);
  const wall = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wall - Math.floor(atMs / 1000) * 1000;
}

/** The instant a calendar day starts in `timeZone`. */
export function zonedDayStart(day: string, timeZone: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(utc)) return 0;
  // Twice, so a day that starts on the far side of a clock change lands right.
  const guess = utc - zoneOffset(utc, timeZone);
  return utc - zoneOffset(guess, timeZone);
}

/** The day `days` before `day`. */
export function dayBefore(day: string, days: number): string {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(utc)) return day;
  return DateTime.formatIso(DateTime.makeUnsafe(utc - days * DAY_MS)).slice(0, 10);
}

/**
 * The range every machine is asked for: the usual days, further back for a
 * custom range, or the custom range itself when it began too long ago to read
 * through today (1456). A request never spans more than {@link CUSTOM_RANGE_DAYS}.
 */
export function reportRange(
  period: SharePeriod,
  now: number,
  timeZone: string,
): { readonly sinceDay: string; readonly untilDay: string } {
  const untilDay = zonedDay(now, timeZone);
  const usual = dayBefore(untilDay, REPORT_DAYS - 1);
  const earliest = dayBefore(untilDay, CUSTOM_RANGE_DAYS - 1);
  if (period.kind !== "custom" || period.sinceDay >= usual) return { sinceDay: usual, untilDay };
  if (period.sinceDay >= earliest) return { sinceDay: period.sinceDay, untilDay };
  const end = period.untilDay > untilDay ? untilDay : period.untilDay;
  const first = dayBefore(end, CUSTOM_RANGE_DAYS - 1);
  return { sinceDay: period.sinceDay < first ? first : period.sinceDay, untilDay: end };
}

export interface ViewPeriod {
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly startMs: number;
  readonly endMs: number;
}

function periodOf(
  period: SharePeriod,
  window: OutsideWindow | null,
  now: number,
  timeZone: string,
): ViewPeriod {
  const localDay = (atMs: number) => zonedDay(atMs, timeZone);
  const localDayStart = (day: string) => zonedDayStart(day, timeZone);
  const today = localDay(now);
  if (period.kind === "custom") {
    const untilDay = period.untilDay > today ? today : period.untilDay;
    const sinceDay = period.sinceDay > untilDay ? untilDay : period.sinceDay;
    return {
      sinceDay,
      untilDay,
      startMs: localDayStart(sinceDay),
      // The next local midnight, so a 23- or 25-hour day keeps every hour.
      endMs: Math.min(now, localDayStart(dayBefore(untilDay, -1))),
    };
  }
  if (period.kind === "reset") {
    const start = window === null ? null : currentWindowStart(window, now);
    // Without a known reset, the last week stands in.
    if (start !== null && start < now && now - start <= 35 * DAY_MS) {
      return { sinceDay: localDay(start), untilDay: today, startMs: start, endMs: now };
    }
  }
  const days = period.kind === "days" ? period.days : 7;
  const sinceDay = dayBefore(today, days - 1);
  return { sinceDay, untilDay: today, startMs: localDayStart(sinceDay), endMs: now };
}

export interface SubscriptionView {
  readonly accountKey: string;
  /** The provider's name, or the instance's when the provider has none. */
  readonly provider: string;
  /** The account as shown: a masked email, a login, or null when nothing names it. */
  readonly account: string | null;
  readonly share: MachineShare;
  readonly subscription: SubscriptionShare;
  readonly period: ViewPeriod;
  /** True when the period is this account's own reset window. */
  readonly sinceReset: boolean;
  /** The reset day is counted whole for some machine: its use before the reset is in the totals. */
  readonly resetDayWhole: boolean;
  readonly window: OutsideWindow | null;
  /** The limit's last reading, when it has one. */
  readonly reading: { readonly usedPercent: number; readonly resetsAt: number | null } | null;
  readonly estimate: OutsideResult;
  readonly segments: readonly ShareSegment[];
  readonly trend: readonly ShareTrendDay[];
  /** Limit resets inside the period, as instants. */
  readonly resets: readonly number[];
  /**
   * The measure this subscription is shown in: the one asked for, or tokens
   * when cost was asked for and none of its use has a price.
   */
  readonly measure: ShareMeasure;
  /** What the bar adds up to in that measure, the estimate included. */
  readonly total: number;
}

/** A driver that hosts many agents is named by the instance, which says which agent it is. */
const HOST_DRIVERS = new Set(["acpRegistry"]);

function providerName(subscription: SubscriptionShare): string {
  const known = PROVIDER_DISPLAY_NAMES[subscription.driver as ProviderDriverKind];
  if (
    subscription.label !== null &&
    (known === undefined || HOST_DRIVERS.has(subscription.driver))
  ) {
    return subscription.label;
  }
  return known ?? subscription.driver;
}

export interface MachineShareViewInput {
  readonly inputs: readonly ShareMachineInput[];
  readonly histories: ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>;
  /** Window ids that limit one model family only, which the estimate never reads. */
  readonly scopedWindowIds: ReadonlySet<string>;
  readonly period: SharePeriod;
  readonly measure: ShareMeasure;
  readonly now: number;
  /** The viewer's IANA zone: days are theirs, as in the reports asked for. */
  readonly timeZone: string;
}

export function buildSubscriptionViews(input: MachineShareViewInput): readonly SubscriptionView[] {
  const { inputs, now, timeZone } = input;
  // The widest look names every subscription; each then gets its own period.
  const range = reportRange(input.period, now, timeZone);
  const everything = mergeMachineShare(inputs, { ...range, periodEndMs: now });
  const shared = new Map<string, MachineShare>();
  const views: SubscriptionView[] = [];
  for (const listed of everything.subscriptions) {
    const window = pickOutsideWindow(input.histories, listed.accountKey, input.scopedWindowIds);
    const period = periodOf(input.period, window, now, timeZone);
    const shareKey = `${period.sinceDay}\u0000${period.untilDay}\u0000${period.startMs}\u0000${period.endMs}`;
    let share = shared.get(shareKey);
    if (share === undefined) {
      const dayStartMs = zonedDayStart(period.sinceDay, timeZone);
      share = mergeMachineShare(inputs, {
        sinceDay: period.sinceDay,
        untilDay: period.untilDay,
        periodEndMs: period.endMs,
        // A reset window starts inside its first day: count that day from the reset on.
        ...(period.startMs > dayStartMs
          ? {
              firstDay: {
                startMs: dayStartMs,
                endMs: zonedDayStart(dayBefore(period.sinceDay, -1), timeZone),
                fromMs: period.startMs,
              },
            }
          : {}),
      });
      shared.set(shareKey, share);
    }
    const subscription =
      share.subscriptions.find((entry) => entry.accountKey === listed.accountKey) ?? null;
    if (subscription === null) continue;
    const estimate = estimateOutside({
      window,
      recorded: recordedHours(subscription),
      recordedSinceMs: subscription.hoursSinceMs,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      silentHolders: subscription.silentHolders,
      dayOf: (atMs) => zonedDay(atMs, timeZone),
    });
    const measure: ShareMeasure =
      input.measure === "cost" && subscription.total.costUsd <= 0 && subscription.total.tokens > 0
        ? "tokens"
        : input.measure;
    const segments = shareSegments(subscription, measure, estimate);
    const last = window?.samples[window.samples.length - 1];
    views.push({
      accountKey: listed.accountKey,
      provider: providerName(subscription),
      account: subscription.unknown
        ? null
        : subscription.name === null
          ? subscription.label === providerName(subscription)
            ? null
            : subscription.label
          : (maskEmail(subscription.name) ?? subscription.name),
      share,
      subscription,
      period,
      sinceReset:
        input.period.kind === "reset" &&
        period.startMs !== zonedDayStart(period.sinceDay, timeZone),
      resetDayWhole: subscription.firstDayWhole,
      window,
      reading:
        last === undefined ? null : { usedPercent: last.usedPercent, resetsAt: last.resetsAt },
      estimate,
      segments,
      trend: shareTrend(share, subscription, measure, estimate),
      resets:
        window === null
          ? []
          : limitResets(window)
              .filter((at) => at > period.startMs && at < period.endMs)
              // Two marks a few hours apart would print over each other.
              .filter((at, index, all) => index === 0 || at - all[index - 1]! >= DAY_MS / 4),
      measure,
      total:
        segments.reduce((sum, segment) => sum + (segment.value ?? 0), 0) ||
        measureOf(subscription.total, measure),
    });
  }
  // A subscription only an estimate fills still belongs above the empty ones.
  const weight = (view: SubscriptionView) =>
    view.total > 0 ? view.total : view.segments.length > 0 ? Number.MIN_VALUE : 0;
  // Those shown in the measure asked for come first; totals in another measure do not compare.
  const asked = (view: SubscriptionView) => (view.measure === input.measure ? 0 : 1);
  return views.sort(
    (a, b) =>
      asked(a) - asked(b) || weight(b) - weight(a) || a.accountKey.localeCompare(b.accountKey),
  );
}

/** A round top for the trend's axis, at or above `value`. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}
