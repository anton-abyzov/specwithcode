import { ProviderDriverKind, type ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type HistorySeries, type HistoryState, isoAt } from "./usageLimitHistoryStore.ts";
import {
  type LedgerReading,
  LEDGER_RETENTION_MS,
  advanceLedger,
  backfillLedger,
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
    expect(advanceLedger(state, reading(t0 + 8 * DAY + HOUR, [weekly(4, null)]))).toMatchObject([
      { startedAt: null, usedPercentAtReset: 100, lostPercent: 0 },
    ]);
  });

  it("ignores a kept read restamped after its own reset time, and older reads", () => {
    const state = emptyLedger();
    advanceLedger(state, reading(reset1 - HOUR, [weekly(59, reset1)]));
    expect(advanceLedger(state, reading(reset1 + 3 * HOUR, [weekly(59, reset1)]))).toEqual([]);
    expect(advanceLedger(state, reading(reset1 - 2 * HOUR, [weekly(10, reset1)]))).toEqual([]);
    expect(advanceLedger(state, reading(reset1 + 4 * HOUR, [weekly(3, reset2)]))).toMatchObject([
      { usedPercentAtReset: 59, lastReadAt: reset1 - HOUR },
    ]);
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
    expect(ledgerAccounts(state)).toEqual([
      { accountKey: "codex:pro@example.com", driver: codex, lastReadAt: t0 },
    ]);
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

describe("backfillLedger", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const series = (
    windowId: string,
    windowKind: HistorySeries["windowKind"],
    samples: Array<[number, number, number | null]>,
    accountKey = "claude:max@example.com",
  ): HistorySeries => ({
    accountKey,
    driver: accountKey.startsWith("codex") ? codex : claude,
    windowId,
    windowKind,
    windowDurationMins: windowKind === "session" ? 300 : undefined,
    samples: samples.map(([at, usedPercent, resetsAt]) => ({ at, usedPercent, resetsAt })),
  });
  const history = (...all: HistorySeries[]): HistoryState =>
    new Map(
      all.map((entry) => [`${entry.accountKey}|${entry.windowKind}:${entry.windowId}`, entry]),
    );
  const twoResets: Array<[number, number, number | null]> = [
    [t0, 40, reset1],
    [reset1 - HOUR, 97, reset1],
    [reset1 + HOUR, 3, reset2],
    [reset2 - 2 * HOUR, 69, reset2],
    [reset2 + HOUR, 1, reset2 + WEEK],
  ];

  it("adds the resets the history saw, with the model scope from the window id", () => {
    const state = emptyLedger();
    const added = backfillLedger(
      state,
      history(
        series("seven_day", "weekly", twoResets),
        series("seven_day_opus", "weekly", twoResets),
        series("five_hour", "session", [
          [t0, 80, t0 + HOUR],
          [t0 + 2 * HOUR, 5, t0 + 6 * HOUR],
        ]),
      ),
    );
    expect(added).toBe(4);
    expect(
      state.periods.map((period) => [
        period.windowId,
        period.modelScope,
        period.usedPercentAtReset,
      ]),
    ).toEqual([
      ["seven_day", null, 97],
      ["seven_day_opus", "opus", 97],
      ["seven_day", null, 69],
      ["seven_day_opus", "opus", 69],
    ]);
    expect(state.periods[2]).toMatchObject({
      startedAt: reset1,
      endedAt: reset2,
      cause: "scheduled",
    });
  });

  it("adds nothing twice, whether from an earlier backfill or a live read", () => {
    const state = emptyLedger();
    advanceLedger(state, {
      accountKey: "codex:pro@example.com",
      driver: codex,
      checkedAt: reset1 - HOUR,
      windows: [weekly(97, reset1)],
      resetCredits: null,
    });
    advanceLedger(state, {
      accountKey: "codex:pro@example.com",
      driver: codex,
      checkedAt: reset1 + 30 * MINUTE,
      windows: [weekly(2, reset2)],
      resetCredits: null,
    });
    expect(state.periods).toHaveLength(1);
    const past = history(series("secondary", "weekly", twoResets, "codex:pro@example.com"));
    expect(backfillLedger(state, past)).toBe(1);
    expect(backfillLedger(state, past)).toBe(0);
    expect(state.periods.map((period) => period.endedAt)).toEqual([reset1, reset2]);
  });

  it("keeps a weekly and a monthly window with one id apart, and scopes Codex buckets", () => {
    const state = emptyLedger();
    const monthReset = t0 + 20 * DAY;
    backfillLedger(
      state,
      history(
        series("primary", "weekly", twoResets, "codex:pro@example.com"),
        series(
          "primary",
          "monthly",
          [
            [t0, 50, monthReset],
            [monthReset - HOUR, 88, monthReset],
            [monthReset + HOUR, 0, monthReset + 30 * DAY],
          ],
          "codex:pro@example.com",
        ),
        series("gpt-5-codex:secondary", "weekly", twoResets, "codex:pro@example.com"),
      ),
    );
    expect(
      state.periods
        .filter((period) => period.windowId === "primary")
        .map((period) => [period.windowKind, period.usedPercentAtReset]),
    ).toEqual([
      ["weekly", 97],
      ["weekly", 69],
      ["monthly", 88],
    ]);
    expect(state.periods.find((period) => period.windowId.includes(":"))?.modelScope).toBe(
      "gpt-5-codex",
    );
  });

  it("dates the running period from the last reset the history saw", () => {
    const state = emptyLedger();
    advanceLedger(state, {
      accountKey: "claude:max@example.com",
      driver: claude,
      checkedAt: reset2 + 2 * HOUR,
      windows: [{ ...weekly(4, reset2 + WEEK), id: "seven_day" }],
      resetCredits: null,
    });
    backfillLedger(state, history(series("seven_day", "weekly", twoResets)));
    expect([...state.cursors.values()][0]?.startedAt).toBe(reset2);
  });

  it("adds a reset read at its own reset time once, across restarts", () => {
    const state = emptyLedger();
    const past = history(
      series("seven_day", "weekly", [
        [reset1, 90, reset1],
        [reset1 + HOUR, 2, reset2],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(1);
    expect(state.periods[0]).toMatchObject({ lastReadAt: reset1, endedAt: reset1 });
    expect(backfillLedger(state, past)).toBe(0);
    expect(backfillLedger(state, past)).toBe(0);
    expect(state.periods).toHaveLength(1);
  });

  it("adds nothing for a reset the live ledger closed at a read just past its announced time", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(reset1 - 10 * MINUTE, 90, reset1);
    // Still fresh five minutes past the reset; the history skipped it as unchanged.
    live(reset1 + 2 * MINUTE, 90, reset1);
    live(reset1 + 6 * MINUTE, 2, reset2);
    expect(state.periods.map((period) => [period.lastReadAt, period.endedAt])).toEqual([
      [reset1 + 2 * MINUTE, reset1 + 2 * MINUTE],
    ]);
    const past = history(
      series("seven_day", "weekly", [
        [reset1 - 10 * MINUTE, 90, reset1],
        [reset1 + 6 * MINUTE, 2, reset2],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(0);
    expect(state.periods).toHaveLength(1);
  });

  it("backfills an early reset minutes after another the ledger already holds", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(t0, 80, reset1);
    live(t0 + HOUR, 5, reset1 + DAY);
    expect(state.periods).toHaveLength(1);
    const past = history(
      series("seven_day", "weekly", [
        [t0 + HOUR, 5, reset1 + DAY],
        [t0 + HOUR + 5 * MINUTE, 30, reset1 + DAY],
        [t0 + HOUR + 10 * MINUTE, 1, reset1 + 2 * DAY],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(1);
    expect(state.periods).toHaveLength(2);
  });

  it("backfills an early reset minutes after a reset the ledger closed at a late read", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(reset1 - 10 * MINUTE, 90, reset1);
    live(reset1 + 2 * MINUTE, 90, reset1);
    live(reset1 + 4 * MINUTE, 1, reset2);
    expect(state.periods.map((period) => period.endedAt)).toEqual([reset1 + 2 * MINUTE]);
    const past = history(
      series("seven_day", "weekly", [
        [reset1 + 4 * MINUTE, 1, reset2],
        [reset1 + 8 * MINUTE, 30, reset2],
        [reset1 + 12 * MINUTE, 1, reset2 + DAY],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(1);
    expect(state.periods.map((period) => period.endedAt)).toEqual([
      reset1 + 2 * MINUTE,
      reset1 + 12 * MINUTE,
    ]);
  });

  it("adds nothing for a reset the history saw with a differently rounded time", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(reset1 - 10 * MINUTE, 90, reset1);
    live(reset1 + MINUTE, 90, reset1);
    live(reset1 + 6 * MINUTE, 1, reset2);
    expect(state.periods.map((period) => period.endedAt)).toEqual([reset1 + MINUTE]);
    const past = history(
      series("seven_day", "weekly", [
        [reset1 - 10 * MINUTE, 90, reset1 + 3 * MINUTE],
        [reset1 + 2 * MINUTE, 90, reset1 + 3 * MINUTE],
        [reset1 + 6 * MINUTE, 1, reset2],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(0);
    expect(state.periods).toHaveLength(1);
  });

  it("adds nothing when the ledger and the history both read a reset before its rounded time", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(reset1 - 10 * MINUTE, 90, reset1 + 3 * MINUTE);
    live(reset1 + 2 * MINUTE, 90, reset1 + 3 * MINUTE);
    live(reset1 + 6 * MINUTE, 1, reset2);
    expect(state.periods.map((period) => period.endedAt)).toEqual([reset1 + 3 * MINUTE]);
    const past = history(
      series("seven_day", "weekly", [
        [reset1 - 10 * MINUTE, 90, reset1 + 4 * MINUTE],
        [reset1 + 3.5 * MINUTE, 90, reset1 + 4 * MINUTE],
        [reset1 + 6 * MINUTE, 1, reset2],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(0);
    expect(state.periods).toHaveLength(1);
  });

  it("backfills an early reset four minutes after a scheduled one the ledger holds", () => {
    const state = emptyLedger();
    const live = (checkedAt: number, used: number, resetsAt: number) =>
      advanceLedger(state, {
        accountKey: "claude:max@example.com",
        driver: claude,
        checkedAt,
        windows: [{ ...weekly(used, resetsAt), id: "seven_day" }],
        resetCredits: null,
      });
    live(reset1 - 10 * MINUTE, 90, reset1);
    live(reset1 + 2 * MINUTE, 90, reset1);
    live(reset1 + 3 * MINUTE, 1, reset2);
    expect(state.periods.map((period) => period.endedAt)).toEqual([reset1 + 2 * MINUTE]);
    const past = history(
      series("seven_day", "weekly", [
        [reset1 + 3 * MINUTE, 1, reset2],
        [reset1 + 4 * MINUTE, 30, reset2],
        [reset1 + 6 * MINUTE, 1, reset2 + DAY],
      ]),
    );
    expect(backfillLedger(state, past)).toBe(1);
    expect(state.periods.map((period) => period.endedAt)).toEqual([
      reset1 + 2 * MINUTE,
      reset1 + 6 * MINUTE,
    ]);
  });

  it("leaves a cursor undated when a whole window went unread since the history's last reset", () => {
    const state = emptyLedger();
    advanceLedger(state, {
      accountKey: "claude:max@example.com",
      driver: claude,
      checkedAt: reset2 + 2 * WEEK,
      windows: [{ ...weekly(4, reset2 + 3 * WEEK), id: "seven_day" }],
      resetCredits: null,
    });
    backfillLedger(state, history(series("seven_day", "weekly", twoResets)));
    expect([...state.cursors.values()][0]?.startedAt).toBeNull();
  });
});
