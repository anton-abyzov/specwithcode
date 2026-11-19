/**
 * Turns quota reads into closed periods: what a weekly or monthly window had
 * used when it reset, and so what went unused. The reset rule is the one the
 * run-out forecast uses (`resetBetween`), so the two never disagree on when a
 * window started over.
 *
 * A period is only as good as the last read before its reset. When no read
 * was taken for a whole window the spend is unknown and no period is closed:
 * an invented loss is worse than a gap.
 *
 * @module usageResetLedger
 */
import type { ServerProviderUsageWindow, UsageResetCause } from "@specweave-studio/contracts";

import { type LimitHistorySample, isFreshSample, resetBetween } from "./usageLimitForecast.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A reset this long before its announced time was not the scheduled one. */
const EARLY_RESET_MARGIN_MS = 10 * MINUTE;
/** Shorter windows turn over many times a day; what they leave unused is not a loss worth a ledger. */
const MIN_LEDGER_WINDOW_MINS = 24 * 60;

export interface ResetPeriod {
  readonly accountKey: string;
  readonly windowId: string;
  /** Null for the first period seen of a window: its start was never observed. */
  readonly startedAt: number | null;
  readonly endedAt: number;
  /** The last read before the reset; spend after it is unknown. */
  readonly lastReadAt: number;
  readonly usedPercentAtReset: number;
  readonly lostPercent: number;
  readonly cause: UsageResetCause;
}

/** Whether resets of this window belong in the ledger: weekly, monthly, or any window a day or longer. */
export function isLedgerWindow(
  kind: ServerProviderUsageWindow["kind"],
  windowDurationMins: number | undefined,
): boolean {
  if (kind === "weekly" || kind === "monthly") return true;
  if (kind === "session") return false;
  return windowDurationMins !== undefined && windowDurationMins >= MIN_LEDGER_WINDOW_MINS;
}

const DAY = 24 * HOUR;

/**
 * How long a ledger window runs, for telling a whole unread window from a
 * short gap. Providers that report a weekly or monthly window without its
 * length get the shortest such window, so a long silence never closes a period.
 */
export function ledgerWindowLengthMs(
  kind: ServerProviderUsageWindow["kind"],
  windowDurationMins: number | undefined,
): number | null {
  if (windowDurationMins !== undefined && windowDurationMins > 0) return windowDurationMins * MINUTE;
  if (kind === "weekly") return 7 * DAY;
  if (kind === "monthly") return 28 * DAY;
  return null;
}

export interface ClosedReset {
  readonly endedAt: number;
  readonly lastReadAt: number;
  readonly usedPercentAtReset: number;
  readonly lostPercent: number;
  readonly cause: UsageResetCause;
}

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

/**
 * The period that ended between two reads of one window, or null when the
 * window did not start over, either read is a restamped stale one, or a whole
 * window passed between them (what was spent in the gap is unknown).
 *
 * `redeemed` says a banked reset was spent between the reads; it only names
 * the cause of a reset that came before its announced time.
 */
export function closedReset(
  previous: LimitHistorySample,
  current: LimitHistorySample,
  lengthMs: number | null,
  redeemed = false,
): ClosedReset | null {
  if (current.at <= previous.at) return null;
  if (!isFreshSample(previous) || !isFreshSample(current)) return null;
  if (lengthMs !== null && current.at - previous.at >= lengthMs) return null;
  if (!resetBetween(previous, current, lengthMs)) return null;
  const early =
    previous.resetsAt !== null && current.at < previous.resetsAt - EARLY_RESET_MARGIN_MS;
  const endedAt =
    !early && previous.resetsAt !== null && previous.resetsAt <= current.at
      ? Math.max(previous.resetsAt, previous.at)
      : current.at;
  const used = roundPercent(previous.usedPercent);
  return {
    endedAt,
    lastReadAt: previous.at,
    usedPercentAtReset: used,
    lostPercent: roundPercent(100 - used),
    cause: early ? (redeemed ? "redeemed" : "early") : "scheduled",
  };
}

/**
 * Every period that closed inside one window's samples, oldest first. The
 * first has no start: the window was already running at the first read.
 */
export function resetPeriods(
  accountKey: string,
  windowId: string,
  samples: readonly LimitHistorySample[],
  lengthMs: number | null,
): ResetPeriod[] {
  const periods: ResetPeriod[] = [];
  const fresh = samples.filter(isFreshSample);
  let startedAt: number | null = null;
  for (let index = 1; index < fresh.length; index += 1) {
    const previous = fresh[index - 1]!;
    const current = fresh[index]!;
    const closed = closedReset(previous, current, lengthMs);
    if (closed) {
      periods.push({ accountKey, windowId, startedAt, ...closed });
      startedAt = closed.endedAt;
    } else if (resetBetween(previous, current, lengthMs)) {
      // A reset with an unknown spend: the next period's start is unknown too.
      startedAt = lengthMs !== null && current.at - previous.at >= lengthMs ? null : current.at;
    }
  }
  return periods;
}

/**
 * A read up to five minutes past the announced reset still counts as before
 * it, and closes its period at that read: a record whose last read is its end.
 * The same reset seen from a read before the announced time ends there
 * instead, so two such records of one window this close are one reset.
 */
export const SAME_RESET_MS = 15 * MINUTE;

/**
 * Whether two records of one window are the same reset: their spans from last
 * read to end overlap (both reads bracket it), or one was closed by a read just
 * past its announced time (its span is a single instant) and they end within
 * `SAME_RESET_MS`. Two early resets minutes apart each span a read gap and
 * stay apart.
 */
export function sameResetRecord(
  left: Pick<ResetPeriod, "lastReadAt" | "endedAt">,
  right: Pick<ResetPeriod, "lastReadAt" | "endedAt">,
): boolean {
  if (left.lastReadAt < right.endedAt && right.lastReadAt < left.endedAt) return true;
  const closedAtLateRead = left.lastReadAt === left.endedAt || right.lastReadAt === right.endedAt;
  return closedAtLateRead && Math.abs(left.endedAt - right.endedAt) <= SAME_RESET_MS;
}

/**
 * One list from the ledgers of several machines. Two machines signed in to
 * one account each record the same reset from their own reads; the one that
 * read last before the reset knows the spend best, so it is kept.
 *
 * Two records are one reset when `sameResetRecord` says so. Two resets one
 * machine saw in a row never overlap, so an early reset and a redeemed one
 * hours apart both stay.
 */
export function mergeResetPeriods<Period extends ResetPeriod>(
  ledgers: ReadonlyArray<ReadonlyArray<Period>>,
): Period[] {
  const sorted = ledgers
    .flat()
    .toSorted(
      (left, right) =>
        left.accountKey.localeCompare(right.accountKey) ||
        left.windowId.localeCompare(right.windowId) ||
        left.endedAt - right.endedAt,
    );
  const merged: Period[] = [];
  for (const period of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.accountKey === period.accountKey &&
      last.windowId === period.windowId &&
      sameResetRecord(last, period)
    ) {
      if (period.lastReadAt > last.lastReadAt) {
        merged[merged.length - 1] = {
          ...period,
          endedAt: Math.max(period.endedAt, last.endedAt),
          startedAt: period.startedAt ?? last.startedAt,
        };
      } else if (last.startedAt === null && period.startedAt !== null) {
        merged[merged.length - 1] = { ...last, startedAt: period.startedAt };
      }
      continue;
    }
    merged.push(period);
  }
  return merged.toSorted((left, right) => left.endedAt - right.endedAt);
}

/** The loss is exact only when the last read was close to the reset; past this it is an upper bound. */
export const EXACT_LOSS_READ_GAP_MS = 2 * HOUR;

export function lossIsUpperBound(period: Pick<ResetPeriod, "endedAt" | "lastReadAt">): boolean {
  return period.endedAt - period.lastReadAt > EXACT_LOSS_READ_GAP_MS;
}
