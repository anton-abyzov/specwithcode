import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("one-time schedule time", () => {
  it("accepts ISO 8601 times with an offset or Z", () => {
    for (const at of [
      "2026-10-22T13:30:00Z",
      "2026-10-22T13:30:00.000Z",
      "2026-10-22T09:30:00-04:00",
      "2026-10-22T09:30+05:30",
    ]) {
      expect(decodeUpsertSchedule({ type: "once", at })).toEqual({ type: "once", at });
    }
  });

  it("refuses a naive local time and anything that is not a real date and time", () => {
    for (const at of [
      "2026-10-22T09:30:00",
      "2026-10-22 09:30:00Z",
      "2026-10-22",
      "Oct 22 2026 09:30 GMT",
      "1793000000000",
      "2026-02-30T09:30:00Z",
      "2026-10-22T24:00:00Z",
      "2026-10-22T09:30:00+25:00",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", at }), at).toThrow();
    }
  });

  it("keeps a stored time that predates the strict check readable", () => {
    expect(decodeSchedule({ type: "once", at: "2026-10-22T09:30:00" })).toEqual({
      type: "once",
      at: "2026-10-22T09:30:00",
    });
  });
});
