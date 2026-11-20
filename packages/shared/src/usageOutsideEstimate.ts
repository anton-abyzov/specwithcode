/**
 * How much of a subscription was used on no machine that reports to this app.
 *
 * The provider says how far the account's weekly (else monthly) limit moved;
 * the machines say what they recorded. Neither is in the other's unit, so the
 * account's own history sets the rate: stretches where the limit moved a few
 * points give "recorded cost per point", and stretches where only the machines
 * used the account sit at the top of those ratios, since use elsewhere moves
 * the limit without adding recorded cost. What the machines recorded, divided
 * by the rate, is the part of the limit they explain; the rest is outside.
 *
 * It is an estimate and says so: a limit is not exactly proportional to
 * API-equivalent cost, percent reads are whole numbers, and steady outside use
 * hides inside the rate, so the figure is closer to a floor than a ceiling.
 *
 * @module usageOutsideEstimate
 */
import type { UsageLimitHistorySeries } from "@specweave-studio/contracts";

import {
  type LimitHistorySample,
  indexLimitHistory,
  isFreshSample,
  resetBetween,
} from "./usageLimitForecast.ts";

const HOUR_MS = 60 * 60 * 1000;

/** A calibration stretch closes once the limit moved this many points. */
export const CALIBRATION_CHUNK_POINTS = 4;
/** Fewer stretches with recorded use than this cannot set a rate. */
export const MIN_CALIBRATION_CHUNKS = 3;
/** Two reads further apart than this leave the time between them unobserved. */
const MAX_OBSERVED_GAP_MS = 6 * HOUR_MS;
/** Below both of these the figure is rounding: whole-number reads, uneven prices. */
const MARGIN_POINTS = 2;
const MARGIN_SHARE = 0.05;

export type OutsideConfidence = "high" | "medium" | "low";

export type OutsideUnavailableReason =
  /** The provider reports no weekly or monthly percent for the account. */
  | "noReading"
  /** The limit did not move in the period, so there is nothing to split. */
  | "noUse"
  /** Too little recorded history to set a rate. */
  | "shortHistory"
  /** A machine that holds the account did not report, so its use would read as outside. */
  | "holderSilent";

export interface OutsideWindow {
  readonly windowId: string;
  readonly windowKind: UsageLimitHistorySeries["windowKind"];
  readonly lengthMs: number | null;
  readonly samples: readonly LimitHistorySample[];
}

/**
 * The account-wide window the estimate reads: weekly when there is one, else
 * monthly. Model-scoped windows count only part of the use, and a session
 * window empties too often to calibrate against.
 */
export function pickOutsideWindow(
  histories: ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>,
  accountKey: string,
  scopedWindowIds: ReadonlySet<string> = new Set(),
): OutsideWindow | null {
  const index = indexLimitHistory(
    histories.map((history) => history.filter((series) => series.accountKey === accountKey)),
  );
  let best: OutsideWindow | null = null;
  const seen = new Set<string>();
  for (const history of histories) {
    for (const series of history) {
      if (series.accountKey !== accountKey) continue;
      if (series.windowKind !== "weekly" && series.windowKind !== "monthly") continue;
      if (scopedWindowIds.has(series.windowId)) continue;
      const key = `${series.accountKey}|${series.windowKind}:${series.windowId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const samples = (index.get(key) ?? []).filter(isFreshSample);
      if (samples.length === 0) continue;
      const candidate: OutsideWindow = {
        windowId: series.windowId,
        windowKind: series.windowKind,
        lengthMs:
          series.windowDurationMins === undefined ? null : series.windowDurationMins * 60_000,
        samples,
      };
      if (
        best === null ||
        (candidate.windowKind === "weekly" && best.windowKind !== "weekly") ||
        (candidate.windowKind === best.windowKind && samples.length > best.samples.length)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** One stretch between two reads, with the points the limit gained in it. */
interface Stretch {
  readonly from: number;
  readonly to: number;
  readonly points: number;
  /** The window restarted in it, at this time. */
  readonly resetAt: number | null;
}

/** A fall of more than this is not two feeds rounding differently. */
const NOISE_FALL_POINTS = 5;

/** A fall the next reads undo within this long was a stale read, not a fall. */
const STALE_READ_MS = 30 * 60 * 1000;

/** Said when a read that could have been a restart was taken as a misread. */
const DOUBT_REASON =
  "A limit reading dropped and was back within 30 minutes; it was taken as a misread, not a reset.";

/** How long a window of each kind lasts when the provider does not say. */
const NOMINAL_WINDOW_MS = { weekly: 7 * 24 * HOUR_MS, monthly: 31 * 24 * HOUR_MS };

type Read = OutsideWindow["samples"][number];

/** What is known of the window the last counted restart opened. */
interface OpenedWindow {
  /** When it began, when a reset time said so exactly. */
  readonly start: number | null;
  /** When it ends, when the first read in it said so. */
  readonly deadline: number | null;
  /** The first read counted in it. */
  readonly readAt: number;
}

/**
 * True when `read` is still in the window a counted restart opened: no reset
 * can lie between them then, whatever the reset times of the reads between
 * say. The read's own reset time decides. One still ahead is the end of its
 * window: the same end, one length after the start, or within a length of the
 * first read. One that has passed is a reset that happened by then, so it must
 * not be later than that first read. Without a reset time, only an exactly
 * known start can tell.
 */
function stillIn(opened: OpenedWindow, read: Read, window: OutsideWindow): boolean {
  const lengthMs =
    window.lengthMs ?? NOMINAL_WINDOW_MS[window.windowKind === "monthly" ? "monthly" : "weekly"];
  if (read.resetsAt === null) return opened.start !== null && read.at < opened.start + lengthMs;
  if (read.at >= read.resetsAt) return read.resetsAt <= opened.readAt;
  if (opened.deadline !== null) return read.resetsAt - opened.deadline < lengthMs / 2;
  if (opened.start !== null) return read.resetsAt - opened.start < 1.5 * lengthMs;
  return window.lengthMs !== null && opened.readAt >= read.resetsAt - window.lengthMs;
}

/** True when a read soon after `index` is back within the noise of `peak`. */
function recovers(samples: OutsideWindow["samples"], index: number, peak: number): boolean {
  const until = samples[index]!.at + STALE_READ_MS;
  for (let next = index + 1; next < samples.length && samples[next]!.at <= until; next += 1) {
    if (samples[next]!.usedPercent >= peak - NOISE_FALL_POINTS) return true;
  }
  return false;
}

/**
 * Gains count against the highest read of the period so far, so two feeds
 * that round differently (50, 49, 51) add one point, not two. A read far
 * below that mark which the next reads undo (24, 5, 24 within a minute) is a
 * stale read and is left out, unless the reset time says the window did turn
 * over. One that fell to under half could also be a restart followed by very
 * heavy use: it is still left out, and listed in `doubts` so the estimate can
 * say so. A fall that stays, by more than the noise to under half, is a
 * restart the provider did not announce by moving the reset time; a smaller
 * large fall only lowers the mark.
 */
function scanWindow(window: OutsideWindow): {
  readonly stretches: readonly Stretch[];
  readonly doubts: readonly number[];
} {
  const samples = window.samples;
  const stretches: Stretch[] = [];
  const doubts: number[] = [];
  let previous = samples[0];
  if (previous === undefined) return { stretches, doubts };
  let peak = previous.usedPercent;
  // The window the last counted restart opened.
  let opened: OpenedWindow | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]!;
    if (current.at <= previous.at) continue;
    const fell = peak - current.usedPercent;
    // A reset time that moves on while the read is still in a window already
    // counted is that same restart told late, not a second one.
    const told = opened !== null && stillIn(opened, current, window);
    const announced = !told && resetBetween(previous, current, window.lengthMs);
    // The provider's word that the window turned over: its reset time moved
    // on, or the one it gave has passed. A fall alone is not.
    const moved = announced && previous.resetsAt !== null && current.resetsAt !== null;
    const due =
      previous.resetsAt !== null &&
      previous.resetsAt > previous.at &&
      previous.resetsAt <= current.at;
    const turned = due && fell > NOISE_FALL_POINTS;
    if (fell > NOISE_FALL_POINTS && !moved && !due && recovers(samples, index, peak)) {
      if (current.usedPercent < peak / 2) doubts.push(current.at);
      continue;
    }
    if (announced || turned || (fell > NOISE_FALL_POINTS && current.usedPercent < peak / 2)) {
      // A reset time the read itself carries and that has passed is the
      // latest restart before it; else the one the read before was due.
      const passed =
        current.resetsAt !== null &&
        current.resetsAt <= current.at &&
        current.resetsAt > previous.at
          ? current.resetsAt
          : null;
      const resetAt = passed ?? (due ? previous.resetsAt! : current.at);
      const lengthMs = window.lengthMs ?? NOMINAL_WINDOW_MS.weekly;
      opened = {
        start: passed ?? (due && current.at < previous.resetsAt! + lengthMs ? resetAt : null),
        deadline:
          current.resetsAt !== null && current.resetsAt > current.at ? current.resetsAt : null,
        readAt: current.at,
      };
      // What was gained before the reset is not known; what shows after it is.
      stretches.push({
        from: Math.min(resetAt, current.at - 1),
        to: current.at,
        points: current.usedPercent,
        resetAt,
      });
      peak = current.usedPercent;
    } else {
      stretches.push({
        from: previous.at,
        to: current.at,
        points: Math.max(0, current.usedPercent - peak),
        resetAt: null,
      });
      if (current.usedPercent > peak || fell > NOISE_FALL_POINTS) peak = current.usedPercent;
    }
    previous = current;
  }
  return { stretches, doubts };
}

function stretchesOf(window: OutsideWindow): readonly Stretch[] {
  return scanWindow(window).stretches;
}

/** When the window restarted, oldest first: where the trend draws its reset markers. */
export function limitResets(window: OutsideWindow): readonly number[] {
  return stretchesOf(window).flatMap((stretch) =>
    stretch.resetAt === null ? [] : [stretch.resetAt],
  );
}

/**
 * When the window's current period began: its last recorded reset, else its
 * reset time minus its length. Null when neither is known.
 */
export function currentWindowStart(window: OutsideWindow, now: number): number | null {
  const resets = limitResets(window);
  const last = window.samples[window.samples.length - 1];
  const fromLength =
    last !== undefined && last.resetsAt !== null && window.lengthMs !== null
      ? last.resetsAt - window.lengthMs
      : null;
  // A reset time that already passed means the window has turned over since the last read.
  if (last !== undefined && last.resetsAt !== null && last.resetsAt <= now) return last.resetsAt;
  const recorded = resets.length > 0 ? resets[resets.length - 1]! : null;
  if (recorded !== null && fromLength !== null) return Math.max(recorded, fromLength);
  return recorded ?? fromLength;
}

/** Adds `points` to the hours `[from, to)` covers, in proportion to the overlap. */
function spread(target: Map<number, number>, from: number, to: number, points: number): void {
  if (points <= 0) return;
  const length = to - from;
  if (length <= 0) {
    const hour = Math.floor(to / HOUR_MS) * HOUR_MS;
    target.set(hour, (target.get(hour) ?? 0) + points);
    return;
  }
  for (let hour = Math.floor(from / HOUR_MS) * HOUR_MS; hour < to; hour += HOUR_MS) {
    const overlap = Math.min(to, hour + HOUR_MS) - Math.max(from, hour);
    if (overlap > 0) target.set(hour, (target.get(hour) ?? 0) + (points * overlap) / length);
  }
}

/** The value below which `share` of the weight lies. `entries` need not be sorted. */
function weightedQuantile(
  entries: ReadonlyArray<{ readonly value: number; readonly weight: number }>,
  share: number,
): number {
  const sorted = [...entries].sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let seen = 0;
  for (const entry of sorted) {
    seen += entry.weight;
    if (seen >= total * share) return entry.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

export interface RecordedHour {
  /** UTC start of the hour, epoch milliseconds. */
  readonly hourStartMs: number;
  /** What every reporting machine recorded for the account in the hour. */
  readonly weight: number;
}

export interface OutsideEstimateInput {
  readonly window: OutsideWindow | null;
  /** Recorded use per hour, every reporting machine added up. */
  readonly recorded: readonly RecordedHour[];
  /** First instant `recorded` covers; null when no machine reported hours. */
  readonly recordedSinceMs: number | null;
  /** The period asked about, `[periodStartMs, periodEndMs)`. */
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  /** Names of machines that hold the account and did not report for the whole period. */
  readonly silentHolders: readonly string[];
  /** The local day an instant falls on, for the per-day series. */
  readonly dayOf: (atMs: number) => string;
}

export interface OutsideDay {
  readonly day: string;
  /** Points of the limit used outside on the day. */
  readonly points: number;
  /** The same in the unit of `recorded`; null when no rate could be set. */
  readonly weight: number | null;
}

export interface OutsideEstimate {
  readonly kind: "estimate";
  readonly windowId: string;
  readonly windowKind: UsageLimitHistorySeries["windowKind"];
  /** The provider's last read the estimate rests on. */
  readonly lastCheckedAt: number;
  /** The estimate covers `[coveredFromMs, coveredToMs)`, which may start after the period does. */
  readonly coveredFromMs: number;
  readonly coveredToMs: number;
  /** Points the limit gained in the covered time, across resets. */
  readonly consumedPoints: number;
  /** Points the machines' recorded use accounts for. */
  readonly explainedPoints: number;
  /** The estimate, and the range the two rates give. */
  readonly outsidePoints: number;
  readonly lowPoints: number;
  readonly highPoints: number;
  /** Outside use in the unit of `recorded`; null when no rate could be set. */
  readonly outsideWeight: number | null;
  /** Recorded use per point of the limit; null when no machine recorded any. */
  readonly weightPerPoint: number | null;
  /** False when the figure is within rounding: read it as "none detected". */
  readonly detected: boolean;
  readonly confidence: OutsideConfidence;
  /** Plain sentences that say what lowers the confidence. */
  readonly reasons: readonly string[];
  readonly days: readonly OutsideDay[];
  /** Resets inside the covered time. */
  readonly resets: readonly number[];
}

export interface OutsideUnavailable {
  readonly kind: "unavailable";
  readonly reason: OutsideUnavailableReason;
  readonly detail: string;
  readonly lastCheckedAt: number | null;
}

export type OutsideResult = OutsideEstimate | OutsideUnavailable;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function estimateOutside(input: OutsideEstimateInput): OutsideResult {
  const { window } = input;
  if (window === null || window.samples.length === 0) {
    return {
      kind: "unavailable",
      reason: "noReading",
      detail: "The provider reports no weekly or monthly limit for this account.",
      lastCheckedAt: null,
    };
  }
  const lastCheckedAt = window.samples[window.samples.length - 1]!.at;
  if (input.silentHolders.length > 0) {
    const names = input.silentHolders.join(", ");
    return {
      kind: "unavailable",
      reason: "holderSilent",
      detail: `${names} ${input.silentHolders.length === 1 ? "is" : "are"} signed in to this account and did not report, so use there cannot be told from use elsewhere.`,
      lastCheckedAt,
    };
  }

  const { stretches, doubts } = scanWindow(window);
  const firstSampleAt = window.samples[0]!.at;
  const historyFrom = Math.max(firstSampleAt, input.recordedSinceMs ?? firstSampleAt);
  const coveredFromMs = Math.max(input.periodStartMs, historyFrom);
  const coveredToMs = Math.min(input.periodEndMs, lastCheckedAt);
  if (stretches.length === 0 || coveredToMs <= coveredFromMs) {
    return {
      kind: "unavailable",
      reason: "shortHistory",
      detail: "The limit has not been read often enough in this period yet.",
      lastCheckedAt,
    };
  }

  const consumedByHour = new Map<number, number>();
  let observedMs = 0;
  for (const stretch of stretches) {
    spread(consumedByHour, stretch.from, stretch.to, stretch.points);
    if (stretch.to - stretch.from <= MAX_OBSERVED_GAP_MS) {
      observedMs += Math.max(
        0,
        Math.min(stretch.to, coveredToMs) - Math.max(stretch.from, coveredFromMs),
      );
    }
  }
  const recordedByHour = new Map<number, number>();
  for (const hour of input.recorded) {
    recordedByHour.set(hour.hourStartMs, (recordedByHour.get(hour.hourStartMs) ?? 0) + hour.weight);
  }

  // Calibrate on everything both sides cover, not only the period asked about.
  const chunks: Array<{ value: number; weight: number }> = [];
  let chunkPoints = 0;
  let chunkWeight = 0;
  const lastHour = Math.floor(lastCheckedAt / HOUR_MS) * HOUR_MS;
  for (let hour = Math.ceil(historyFrom / HOUR_MS) * HOUR_MS; hour < lastHour; hour += HOUR_MS) {
    chunkPoints += consumedByHour.get(hour) ?? 0;
    chunkWeight += recordedByHour.get(hour) ?? 0;
    if (chunkPoints >= CALIBRATION_CHUNK_POINTS) {
      chunks.push({ value: chunkWeight / chunkPoints, weight: chunkPoints });
      chunkPoints = 0;
      chunkWeight = 0;
    }
  }
  const usedChunks = chunks.filter((chunk) => chunk.value > 0);

  // The period's own points come from the stretches cut to it, so a gain just
  // before it starts, in the same hour, is not counted as the period's.
  const periodByHour = new Map<number, number>();
  for (const stretch of stretches) {
    const from = Math.max(stretch.from, coveredFromMs);
    const to = Math.min(stretch.to, coveredToMs);
    if (to <= from) continue;
    spread(periodByHour, from, to, (stretch.points * (to - from)) / (stretch.to - stretch.from));
  }
  let consumedPoints = 0;
  let recordedWeight = 0;
  const firstHour = Math.floor(coveredFromMs / HOUR_MS) * HOUR_MS;
  const pointsByDay = new Map<string, number>();
  const weightByDay = new Map<string, number>();
  for (let hour = firstHour; hour < coveredToMs; hour += HOUR_MS) {
    const points = periodByHour.get(hour) ?? 0;
    // Recorded use is known per hour only: an hour the period cuts counts in proportion.
    const inside =
      (Math.min(hour + HOUR_MS, coveredToMs) - Math.max(hour, coveredFromMs)) / HOUR_MS;
    const weight = (recordedByHour.get(hour) ?? 0) * inside;
    consumedPoints += points;
    recordedWeight += weight;
    const day = input.dayOf(Math.max(hour, coveredFromMs));
    pointsByDay.set(day, (pointsByDay.get(day) ?? 0) + points);
    weightByDay.set(day, (weightByDay.get(day) ?? 0) + weight);
  }
  const resets = limitResets(window).filter((at) => at >= coveredFromMs && at < coveredToMs);

  // A read that fell to under half and came straight back: taken as a misread.
  const doubted = doubts.some((at) => at >= coveredFromMs && at < coveredToMs);

  if (consumedPoints < 1) {
    return {
      kind: "unavailable",
      reason: "noUse",
      detail: doubted
        ? `The limit did not move in this period. ${DOUBT_REASON}`
        : "The limit did not move in this period.",
      lastCheckedAt,
    };
  }

  const margin = Math.max(MARGIN_POINTS, consumedPoints * MARGIN_SHARE);
  const reasons: string[] = [];
  const coverage = observedMs / (coveredToMs - coveredFromMs);
  const partial = coveredFromMs > input.periodStartMs + 12 * HOUR_MS;
  if (partial) reasons.push("History starts after the period does, so only part of it is covered.");
  if (coverage < 0.8) reasons.push("The limit was read rarely for part of the period.");
  if (doubted) reasons.push(DOUBT_REASON);

  // No machine recorded anything, yet the limit moved: all of it was elsewhere.
  if (recordedWeight <= 0) {
    const days = [...pointsByDay].map(([day, points]) => ({
      day,
      points: round1(points),
      weight: null,
    }));
    return {
      kind: "estimate",
      windowId: window.windowId,
      windowKind: window.windowKind,
      lastCheckedAt,
      coveredFromMs,
      coveredToMs,
      consumedPoints: round1(consumedPoints),
      explainedPoints: 0,
      outsidePoints: round1(consumedPoints),
      lowPoints: round1(consumedPoints),
      highPoints: round1(consumedPoints),
      outsideWeight: null,
      weightPerPoint: null,
      detected: consumedPoints >= margin,
      confidence: coverage >= 0.8 && !partial && !doubted ? "high" : "medium",
      reasons: ["No reporting machine recorded any use of this account in the period.", ...reasons],
      days,
      resets,
    };
  }

  if (usedChunks.length < MIN_CALIBRATION_CHUNKS) {
    return {
      kind: "unavailable",
      reason: "shortHistory",
      detail:
        "Too little history to tell: the estimate needs the limit to have moved about 12 points while the machines were reporting.",
      lastCheckedAt,
    };
  }

  // Stretches with no outside use sit at the top of the ratios; the middle is
  // what a noisy but honest history would give. The truth is between them.
  // Stretches without any recorded use were all outside and say nothing of the rate.
  const rateHigh = weightedQuantile(usedChunks, 0.8);
  const rateMiddle = weightedQuantile(usedChunks, 0.5);
  const highPoints = Math.max(0, consumedPoints - recordedWeight / rateHigh);
  const lowPoints = Math.max(0, consumedPoints - recordedWeight / rateMiddle);
  const outsidePoints = (highPoints + lowPoints) / 2;
  const explainedPoints = consumedPoints - outsidePoints;
  const rate = explainedPoints > 0 ? recordedWeight / explainedPoints : rateHigh;

  const spreadShare = (highPoints - lowPoints) / consumedPoints;
  if (spreadShare > 0.15) {
    reasons.push("The cost per limit point varies a lot in this account's history.");
  }
  if (usedChunks.length < 8) reasons.push("The rate rests on little history.");
  let confidence: OutsideConfidence = "high";
  if (spreadShare > 0.15 || usedChunks.length < 8 || coverage < 0.8 || partial || doubted) {
    confidence = "medium";
  }
  if (spreadShare > 0.35 || usedChunks.length < 5 || coverage < 0.5) confidence = "low";

  // Per day, then scaled so the days add up to the period's figure.
  const rawDays = [...pointsByDay].map(([day, points]) => ({
    day,
    points: Math.max(0, points - (weightByDay.get(day) ?? 0) / rate),
  }));
  const rawTotal = rawDays.reduce((sum, day) => sum + day.points, 0);
  const scale = rawTotal > 0 ? outsidePoints / rawTotal : 0;
  const days = rawDays.map((day) => ({
    day: day.day,
    points: round1(day.points * scale),
    weight: day.points * scale * rate,
  }));

  return {
    kind: "estimate",
    windowId: window.windowId,
    windowKind: window.windowKind,
    lastCheckedAt,
    coveredFromMs,
    coveredToMs,
    consumedPoints: round1(consumedPoints),
    explainedPoints: round1(explainedPoints),
    outsidePoints: round1(outsidePoints),
    lowPoints: round1(lowPoints),
    highPoints: round1(highPoints),
    outsideWeight: outsidePoints * rate,
    weightPerPoint: rate,
    detected: outsidePoints >= margin,
    confidence,
    reasons,
    days,
    resets,
  };
}
