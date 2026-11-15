import { ProviderDriverKind, type ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isoAt } from "./usageLimitHistoryStore.ts";
import {
  type LedgerReading,
  LEDGER_RETENTION_MS,
  advanceLedger,
  decodeLedgerFile,
  emptyLedger,
  encodeLedgerFile,
  ledgerAccounts,
  pruneLedger,
  readLedger,
} from "./usageResetLedgerStore.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const t0 = Date.parse("2026-11-02T12:00:00.000Z");
const reset1 = t0 + 2 * DAY;
const reset2 = reset1 + WEEK;
const codex = ProviderDriverKind.make("codex");

const weekly = (usedPercent: number, resetsAt: number | null): ServerProviderUsageWindow => ({
  id: "secondary",
  kind: "weekly",
  label: "Weekly",
  windowDurationMins: 7 * 24 * 60,
  usedPercent,
  ...(resetsAt === null ? {} : { resetsAt: isoAt(resetsAt) }),
});
const session = (usedPercent: number, resetsAt: number): ServerProviderUsageWindow => ({
  id: "primary",
  kind: "session",
  label: "Session",
  windowDurationMins: 300,
  usedPercent,
  resetsAt: isoAt(resetsAt),
});
const reading = (
  checkedAt: number,
  windows: ServerProviderUsageWindow[],
  resetCredits: number | null = null,
): LedgerReading => ({
  accountKey: "codex:pro@example.com",
  driver: codex,
  checkedAt,
  windows,
  resetCredits,
});

describe("advanceLedger", () => {
  it("closes a weekly period at its reset and starts the next from it", () => {
    const state = emptyLedger();
    expect(advanceLedger(state, reading(t0, [weekly(30, reset1)]))).toEqual([]);
    expect(advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)]))).toEqual([]);
    const closed = advanceLedger(state, reading(reset1 + HOUR, [weekly(2, reset2)]));
    expect(closed).toMatchObject([
      {
        accountKey: "codex:pro@example.com",
        windowId: "secondary",
        startedAt: null,
        endedAt: reset1,
        lastReadAt: reset1 - HOUR,
        usedPercentAtReset: 59,
        lostPercent: 41,
        cause: "scheduled",
      },
    ]);
    advanceLedger(state, reading(reset2 - HOUR, [weekly(96, reset2)]));
    const next = advanceLedger(state, reading(reset2 + HOUR, [weekly(1, reset2 + WEEK)]));
    expect(next).toMatchObject([{ startedAt: reset1, endedAt: reset2, lostPercent: 4 }]);
    expect(state.periods).toHaveLength(2);
  });

  it("never ledgers the session window", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [session(90, t0 + HOUR)]));
    expect(advanceLedger(state, reading(t0 + 2 * HOUR, [session(3, t0 + 7 * HOUR)]))).toEqual([]);
    expect(state.cursors.size).toBe(0);
  });

  it("names an early reset, and a redeemed one when a banked reset was spent", () => {
    const early = emptyLedger();
    advanceLedger(early, reading(t0, [weekly(80, reset1)], 2));
    expect(
      advanceLedger(early, reading(t0 + HOUR, [weekly(0, t0 + HOUR + WEEK)], 2)),
    ).toMatchObject([{ cause: "early", endedAt: t0 + HOUR, lostPercent: 20 }]);

    const redeemed = emptyLedger();
    advanceLedger(redeemed, reading(t0, [weekly(100, reset1)], 2));
    expect(
      advanceLedger(redeemed, reading(t0 + HOUR, [weekly(0, t0 + HOUR + WEEK)], 1)),
    ).toMatchObject([{ cause: "redeemed", lostPercent: 0 }]);
  });

  it("does not call an early reset redeemed for a credit that left reads earlier", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [weekly(40, reset1)], 2));
    // One credit expires; the window keeps running.
    advanceLedger(state, reading(t0 + HOUR, [weekly(45, reset1)], 1));
    advanceLedger(state, reading(t0 + 10 * HOUR, [weekly(70, reset1)], 1));
    expect(
      advanceLedger(state, reading(t0 + 11 * HOUR, [weekly(0, t0 + 11 * HOUR + WEEK)], 1)),
    ).toMatchObject([{ cause: "early", lostPercent: 30 }]);
  });

  it("invents no period for a monthly window of unreported length read months apart", () => {
    const monthly = (usedPercent: number): ServerProviderUsageWindow => ({
      id: "premium",
      kind: "monthly",
      label: "Monthly",
      usedPercent,
    });
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [monthly(80)]));
    expect(advanceLedger(state, reading(t0 + 105 * DAY, [monthly(20)]))).toEqual([]);
    expect(state.periods).toEqual([]);
  });

  it("closes nothing for an account seen only at its limit, a week apart", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [weekly(100, null)]));
    expect(advanceLedger(state, reading(t0 + 8 * DAY, [weekly(100, null)]))).toEqual([]);
    // The period after the gap has no known start.
    expect(
      advanceLedger(state, reading(t0 + 8 * DAY + HOUR, [weekly(4, null)])),
    ).toMatchObject([{ startedAt: null, usedPercentAtReset: 100, lostPercent: 0 }]);
  });

  it("ignores a kept read restamped after its own reset time, and older reads", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)]));
    expect(advanceLedger(state, reading(reset1 + 3 * HOUR, [weekly(59, reset1)]))).toEqual([]);
    expect(advanceLedger(state, reading(reset1 - 2 * HOUR, [weekly(10, reset1)]))).toEqual([]);
    expect(
      advanceLedger(state, reading(reset1 + 4 * HOUR, [weekly(3, reset2)])),
    ).toMatchObject([{ usedPercentAtReset: 59, lastReadAt: reset1 - HOUR }]);
  });
});

describe("ledger file", () => {
  it("round-trips cursors and periods, and drops malformed entries", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)], 1));
    advanceLedger(state, reading(reset1 + HOUR, [weekly(2, reset2)], 1));
    const decoded = decodeLedgerFile(encodeLedgerFile(state));
    expect(decoded.periods).toEqual(state.periods);
    expect([...decoded.cursors.values()]).toEqual([...state.cursors.values()]);
    // A restart continues the running period where it was.
    advanceLedger(decoded, reading(reset2 - HOUR, [weekly(2, reset2)], 1));
    expect(
      advanceLedger(decoded, reading(reset2 + HOUR, [weekly(0, reset2 + WEEK)], 1)),
    ).toMatchObject([{ startedAt: reset1, endedAt: reset2, lostPercent: 98 }]);

    expect(decodeLedgerFile("not json").periods).toEqual([]);
    const damaged = JSON.stringify({
      version: 1,
      cursors: [{ accountKey: "", windowId: "x" }, 4],
      periods: [{ ...state.periods[0], cause: "guess" }, null, state.periods[0]],
    });
    expect(decodeLedgerFile(damaged).periods).toEqual([state.periods[0]]);
    expect(decodeLedgerFile(damaged).cursors.size).toBe(0);
  });

  it("serves periods since a time, as wire values", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)]));
    advanceLedger(state, reading(reset1 + HOUR, [weekly(2, reset2)]));
    expect(readLedger(state, reset1 + DAY)).toEqual([]);
    expect(readLedger(state, t0)).toEqual([
      {
        accountKey: "codex:pro@example.com",
        driver: codex,
        windowId: "secondary",
        windowKind: "weekly",
        windowDurationMins: 10_080,
        endedAt: isoAt(reset1),
        lastReadAt: isoAt(reset1 - HOUR),
        usedPercentAtReset: 59,
        lostPercent: 41,
        cause: "scheduled",
      },
    ]);
  });

  it("prunes periods past a year and cursors of windows long unread", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)]));
    advanceLedger(state, reading(reset1 + HOUR, [weekly(2, reset2)]));
    expect(pruneLedger(state, reset1 + DAY)).toBe(false);
    expect(pruneLedger(state, reset1 + LEDGER_RETENTION_MS + DAY)).toBe(true);
    expect(state.periods).toEqual([]);
    expect(state.cursors.size).toBe(0);
  });
});

describe("ledger accounts and older files", () => {
  it("lists an account that was read without closing a period", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [weekly(100, null)]));
    expect(ledgerAccounts(state)).toEqual([{ accountKey: "codex:pro@example.com", driver: codex }]);
    expect(state.periods).toEqual([]);
  });

  it("dates a spent credit from a file written before the time was kept", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(t0, [weekly(100, reset1)], 2));
    const file = JSON.parse(encodeLedgerFile(state));
    delete file.cursors[0].creditSpentAt;
    file.cursors[0].creditSpent = true;
    const restored = decodeLedgerFile(JSON.stringify(file));
    expect(
      advanceLedger(restored, reading(t0 + HOUR, [weekly(0, t0 + HOUR + WEEK)], 1)),
    ).toMatchObject([{ cause: "redeemed" }]);
  });
});
