/**
 * The reset ledger kept by `UsageResetLedger`, as plain data: a cursor per
 * account window (the last read, and when its period began) and the periods
 * that closed. Unlike the quota history, which holds fourteen days of
 * samples, a closed period is one small record, so a year of them is kept.
 *
 * @module usage/usageResetLedgerStore
 */
import type {
  ServerProvider,
  ServerProviderUsageWindow,
  UsageResetCause,
  UsageResetPeriod,
} from "@specweave-studio/contracts";
import { isFreshSample, resetBetween } from "@specweave-studio/shared/usageLimitForecast";
import {
  closedReset,
  isLedgerWindow,
  ledgerWindowLengthMs,
} from "@specweave-studio/shared/usageResetLedger";
import { windowModelScope } from "@specweave-studio/shared/usageWindows";

import { type HistoryReading, isoAt } from "./usageLimitHistoryStore.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const LEDGER_RETENTION_MS = 366 * DAY;
export const MAX_LEDGER_PERIODS = 5_000;
/** A window not read for this long is gone (signed out, plan changed); its cursor is dropped. */
const CURSOR_RETENTION_MS = 60 * DAY;

export interface LedgerCursor {
  readonly accountKey: string;
  readonly driver: ServerProvider["driver"];
  readonly windowId: string;
  readonly windowKind: ServerProviderUsageWindow["kind"];
  windowDurationMins: number | undefined;
  /** The model family the window is limited to; null for an account-wide window. */
  readonly modelScope: string | null;
  at: number;
  usedPercent: number;
  resetsAt: number | null;
  /** When the running period began; null when that reset was never observed. */
  startedAt: number | null;
  /**
   * Banked resets at the last read, and the read that first saw one fewer. A
   * reset counts as redeemed only when it shows at that read or the next:
   * a credit that left weeks ago (spent, or expired) says nothing about a
   * later early reset.
   */
  credits: number | null;
  creditSpentAt: number | null;
}

export interface LedgerPeriod {
  readonly accountKey: string;
  readonly driver: ServerProvider["driver"];
  readonly windowId: string;
  readonly windowKind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins: number | undefined;
  readonly modelScope: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number;
  readonly lastReadAt: number;
  readonly usedPercentAtReset: number;
  readonly lostPercent: number;
  readonly cause: UsageResetCause;
}

export interface LedgerState {
  readonly cursors: Map<string, LedgerCursor>;
  periods: LedgerPeriod[];
}

export const emptyLedger = (): LedgerState => ({ cursors: new Map(), periods: [] });

/** One account's windows as read at `checkedAt`, with its banked resets when the provider reports them. */
export interface LedgerReading extends HistoryReading {
  readonly resetCredits: number | null;
}

function cursorKey(
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

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

/**
 * Moves each ledger window's cursor to this reading and returns the periods
 * that closed on the way. A read that is older than the cursor, or a kept
 * read restamped after its own reset time, changes nothing.
 */
export function advanceLedger(state: LedgerState, reading: LedgerReading): LedgerPeriod[] {
  if (!Number.isFinite(reading.checkedAt)) return [];
  const closedPeriods: LedgerPeriod[] = [];
  for (const window of reading.windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    if (!isLedgerWindow(window.kind, window.windowDurationMins)) continue;
    const key = cursorKey(reading.accountKey, window.kind, window.id);
    const sample = {
      at: reading.checkedAt,
      usedPercent: clampPercent(window.usedPercent),
      resetsAt: parseTime(window.resetsAt),
    };
    if (!isFreshSample(sample)) continue;
    const cursor = state.cursors.get(key);
    if (!cursor) {
      state.cursors.set(key, {
        accountKey: reading.accountKey,
        driver: reading.driver,
        windowId: window.id,
        windowKind: window.kind,
        windowDurationMins: window.windowDurationMins,
        modelScope: windowModelScope(window),
        ...sample,
        startedAt: null,
        credits: reading.resetCredits,
        creditSpentAt: null,
      });
      continue;
    }
    if (sample.at <= cursor.at) continue;
    if (window.windowDurationMins !== undefined) {
      cursor.windowDurationMins = window.windowDurationMins;
    }
    if (
      cursor.credits !== null &&
      reading.resetCredits !== null &&
      reading.resetCredits < cursor.credits
    ) {
      cursor.creditSpentAt = sample.at;
    }
    const lengthMs = ledgerWindowLengthMs(cursor.windowKind, cursor.windowDurationMins);
    const redeemed = cursor.creditSpentAt !== null && cursor.creditSpentAt >= cursor.at;
    const closed = closedReset(cursor, sample, lengthMs, redeemed);
    if (closed) {
      closedPeriods.push({
        accountKey: cursor.accountKey,
        driver: cursor.driver,
        windowId: cursor.windowId,
        windowKind: cursor.windowKind,
        windowDurationMins: cursor.windowDurationMins,
        modelScope: cursor.modelScope,
        startedAt: cursor.startedAt,
        ...closed,
      });
      cursor.startedAt = closed.endedAt;
      cursor.creditSpentAt = null;
    } else if (resetBetween(cursor, sample, lengthMs)) {
      // The window started over with its spend unread: no period, and the new one's start is
      // known only when the reset fell between two reads less than a window apart.
      cursor.startedAt = lengthMs !== null && sample.at - cursor.at >= lengthMs ? null : sample.at;
      cursor.creditSpentAt = null;
    }
    cursor.at = sample.at;
    cursor.usedPercent = sample.usedPercent;
    cursor.resetsAt = sample.resetsAt;
    if (reading.resetCredits !== null) cursor.credits = reading.resetCredits;
  }
  if (closedPeriods.length > 0) state.periods.push(...closedPeriods);
  return closedPeriods;
}

/** Drops periods past a year, the oldest past the cap, and cursors of windows long unread. */
export function pruneLedger(state: LedgerState, now: number): boolean {
  let changed = false;
  const kept = state.periods.filter((period) => period.endedAt >= now - LEDGER_RETENTION_MS);
  const capped = kept.length > MAX_LEDGER_PERIODS ? kept.slice(-MAX_LEDGER_PERIODS) : kept;
  if (capped.length !== state.periods.length) {
    state.periods = capped;
    changed = true;
  }
  for (const [key, cursor] of state.cursors) {
    if (cursor.at < now - CURSOR_RETENTION_MS) {
      state.cursors.delete(key);
      changed = true;
    }
  }
  return changed;
}

export function readLedger(state: LedgerState, since: number): UsageResetPeriod[] {
  return state.periods
    .filter((period) => period.endedAt >= since)
    .map((period) => ({
      accountKey: period.accountKey,
      driver: period.driver,
      windowId: period.windowId,
      windowKind: period.windowKind,
      ...(period.windowDurationMins === undefined
        ? {}
        : { windowDurationMins: period.windowDurationMins }),
      ...(period.modelScope === null ? {} : { modelScope: period.modelScope }),
      ...(period.startedAt === null ? {} : { startedAt: isoAt(period.startedAt) }),
      endedAt: isoAt(period.endedAt),
      lastReadAt: isoAt(period.lastReadAt),
      usedPercentAtReset: period.usedPercentAtReset,
      lostPercent: period.lostPercent,
      cause: period.cause,
    }));
}

/** Every account with a followed window, once each, with the newest read of any of them. */
export function ledgerAccounts(
  state: LedgerState,
): Array<{ accountKey: string; driver: ServerProvider["driver"]; lastReadAt: number }> {
  const accounts = new Map<string, { driver: ServerProvider["driver"]; lastReadAt: number }>();
  for (const cursor of state.cursors.values()) {
    const known = accounts.get(cursor.accountKey);
    accounts.set(cursor.accountKey, {
      driver: cursor.driver,
      lastReadAt: Math.max(known?.lastReadAt ?? 0, cursor.at),
    });
  }
  return [...accounts].map(([accountKey, account]) => ({ accountKey, ...account }));
}

const FILE_VERSION = 1;

export function encodeLedgerFile(state: LedgerState): string {
  return `${JSON.stringify({
    version: FILE_VERSION,
    cursors: [...state.cursors.values()],
    periods: state.periods,
  })}\n`;
}

const WINDOW_KINDS: ReadonlySet<string> = new Set(["session", "weekly", "monthly", "other"]);
const CAUSES: ReadonlySet<string> = new Set(["scheduled", "early", "redeemed"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isTimeOrNull = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

function decodeWindow(entry: Record<string, unknown>) {
  const { accountKey, driver, windowId, windowKind, windowDurationMins, modelScope } = entry;
  if (!isName(accountKey) || !isName(driver) || !isName(windowId)) return null;
  if (typeof windowKind !== "string" || !WINDOW_KINDS.has(windowKind)) return null;
  return {
    accountKey,
    driver: driver as ServerProvider["driver"],
    windowId,
    windowKind: windowKind as ServerProviderUsageWindow["kind"],
    windowDurationMins:
      isFiniteNumber(windowDurationMins) && windowDurationMins >= 0
        ? Math.round(windowDurationMins)
        : undefined,
    modelScope: isName(modelScope) ? modelScope : null,
  };
}

/** Reads what `encodeLedgerFile` wrote; anything malformed is dropped, not fatal. */
export function decodeLedgerFile(raw: string): LedgerState {
  const state = emptyLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION) return state;
  for (const entry of Array.isArray(parsed.cursors) ? parsed.cursors : []) {
    if (!isRecord(entry)) continue;
    const window = decodeWindow(entry);
    const { at, usedPercent, resetsAt, startedAt, credits, creditSpentAt, creditSpent } = entry;
    if (!window || !isFiniteNumber(at) || !isFiniteNumber(usedPercent)) continue;
    if (!isTimeOrNull(resetsAt) || !isTimeOrNull(startedAt)) continue;
    state.cursors.set(cursorKey(window.accountKey, window.windowKind, window.windowId), {
      ...window,
      at,
      usedPercent: clampPercent(usedPercent),
      resetsAt,
      startedAt,
      credits: isFiniteNumber(credits) ? credits : null,
      // A file written before `creditSpentAt` only says a credit was spent: date it at the last read.
      creditSpentAt: isFiniteNumber(creditSpentAt) ? creditSpentAt : creditSpent === true ? at : null,
    });
  }
  for (const entry of Array.isArray(parsed.periods) ? parsed.periods : []) {
    if (!isRecord(entry)) continue;
    const window = decodeWindow(entry);
    const { startedAt, endedAt, lastReadAt, usedPercentAtReset, lostPercent, cause } = entry;
    if (!window || !isFiniteNumber(endedAt) || !isFiniteNumber(lastReadAt)) continue;
    if (!isTimeOrNull(startedAt)) continue;
    if (!isFiniteNumber(usedPercentAtReset) || !isFiniteNumber(lostPercent)) continue;
    if (typeof cause !== "string" || !CAUSES.has(cause)) continue;
    state.periods.push({
      ...window,
      startedAt,
      endedAt,
      lastReadAt,
      usedPercentAtReset: clampPercent(usedPercentAtReset),
      lostPercent: clampPercent(lostPercent),
      cause: cause as UsageResetCause,
    });
  }
  state.periods.sort((left, right) => left.endedAt - right.endedAt);
  return state;
}
