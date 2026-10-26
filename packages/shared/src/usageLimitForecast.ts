/**
 * Burn rate and run-out estimates for a pooled limit window, from the quota
 * history servers record (`usageLimits.history`) and the live reads the
 * pooled view already has.
 *
 * Units are percent of one account, so a pool of six accounts holds 600%.
 * The projection assumes the pool keeps spending at its current rate; an
 * account that runs dry hands its share to the accounts that still have
 * quota, as limit switching does, and each account refills at its reset and
 * every window length after.
 *
 * @module usageLimitForecast
 */
import type {
  ServerProviderUsageWindow,
  UsageLimitHistorySeries,
} from "@specweave-studio/contracts";

import {
  type LimitAccount,
  type LimitPoolMember,
  type LimitPoolWindow,
  limitAccountKey,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Burn is measured over this much recent history. */
const BURN_LOOKBACK_MS = 3 * HOUR;
/** Less than this between the first and last read is too little to call a rate. */
const MIN_BURN_SPAN_MS = 20 * MINUTE;
/** Providers round reset times differently between reads; closer than this is the same reset. */
const SAME_RESET_TOLERANCE_MS = 5 * MINUTE;
/**
 * Without reset times, a fall bigger than this many points is the only sign
 * of a reset. Smaller falls are rounding between feeds.
 */
const RESET_DROP_POINTS = 5;
/** History the forecast reads: the recorded line reaches back at most this far. */
export const LIMIT_HISTORY_LOOKBACK_HOURS = 72;
const PROJECTION_STEPS = 480;
const RECORDED_STEPS = 120;
const EMPTY_EPSILON = 1e-6;

export interface LimitHistorySample {
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/** Samples per account window, merged from every environment that recorded them. */
export type LimitHistoryIndex = ReadonlyMap<string, readonly LimitHistorySample[]>;

function limitHistoryKey(
  accountKey: string,
  kind: ServerProviderUsageWindow["kind"],
  windowId: string,
): string {
  return `${accountKey}|${kind}:${windowId}`;
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * One index from the histories of several environments. Two machines signed
 * in to one account record the same quota, so their samples interleave into
 * one series; equal times keep the first seen.
 */
export function indexLimitHistory(
  histories: ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>,
): LimitHistoryIndex {
  const merged = new Map<string, LimitHistorySample[]>();
  for (const history of histories) {
    for (const series of history) {
      const key = limitHistoryKey(series.accountKey, series.windowKind, series.windowId);
      const list = merged.get(key) ?? [];
      for (const sample of series.samples) {
        const at = parseTime(sample.at);
        if (at === null) continue;
        list.push({ at, usedPercent: sample.usedPercent, resetsAt: parseTime(sample.resetsAt) });
      }
      merged.set(key, list);
    }
  }
  for (const [key, list] of merged) {
    const sorted = list.sort((left, right) => left.at - right.at);
    merged.set(
      key,
      sorted.filter((sample, index) => index === 0 || sample.at !== sorted[index - 1]!.at),
    );
  }
  return merged;
}

/**
 * Recorded samples for a pool member, ending with its live read. A member
 * whose reset passed since its last read has no live read worth adding: the
 * spend since the reset is unknown.
 */
function memberSamples(
  member: LimitPoolMember,
  index: LimitHistoryIndex,
): readonly LimitHistorySample[] {
  const accountKey = limitAccountKey(
    member.account.driver,
    member.account.email,
    member.account.limits,
  );
  const recorded = accountKey
    ? (index.get(limitHistoryKey(accountKey, member.window.kind, member.window.id)) ?? [])
    : [];
  const checkedAt = parseTime(member.account.limits.checkedAt);
  if (member.resetSinceRead || checkedAt === null) return recorded;
  const last = recorded[recorded.length - 1];
  if (last && last.at >= checkedAt) return recorded;
  return [
    ...recorded,
    {
      at: checkedAt,
      usedPercent: member.window.usedPercent,
      resetsAt: parseTime(member.window.resetsAt),
    },
  ];
}

/**
 * Whether the window started a new period between two reads. A whole window
 * between them means it has turned over, whatever its kind. With reset times,
 * it restarted when its reset moved out by more than the time between the
 * reads (a rolling window's reset slides by about that much, and usage ageing
 * out of it is not a reset), and by a good part of a window or with a large
 * fall (an early reset). Without them, only a large fall counts, or any fall
 * once the old reset time has passed.
 */
function resetBetween(
  previous: LimitHistorySample,
  current: LimitHistorySample,
  lengthMs: number | null,
): boolean {
  const gap = current.at - previous.at;
  if (lengthMs !== null && gap >= lengthMs) return true;
  const fell = previous.usedPercent - current.usedPercent;
  if (previous.resetsAt !== null && current.resetsAt !== null) {
    const moved = current.resetsAt - previous.resetsAt;
    return (
      moved > gap + SAME_RESET_TOLERANCE_MS &&
      (lengthMs === null || moved >= lengthMs / 2 || fell > RESET_DROP_POINTS)
    );
  }
  return (
    fell > RESET_DROP_POINTS ||
    (fell > 0 && previous.resetsAt !== null && current.at >= previous.resetsAt)
  );
}

/**
 * A read taken after its own reset time is a kept read restamped by a later
 * update on another window, not news about this one.
 */
function isFresh(sample: LimitHistorySample): boolean {
  return sample.resetsAt === null || sample.at < sample.resetsAt + SAME_RESET_TOLERANCE_MS;
}

/**
 * Percent of the account spent per hour over the lookback, or null when the
 * reads span too little time to say. Spend is each rise past the highest read
 * so far, so two feeds that round differently do not count their gap again
 * and again; a large fall that is not a reset (usage ageing out of a rolling
 * window) lowers that mark. A new reset period starts from zero, so its first
 * read counts in full.
 */
export function burnPerHour(
  samples: readonly LimitHistorySample[],
  now: number,
  lookbackMs: number = BURN_LOOKBACK_MS,
  lengthMs: number | null = null,
): number | null {
  const start = now - lookbackMs;
  const fresh = samples.filter(isFresh);
  const inRange = fresh.filter((sample) => sample.at >= start && sample.at <= now);
  // A read just before the range anchors a quiet stretch that began earlier.
  const anchor = fresh.findLast((sample) => sample.at < start && sample.at >= start - lookbackMs);
  const points = anchor ? [anchor, ...inRange] : inRange;
  if (points.length < 2) return null;
  const span = points[points.length - 1]!.at - points[0]!.at;
  if (span < MIN_BURN_SPAN_MS) return null;
  let spent = 0;
  let peak = points[0]!.usedPercent;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (resetBetween(previous, current, lengthMs)) {
      spent += current.usedPercent;
      peak = current.usedPercent;
    } else if (current.usedPercent > peak) {
      spent += current.usedPercent - peak;
      peak = current.usedPercent;
    } else if (peak - current.usedPercent > RESET_DROP_POINTS) {
      peak = current.usedPercent;
    }
  }
  return spent / (span / HOUR);
}

export interface PoolForecastPoint {
  readonly at: number;
  /** Sum of what every account has left, in percent of one account. */
  readonly remaining: number;
}

export interface PoolForecast {
  /** 100 per account. */
  readonly capacity: number;
  readonly remaining: number;
  /** Percent of one account per hour, over the accounts with a measured rate; null when none has one. */
  readonly burnPerHour: number | null;
  readonly measuredAccounts: number;
  /** Accounts with nothing left right now. */
  readonly emptyNow: number;
  /**
   * The first account to run dry after now at the current rate, within the
   * horizon. An account dry now counts again once it refills and runs out.
   */
  readonly firstEmpty: { readonly account: LimitAccount; readonly at: number } | null;
  /** When every account is dry at once, within the horizon. */
  readonly poolEmptyAt: number | null;
  /** The soonest reset that hands quota back: every account resetting then, and how much they restore together. */
  readonly nextReset: {
    readonly accounts: readonly LimitAccount[];
    readonly at: number;
    readonly restores: number;
  } | null;
  readonly horizonEnd: number;
  readonly recorded: readonly PoolForecastPoint[];
  readonly projected: readonly PoolForecastPoint[];
}

function windowLengthMs(pool: LimitPoolWindow): number | null {
  const minutes = pool.members.find(
    (member) =>
      member.window.windowDurationMins !== undefined && member.window.windowDurationMins > 0,
  )?.window.windowDurationMins;
  return minutes === undefined ? null : minutes * MINUTE;
}

/** Twice the window ahead, between half a day and ten days; a week when the length is unknown. */
export function forecastHorizonMs(pool: LimitPoolWindow): number {
  const length = windowLengthMs(pool);
  return length === null ? 7 * DAY : Math.max(12 * HOUR, Math.min(10 * DAY, 2 * length));
}

/** How far back the recorded line reaches: a third of the horizon, between three hours and three days. */
function recordedLookbackMs(horizonMs: number): number {
  return Math.max(3 * HOUR, Math.min(3 * DAY, horizonMs * 0.3));
}

function remainingOf(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/** What the pool held at `at`, from recorded samples; null when an account has no read that early. */
function recordedRemainingAt(
  series: ReadonlyArray<readonly LimitHistorySample[]>,
  at: number,
): number | null {
  let total = 0;
  for (const samples of series) {
    const sample = samples.findLast((candidate) => candidate.at <= at);
    if (!sample) return null;
    total +=
      sample.resetsAt !== null && at >= sample.resetsAt ? 100 : remainingOf(sample.usedPercent);
  }
  return total;
}

interface SimulatedAccount {
  readonly member: LimitPoolMember;
  readonly weight: number;
  readonly lengthMs: number | null;
  /** No reset time and nothing used: the window opens on first use and resets a length later. */
  readonly opensOnUse: boolean;
  remaining: number;
  nextReset: number | null;
  ranDryAt: number | null;
}

/**
 * The account's next reset after now. A reset that passed since the read is
 * gone from the pooled window, but the account's own read keeps it, and the
 * window length carries it forward.
 */
function nextResetAfter(
  member: LimitPoolMember,
  lengthMs: number | null,
  now: number,
): number | null {
  const live = parseTime(member.window.resetsAt);
  if (live !== null && live > now) return live;
  if (!member.resetSinceRead || lengthMs === null) return null;
  const passed = parseTime(
    member.account.limits.windows.find(
      (window) => window.id === member.window.id && window.kind === member.window.kind,
    )?.resetsAt,
  );
  if (passed === null) return null;
  return passed + (Math.floor((now - passed) / lengthMs) + 1) * lengthMs;
}

export function forecastPool(
  pool: LimitPoolWindow,
  history: LimitHistoryIndex,
  now: number,
): PoolForecast {
  const horizonMs = forecastHorizonMs(pool);
  const horizonEnd = now + horizonMs;
  const samples = pool.members.map((member) => memberSamples(member, history));
  const lengths = pool.members.map((member) =>
    member.window.windowDurationMins !== undefined && member.window.windowDurationMins > 0
      ? member.window.windowDurationMins * MINUTE
      : null,
  );
  const burns = samples.map((series, index) =>
    burnPerHour(series, now, BURN_LOOKBACK_MS, lengths[index] ?? null),
  );
  const measured = burns.filter((burn): burn is number => burn !== null);
  const burn = measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null;
  const capacity = pool.members.length * 100;
  const remaining = pool.members.reduce(
    (sum, member) => sum + remainingOf(member.window.usedPercent),
    0,
  );

  const resets = pool.members
    .flatMap((member) => {
      const at = parseTime(member.window.resetsAt);
      return at !== null && at > now && member.window.usedPercent > 0 ? [{ member, at }] : [];
    })
    .sort((left, right) => left.at - right.at);
  // Accounts that reset together (same plan, same start) hand back their quota in one step.
  const soonest = resets[0];
  const resettingTogether = soonest
    ? resets.filter((reset) => reset.at - soonest.at <= SAME_RESET_TOLERANCE_MS)
    : [];

  // Recorded: what the pool held over the lookback, where every account has a read.
  const lookbackMs = recordedLookbackMs(horizonMs);
  const recorded: PoolForecastPoint[] = [];
  for (let step = 0; step < RECORDED_STEPS; step += 1) {
    const at = now - lookbackMs + (lookbackMs * step) / RECORDED_STEPS;
    const value = recordedRemainingAt(samples, at);
    if (value !== null) recorded.push({ at, remaining: value });
  }
  if (recorded.length > 0) recorded.push({ at: now, remaining });

  const accounts: SimulatedAccount[] = pool.members.map((member, index) => {
    const lengthMs = lengths[index] ?? null;
    const nextReset = nextResetAfter(member, lengthMs, now);
    return {
      member,
      weight: Math.max(0, burns[index] ?? 0),
      lengthMs,
      opensOnUse:
        nextReset === null && lengthMs !== null && member.window.usedPercent <= EMPTY_EPSILON,
      remaining: remainingOf(member.window.usedPercent),
      nextReset,
      ranDryAt: null,
    };
  });

  const projected: PoolForecastPoint[] = [];
  let poolEmptyAt: number | null = remaining <= EMPTY_EPSILON ? now : null;
  if (burn !== null) {
    const stepMs = horizonMs / PROJECTION_STEPS;
    projected.push({ at: now, remaining });
    // Spend lands on accounts with quota, each in proportion to its own rate;
    // what an empty account would have spent moves to the rest.
    const spend = (demand: number, from: number, to: number) => {
      for (let round = 0; round < accounts.length && demand > EMPTY_EPSILON; round += 1) {
        const open = accounts.filter((account) => account.remaining > EMPTY_EPSILON);
        if (open.length === 0) break;
        const weights = open.reduce((sum, account) => sum + account.weight, 0);
        let taken = 0;
        for (const account of open) {
          const share = weights > 0 ? (demand * account.weight) / weights : demand / open.length;
          const spent = Math.min(share, account.remaining);
          account.remaining -= spent;
          taken += spent;
          if (spent > 0 && account.opensOnUse && account.nextReset === null) {
            account.nextReset = from + account.lengthMs!;
          }
          if (account.remaining <= EMPTY_EPSILON) {
            account.remaining = 0;
            account.ranDryAt ??= to;
          }
        }
        // Left over when a share ran an account dry; the next round spreads it
        // over the accounts still open, evenly once none of them has a rate.
        demand -= taken;
      }
    };
    for (let step = 1; step <= PROJECTION_STEPS; step += 1) {
      const at = now + step * stepMs;
      // Split the step at every reset inside it, so a refill is never late,
      let cursor = at - stepMs;
      // and at every account running dry, so each recorded time is exact.
      for (let guard = 0; cursor < at && guard < 64 * (accounts.length + 1); guard += 1) {
        const open = accounts.filter((account) => account.remaining > EMPTY_EPSILON);
        const weights = open.reduce((sum, account) => sum + account.weight, 0);
        const dryAts = open.flatMap((account) => {
          const rate = weights > 0 ? (burn * account.weight) / weights : burn / open.length;
          return rate > 0 ? [cursor + (account.remaining / rate) * HOUR] : [];
        });
        const cut = Math.max(
          cursor + 1,
          Math.min(
            at,
            ...dryAts,
            ...accounts.flatMap((account) =>
              account.nextReset !== null && account.nextReset > cursor ? [account.nextReset] : [],
            ),
          ),
        );
        spend((burn * (cut - cursor)) / HOUR, cursor, cut);
        if (
          poolEmptyAt === null &&
          accounts.every((account) => account.remaining <= EMPTY_EPSILON)
        ) {
          poolEmptyAt = cut;
        }
        for (const account of accounts) {
          while (account.nextReset !== null && account.nextReset <= cut) {
            account.remaining = 100;
            account.nextReset =
              account.lengthMs === null ? null : account.nextReset + account.lengthMs;
          }
        }
        cursor = Math.min(cut, at);
      }
      projected.push({
        at,
        remaining: accounts.reduce((sum, account) => sum + account.remaining, 0),
      });
    }
  }

  // Accounts already dry are counted apart, so they do not hide the next one to go.
  const firstEmpty = accounts
    .filter((account) => account.ranDryAt !== null)
    .sort((left, right) => left.ranDryAt! - right.ranDryAt!)[0];

  return {
    capacity,
    remaining,
    burnPerHour: burn,
    measuredAccounts: measured.length,
    emptyNow: pool.members.filter(
      (member) => remainingOf(member.window.usedPercent) <= EMPTY_EPSILON,
    ).length,
    firstEmpty: firstEmpty
      ? { account: firstEmpty.member.account, at: firstEmpty.ranDryAt! }
      : null,
    poolEmptyAt,
    nextReset: soonest
      ? {
          accounts: resettingTogether.map((reset) => reset.member.account),
          at: soonest.at,
          restores: Math.round(
            resettingTogether.reduce((sum, reset) => sum + reset.member.window.usedPercent, 0),
          ),
        }
      : null,
    horizonEnd,
    recorded: recorded.length > 1 ? recorded : [],
    projected,
  };
}

/** `3.7%/h`, `0.4%/h`, `12%/h`. */
export function formatBurnPerHour(perHour: number): string {
  const rounded = perHour >= 10 ? Math.round(perHour) : Math.round(perHour * 10) / 10;
  return `${rounded}%/h`;
}
