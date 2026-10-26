/**
 * The quota history kept by `UsageLimitHistory`, as plain data: which reads
 * are worth a sample, how long they are kept, and the file format.
 *
 * A read becomes a sample when it is newer than the series' last sample and
 * either changed or the series has been flat for half an hour, so a quiet
 * account still shows as a level line instead of a gap. Sample times are the
 * provider's `checkedAt`, so a cached snapshot replayed on boot adds nothing.
 *
 * @module usage/usageLimitHistoryStore
 */
import type {
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitHistorySeries,
  UsageLimitSourceSnapshot,
} from "@specweave-studio/contracts";
import { limitAccountKey } from "@specweave-studio/shared/usageLimits";
import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const HISTORY_RETENTION_MS = 14 * 24 * HOUR;
export const MAX_SAMPLES_PER_SERIES = 3_000;
const MAX_SERIES = 400;
/** A flat series still gets a sample this often, so the chart shows it level. */
export const FLAT_SAMPLE_INTERVAL_MS = 30 * MINUTE;
/** Providers round reset times differently between reads; closer than this is the same reset. */
const SAME_RESET_TOLERANCE_MS = 5 * MINUTE;

export interface HistorySample {
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

export interface HistorySeries {
  readonly accountKey: string;
  readonly driver: ServerProvider["driver"];
  readonly windowId: string;
  readonly windowKind: ServerProviderUsageWindow["kind"];
  windowDurationMins: number | undefined;
  samples: HistorySample[];
}

export type HistoryState = Map<string, HistorySeries>;

/** One account's windows as read at `checkedAt`. */
export interface HistoryReading {
  readonly accountKey: string;
  readonly driver: ServerProvider["driver"];
  readonly checkedAt: number;
  readonly windows: readonly ServerProviderUsageWindow[];
}

function historySeriesKey(
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

export function isoAt(at: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(at));
}

function sameReset(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < SAME_RESET_TOLERANCE_MS;
}

/** 0..100 to two decimals, so float noise (28.999999999999996) does not read as a change. */
function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

/** Adds the reading's windows to their series. Returns whether anything was stored. */
export function recordReading(state: HistoryState, reading: HistoryReading): boolean {
  if (!Number.isFinite(reading.checkedAt)) return false;
  let changed = false;
  for (const window of reading.windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    const key = historySeriesKey(reading.accountKey, window.kind, window.id);
    let series = state.get(key);
    if (!series) {
      series = {
        accountKey: reading.accountKey,
        driver: reading.driver,
        windowId: window.id,
        windowKind: window.kind,
        windowDurationMins: window.windowDurationMins,
        samples: [],
      };
      state.set(key, series);
    } else if (window.windowDurationMins !== undefined) {
      series.windowDurationMins = window.windowDurationMins;
    }
    const sample: HistorySample = {
      at: reading.checkedAt,
      usedPercent: clampPercent(window.usedPercent),
      resetsAt: parseTime(window.resetsAt),
    };
    const last = series.samples[series.samples.length - 1];
    if (last && sample.at <= last.at) continue;
    if (
      last &&
      last.usedPercent === sample.usedPercent &&
      sameReset(last.resetsAt, sample.resetsAt) &&
      sample.at - last.at < FLAT_SAMPLE_INTERVAL_MS
    ) {
      continue;
    }
    series.samples.push(sample);
    if (series.samples.length > MAX_SAMPLES_PER_SERIES) {
      series.samples.splice(0, series.samples.length - MAX_SAMPLES_PER_SERIES);
    }
    changed = true;
  }
  return changed;
}

/**
 * Drops samples past retention and series left empty, then the series heard
 * from least recently while there are more than `MAX_SERIES`.
 */
export function pruneHistory(state: HistoryState, now: number): boolean {
  const cutoff = now - HISTORY_RETENTION_MS;
  let changed = false;
  for (const [key, series] of state) {
    const keepFrom = series.samples.findIndex((sample) => sample.at >= cutoff);
    if (keepFrom === -1) {
      state.delete(key);
      changed = true;
    } else if (keepFrom > 0) {
      series.samples = series.samples.slice(keepFrom);
      changed = true;
    }
  }
  if (state.size > MAX_SERIES) {
    const byLastSample = [...state].sort(
      ([, left], [, right]) =>
        (left.samples[left.samples.length - 1]?.at ?? 0) -
        (right.samples[right.samples.length - 1]?.at ?? 0),
    );
    for (const [key] of byLastSample.slice(0, state.size - MAX_SERIES)) state.delete(key);
    changed = true;
  }
  return changed;
}

/**
 * Samples from `since` on, plus the last one before it: a flat stretch that
 * started earlier still has a known level at the start of the range.
 */
export function readHistory(state: HistoryState, since: number): UsageLimitHistorySeries[] {
  const result: UsageLimitHistorySeries[] = [];
  for (const series of state.values()) {
    const firstInRange = series.samples.findIndex((sample) => sample.at >= since);
    const from = firstInRange === -1 ? series.samples.length - 1 : Math.max(0, firstInRange - 1);
    const samples = series.samples.slice(Math.max(0, from));
    if (samples.length === 0) continue;
    result.push({
      accountKey: series.accountKey,
      driver: series.driver,
      windowId: series.windowId,
      windowKind: series.windowKind,
      ...(series.windowDurationMins === undefined
        ? {}
        : { windowDurationMins: series.windowDurationMins }),
      samples: samples.map((sample) => ({
        at: isoAt(sample.at),
        usedPercent: sample.usedPercent,
        ...(sample.resetsAt === null ? {} : { resetsAt: isoAt(sample.resetsAt) }),
      })),
    });
  }
  return result;
}

function usableLimits(
  limits: ServerProviderUsageLimits | undefined,
): limits is ServerProviderUsageLimits {
  return limits !== undefined && limits.unavailable === undefined && limits.windows.length > 0;
}

/** Signed-in instances with a usable read. An account with no email or credential key has nothing to line up with, so it is skipped. */
export function readingsFromProviders(providers: readonly ServerProvider[]): HistoryReading[] {
  return providers.flatMap((provider) => {
    const limits = provider.usageLimits;
    if (!usableLimits(limits)) return [];
    const accountKey = limitAccountKey(provider.driver, provider.auth.email, limits);
    const checkedAt = parseTime(limits.checkedAt);
    if (accountKey === null || checkedAt === null) return [];
    return [{ accountKey, driver: provider.driver, checkedAt, windows: limits.windows }];
  });
}

export function readingsFromSources(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): HistoryReading[] {
  return sources.flatMap((source) =>
    source.accounts.flatMap((account) => {
      const limits = account.usageLimits;
      if (!usableLimits(limits)) return [];
      const accountKey = limitAccountKey(account.driver, account.email, limits);
      const checkedAt = parseTime(limits.checkedAt);
      if (accountKey === null || checkedAt === null) return [];
      return [{ accountKey, driver: account.driver, checkedAt, windows: limits.windows }];
    }),
  );
}

const FILE_VERSION = 1;

/** Compact on disk: each sample is `[at, usedPercent, resetsAt | null]`. */
export function encodeHistoryFile(state: HistoryState): string {
  return `${JSON.stringify({
    version: FILE_VERSION,
    series: [...state.values()].map((series) => ({
      accountKey: series.accountKey,
      driver: series.driver,
      windowId: series.windowId,
      windowKind: series.windowKind,
      ...(series.windowDurationMins === undefined
        ? {}
        : { windowDurationMins: series.windowDurationMins }),
      samples: series.samples.map((sample) => [sample.at, sample.usedPercent, sample.resetsAt]),
    })),
  })}\n`;
}

const WINDOW_KINDS: ReadonlySet<string> = new Set(["session", "weekly", "monthly", "other"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Reads what `encodeHistoryFile` wrote; anything malformed is dropped, not fatal. */
export function decodeHistoryFile(raw: string): HistoryState {
  const state: HistoryState = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !Array.isArray(parsed.series)) {
    return state;
  }
  for (const entry of parsed.series) {
    if (!isRecord(entry)) continue;
    const { accountKey, driver, windowId, windowKind, windowDurationMins, samples } = entry;
    if (
      typeof accountKey !== "string" ||
      accountKey.trim() === "" ||
      typeof driver !== "string" ||
      typeof windowId !== "string" ||
      windowId.trim() === "" ||
      typeof windowKind !== "string" ||
      !WINDOW_KINDS.has(windowKind) ||
      !Array.isArray(samples)
    ) {
      continue;
    }
    const decoded: HistorySample[] = [];
    for (const sample of samples) {
      if (!Array.isArray(sample)) continue;
      const [at, usedPercent, resetsAt] = sample as unknown[];
      if (!isFiniteNumber(at) || !isFiniteNumber(usedPercent)) continue;
      if (resetsAt !== null && !isFiniteNumber(resetsAt)) continue;
      const previous = decoded[decoded.length - 1];
      if (previous && at <= previous.at) continue;
      decoded.push({ at, usedPercent: clampPercent(usedPercent), resetsAt });
    }
    if (decoded.length === 0) continue;
    state.set(
      historySeriesKey(accountKey, windowKind as ServerProviderUsageWindow["kind"], windowId),
      {
        accountKey,
        driver: driver as ServerProvider["driver"],
        windowId,
        windowKind: windowKind as ServerProviderUsageWindow["kind"],
        windowDurationMins:
          isFiniteNumber(windowDurationMins) && windowDurationMins >= 0
            ? Math.round(windowDurationMins)
            : undefined,
        samples: decoded.slice(-MAX_SAMPLES_PER_SERIES),
      },
    );
  }
  return state;
}
