import { describe, expect, it } from "vite-plus/test";

import type { LimitHistorySample } from "./usageLimitForecast.ts";
import {
  closedReset,
  isLedgerWindow,
  ledgerWindowLengthMs,
  lossIsUpperBound,
  mergeResetPeriods,
  resetPeriods,
} from "./usageResetLedger.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const t0 = Date.parse("2026-11-02T12:00:00.000Z");
const reset1 = t0 + 2 * DAY;
const reset2 = reset1 + WEEK;

const read = (at: number, usedPercent: number, resetsAt: number | null): LimitHistorySample => ({
  at,
  usedPercent,
  resetsAt,
});

describe("closedReset", () => {
  it("closes a period at the scheduled reset with what was unused", () => {
    const closed = closedReset(
      read(reset1 - 30 * MINUTE, 59, reset1),
      read(reset1 + 20 * MINUTE, 1, reset2),
      WEEK,
    );
    expect(closed).toEqual({
      endedAt: reset1,
      lastReadAt: reset1 - 30 * MINUTE,
      usedPercentAtReset: 59,
      lostPercent: 41,
      cause: "scheduled",
    });
  });

  it("names a reset that came days before its announced time early", () => {
    const at = reset1 - 2 * DAY;
    const closed = closedReset(read(at - HOUR, 80, reset1), read(at, 0, at + WEEK), WEEK);
    expect(closed?.cause).toBe("early");
    expect(closed?.endedAt).toBe(at);
    expect(closed?.lostPercent).toBe(20);
  });

  it("names an early reset redeemed when a banked reset was spent between the reads", () => {
    const at = reset1 - 2 * DAY;
    const closed = closedReset(read(at - HOUR, 100, reset1), read(at, 0, at + WEEK), WEEK, true);
    expect(closed?.cause).toBe("redeemed");
    expect(closed?.lostPercent).toBe(0);
  });

  it("does not call a scheduled reset redeemed", () => {
    const closed = closedReset(
      read(reset1 - HOUR, 70, reset1),
      read(reset1 + HOUR, 2, reset2),
      WEEK,
      true,
    );
    expect(closed?.cause).toBe("scheduled");
  });

  it("closes nothing while the window keeps running", () => {
    expect(closedReset(read(t0, 20, reset1), read(t0 + HOUR, 26, reset1), WEEK)).toBeNull();
  });

  it("closes nothing when usage ages out of a rolling window", () => {
    // The reset time slides with the clock and the level falls a little.
    expect(
      closedReset(read(t0, 40, t0 + 5 * HOUR), read(t0 + HOUR, 31, t0 + 6 * HOUR), 5 * HOUR),
    ).toBeNull();
  });

  it("closes nothing from a read restamped after its own reset time", () => {
    const stale = read(reset1 + 3 * HOUR, 59, reset1);
    expect(closedReset(read(reset1 - HOUR, 59, reset1), stale, WEEK)).toBeNull();
    expect(closedReset(stale, read(reset1 + 4 * HOUR, 3, reset2), WEEK)).toBeNull();
  });

  it("closes nothing when a whole window passed unread", () => {
    expect(
      closedReset(read(t0, 100, null), read(t0 + WEEK + DAY, 100, null), WEEK),
    ).toBeNull();
    expect(
      closedReset(read(t0, 30, reset1), read(t0 + 2 * WEEK, 10, reset1 + 2 * WEEK), WEEK),
    ).toBeNull();
  });
});

describe("resetPeriods", () => {
  it("gives no period for an account first seen at its limit", () => {
    expect(resetPeriods("codex:a@x.dev", "weekly", [read(t0, 100, null)], WEEK)).toEqual([]);
    expect(
      resetPeriods(
        "codex:a@x.dev",
        "weekly",
        [read(t0, 100, null), read(t0 + 8 * DAY, 100, null)],
        WEEK,
      ),
    ).toEqual([]);
  });

  it("chains periods, the first without a start", () => {
    const periods = resetPeriods(
      "codex:a@x.dev",
      "weekly",
      [
        read(t0, 30, reset1),
        read(reset1 - HOUR, 59, reset1),
        read(reset1 + HOUR, 2, reset2),
        read(reset2 - 20 * MINUTE, 96, reset2),
        read(reset2 + 10 * MINUTE, 0, reset2 + WEEK),
      ],
      WEEK,
    );
    expect(periods.map((period) => [period.startedAt, period.endedAt, period.lostPercent])).toEqual(
      [
        [null, reset1, 41],
        [reset1, reset2, 4],
      ],
    );
  });

  it("starts the next period unknown after an unread window", () => {
    const periods = resetPeriods(
      "codex:a@x.dev",
      "weekly",
      [
        read(t0, 30, reset1),
        read(t0 + 2 * WEEK, 10, reset1 + 2 * WEEK),
        read(reset1 + 2 * WEEK - HOUR, 50, reset1 + 2 * WEEK),
        read(reset1 + 2 * WEEK + HOUR, 1, reset1 + 3 * WEEK),
      ],
      WEEK,
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]?.startedAt).toBeNull();
    expect(periods[0]?.lostPercent).toBe(50);
  });
});

describe("mergeResetPeriods", () => {
  const period = (endedAt: number, lastReadAt: number, used: number, startedAt: number | null) => ({
    accountKey: "codex:a@x.dev",
    windowId: "weekly",
    startedAt,
    endedAt,
    lastReadAt,
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled" as const,
  });

  it("keeps one period per reset, from the machine that read last", () => {
    const merged = mergeResetPeriods([
      [period(reset1, reset1 - 5 * HOUR, 40, null)],
      [period(reset1 + 10 * MINUTE, reset1 - 20 * MINUTE, 59, reset1 - WEEK)],
      [period(reset2, reset2 - HOUR, 90, reset1)],
    ]);
    expect(merged.map((entry) => [entry.usedPercentAtReset, entry.startedAt])).toEqual([
      [59, reset1 - WEEK],
      [90, reset1],
    ]);
  });

  it("keeps two resets hours apart that one machine saw in a row", () => {
    const early = { ...period(t0 + 9 * HOUR, t0 + 8 * HOUR, 80, null), cause: "early" as const };
    const redeemed = {
      ...period(t0 + 13 * HOUR, t0 + 12.5 * HOUR, 100, t0 + 9 * HOUR),
      cause: "redeemed" as const,
    };
    const third = period(t0 + 18 * HOUR, t0 + 17 * HOUR, 30, t0 + 13 * HOUR);
    expect(mergeResetPeriods([[early, redeemed, third]]).map((entry) => entry.cause)).toEqual([
      "early",
      "redeemed",
      "scheduled",
    ]);
  });

  it("keeps one of two machines' identical records read at the reset itself", () => {
    const merged = mergeResetPeriods([
      [period(reset1, reset1, 90, null)],
      [period(reset1, reset1, 90, null)],
      [period(reset2, reset2 - HOUR, 70, reset1)],
    ]);
    expect(merged.map((entry) => entry.endedAt)).toEqual([reset1, reset2]);
  });

  it("treats a reset recorded at a late read and at its announced time as one", () => {
    const merged = mergeResetPeriods([
      [period(reset1, reset1 - 10 * MINUTE, 90, null)],
      [period(reset1 + 2 * MINUTE, reset1 + 2 * MINUTE, 90, null)],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.lastReadAt).toBe(reset1 + 2 * MINUTE);
  });

  it("keeps two early resets ten minutes apart, each after its own read", () => {
    const first = { ...period(t0 + 9 * HOUR, t0 + 8 * HOUR, 80, null), cause: "early" as const };
    const second = {
      ...period(t0 + 9 * HOUR + 10 * MINUTE, t0 + 9 * HOUR + 5 * MINUTE, 20, t0 + 9 * HOUR),
      cause: "early" as const,
    };
    expect(mergeResetPeriods([[first], [second]])).toHaveLength(2);
    expect(mergeResetPeriods([[first, second]])).toHaveLength(2);
  });

  it("keeps an early reset minutes after a reset closed at a late read", () => {
    const late = period(reset1 + 2 * MINUTE, reset1 + 2 * MINUTE, 90, null);
    const early = {
      ...period(reset1 + 12 * MINUTE, reset1 + 7 * MINUTE, 3, reset1 + 2 * MINUTE),
      cause: "early" as const,
    };
    expect(mergeResetPeriods([[late], [early]])).toHaveLength(2);
    expect(mergeResetPeriods([[late, early]])).toHaveLength(2);
  });

  it("treats two machines' records of one reset with differently rounded times as one", () => {
    const late = period(reset1 + MINUTE, reset1 + MINUTE, 90, null);
    const rounded = period(reset1 + 3 * MINUTE, reset1 + 2 * MINUTE, 91, null);
    expect(mergeResetPeriods([[late], [rounded]])).toHaveLength(1);
    expect(mergeResetPeriods([[rounded], [late]])).toHaveLength(1);
  });

  it("treats three machines' records of one reset, none read at the reset, as one", () => {
    const a = period(reset1 + MINUTE, reset1 + MINUTE, 90, null);
    const b = period(reset1 + 3 * MINUTE, reset1 + 2 * MINUTE, 90, null);
    const c = period(reset1 + 4 * MINUTE, reset1 + 3.5 * MINUTE, 91, null);
    expect(mergeResetPeriods([[b], [c]])).toHaveLength(1);
    expect(mergeResetPeriods([[a], [b], [c]])).toHaveLength(1);
    expect(mergeResetPeriods([[c], [a], [b]])).toHaveLength(1);
  });

  it("keeps an early reset four minutes after a scheduled one that one machine saw", () => {
    const periods = resetPeriods(
      "codex:a@x.dev",
      "weekly",
      [
        read(reset1 - 10 * MINUTE, 90, reset1),
        read(reset1 + 2 * MINUTE, 90, reset1),
        read(reset1 + 3 * MINUTE, 1, reset2),
        read(reset1 + 4 * MINUTE, 30, reset2),
        read(reset1 + 6 * MINUTE, 1, reset2 + DAY),
      ],
      WEEK,
    );
    expect(periods.map((entry) => entry.cause)).toEqual(["scheduled", "early"]);
    expect(mergeResetPeriods([periods])).toHaveLength(2);
    expect(mergeResetPeriods([[periods[0]!], [periods[1]!]])).toHaveLength(2);
  });

  it("keeps different accounts and windows apart", () => {
    const other = { ...period(reset1, reset1 - HOUR, 10, null), windowId: "seven_day_opus" };
    expect(mergeResetPeriods([[period(reset1, reset1 - HOUR, 59, null)], [other]])).toHaveLength(2);
  });
});

describe("ledger helpers", () => {
  it("keeps weekly, monthly and day-long windows, never the session window", () => {
    expect(isLedgerWindow("weekly", undefined)).toBe(true);
    expect(isLedgerWindow("monthly", undefined)).toBe(true);
    expect(isLedgerWindow("session", 300)).toBe(false);
    expect(isLedgerWindow("other", 24 * 60)).toBe(true);
    expect(isLedgerWindow("other", 300)).toBe(false);
    expect(isLedgerWindow("other", undefined)).toBe(false);
  });

  it("gives a weekly or monthly window without a reported length the shortest one", () => {
    expect(ledgerWindowLengthMs("weekly", undefined)).toBe(WEEK);
    expect(ledgerWindowLengthMs("monthly", undefined)).toBe(28 * DAY);
    expect(ledgerWindowLengthMs("monthly", 30 * 24 * 60)).toBe(30 * DAY);
    expect(ledgerWindowLengthMs("other", undefined)).toBeNull();
    // Three monthly resets passed unread: no period is invented from the two reads.
    const length = ledgerWindowLengthMs("monthly", undefined);
    expect(closedReset(read(t0, 80, null), read(t0 + 105 * DAY, 20, null), length)).toBeNull();
  });

  it("marks a loss read long before the reset as an upper bound", () => {
    expect(lossIsUpperBound({ endedAt: reset1, lastReadAt: reset1 - HOUR })).toBe(false);
    expect(lossIsUpperBound({ endedAt: reset1, lastReadAt: reset1 - 9 * HOUR })).toBe(true);
  });
});
