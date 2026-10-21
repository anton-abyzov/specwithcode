import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  isMissedFixedTimeRun,
  isSameSchedule,
  nextScheduledRunAt,
  parseTimeOfDay,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("parses 24-hour times", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("25:00")).toBeNull();
  });

  it("calculates interval schedules from the supplied instant", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 5 * 60_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:05:00.000Z");
  });

  it("clamps legacy sub-minute intervals to the one-minute execution floor", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:01:00.000Z");
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("skips fixed-time runs missed by more than the grace window", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const dueAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
    const withinGrace = DateTime.makeUnsafe("2026-07-01T09:05:00.000Z");
    const pastGrace = DateTime.makeUnsafe("2026-07-01T15:00:00.000Z");
    // A run only slightly late (poll jitter, short sleep) still fires.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, withinGrace)).toBe(false);
    // A run hours past its slot is skipped and rescheduled instead.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, pastGrace)).toBe(true);
    // Interval schedules always catch up with a single run, never skip.
    expect(isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, dueAt, pastGrace)).toBe(
      false,
    );
  });

  it("does not count time held for an update as missed", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const dueAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
    // The slot fell inside a 30 minute update hold that ended a minute ago: it runs once.
    const afterHold = DateTime.makeUnsafe("2026-07-01T09:25:00.000Z");
    expect(isMissedFixedTimeRun(fixedTime, dueAt, afterHold, 24 * 60_000)).toBe(false);
    // Lateness beyond the hold still counts.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, afterHold, 10 * 60_000)).toBe(true);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    // Weekday masks are sets: order and duplicates do not change firing.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    // Omitted, empty, and all-seven masks all mean daily.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it.each([
    ["9:00", "09:00"],
    ["09:00", "9:00"],
    ["0:30", "00:30"],
  ])("treats %s and %s as the same fixed-time schedule", (before, after) => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: before },
        { type: "fixed_time", timeOfDay: after },
      ),
    ).toBe(true);
  });

  const zoned = (day: number, month: number, hour: number) =>
    DateTime.makeZonedUnsafe(
      { year: 2026, month, day, hour, minute: 0, second: 0, millisecond: 0 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    );
  const parts = (value: DateTime.DateTime | null) => {
    if (value === null) return null;
    const { year, month, day, hour, minute } = DateTime.toParts(value);
    return { year, month, day, hour, minute };
  };

  it("never schedules a manual routine", () => {
    expect(nextScheduledRunAt({ type: "manual" }, zoned(1, 10, 8))).toBeNull();
    expect(isSameSchedule({ type: "manual" }, { type: "manual" })).toBe(true);
    expect(isSameSchedule({ type: "manual" }, { type: "fixed_time", timeOfDay: "09:00" })).toBe(
      false,
    );
  });

  it("runs a monthly routine on its day, later this month or next month", () => {
    const schedule = { type: "monthly", dayOfMonth: 1, timeOfDay: "09:00" } as const;
    // Before the slot on the day itself: today.
    expect(parts(nextScheduledRunAt(schedule, zoned(1, 10, 8)))).toEqual({
      year: 2026,
      month: 10,
      day: 1,
      hour: 9,
      minute: 0,
    });
    // After it: next month, across the year end too.
    expect(parts(nextScheduledRunAt(schedule, zoned(20, 10, 12)))?.month).toBe(11);
    expect(parts(nextScheduledRunAt(schedule, zoned(2, 12, 12)))).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    });
    // Day 28 exists in February.
    expect(
      parts(
        nextScheduledRunAt({ type: "monthly", dayOfMonth: 28, timeOfDay: "07:30" }, zoned(5, 2, 0)),
      ),
    ).toEqual({ year: 2026, month: 2, day: 28, hour: 7, minute: 30 });
  });

  it("treats a monthly run like a fixed-time one when it is missed or compared", () => {
    const schedule = { type: "monthly", dayOfMonth: 15, timeOfDay: "09:00" } as const;
    const due = zoned(15, 10, 9);
    expect(isMissedFixedTimeRun(schedule, due, DateTime.add(due, { minutes: 5 }))).toBe(false);
    expect(isMissedFixedTimeRun(schedule, due, DateTime.add(due, { hours: 3 }))).toBe(true);
    expect(isSameSchedule(schedule, { ...schedule, timeOfDay: "9:00" })).toBe(true);
    expect(isSameSchedule(schedule, { ...schedule, dayOfMonth: 14 })).toBe(false);
  });
});
