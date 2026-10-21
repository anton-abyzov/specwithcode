import { describe, expect, it } from "vite-plus/test";

import {
  routineCountsLabel,
  routineDestinationLabel,
  routineRunTimeLabel,
  routineState,
} from "./routinePresentation";

const daily = { type: "fixed_time" } as const;
const task = (overrides: Partial<Parameters<typeof routineState>[0]> = {}) => ({
  enabled: true,
  lastRunStatus: "never" as const,
  schedule: daily,
  ...overrides,
});

describe("routineState", () => {
  it("names each state in one word or two", () => {
    expect(routineState(task()).label).toBe("Active");
    expect(routineState(task({ enabled: false })).label).toBe("Paused");
    expect(routineState(task({ schedule: { type: "manual" } })).label).toBe("On request");
    expect(routineState(task({ schedule: { type: "webhook" } })).label).toBe("Listening");
    expect(routineState(task({ lastRunStatus: "running" })).label).toBe("Running");
    expect(routineState(task({ lastRunStatus: "failed" })).label).toBe("Last run failed");
  });
  it("keeps a paused routine paused even after a failed run", () => {
    expect(routineState(task({ enabled: false, lastRunStatus: "failed" })).tone).toBe("paused");
  });
  it("never calls a routine run by hand paused", () => {
    expect(routineState(task({ enabled: false, schedule: { type: "manual" } })).tone).toBe(
      "manual",
    );
  });
});

describe("routineRunTimeLabel", () => {
  const now = new Date("2026-10-21T04:00:00Z");
  const opts = { now, locale: "en-US", timeZone: "America/New_York" };
  it("says Today, Tomorrow and Yesterday with the time and zone", () => {
    expect(routineRunTimeLabel("2026-10-21T04:19:31Z", opts)).toBe("Today 12:19 AM EDT");
    expect(routineRunTimeLabel("2026-10-22T13:00:00Z", opts)).toBe("Tomorrow 9:00 AM EDT");
    expect(routineRunTimeLabel("2026-10-20T13:00:00Z", opts)).toBe("Yesterday 9:00 AM EDT");
  });
  it("uses a short weekday and month further out, with the year only when it differs", () => {
    expect(routineRunTimeLabel("2026-11-03T14:00:00Z", opts)).toBe("Tue, Nov 3, 9:00 AM EST");
    expect(routineRunTimeLabel("2027-01-05T14:00:00Z", opts)).toBe("Tue, Jan 5, 2027, 9:00 AM EST");
  });
  it("counts calendar days across daylight-saving changes", () => {
    // 11:30 PM EST on the eve of spring-forward: March 14 is tomorrow, March 15 is not.
    const eve = { ...opts, now: new Date("2027-03-14T04:30:00Z") };
    expect(routineRunTimeLabel("2027-03-14T13:00:00Z", eve)).toBe("Tomorrow 9:00 AM EDT");
    expect(routineRunTimeLabel("2027-03-15T13:00:00Z", eve)).toBe("Mon, Mar 15, 9:00 AM EDT");
    // 12:30 AM EDT on March 15: March 13 was two days ago.
    const after = { ...opts, now: new Date("2027-03-15T04:30:00Z") };
    expect(routineRunTimeLabel("2027-03-13T14:00:00Z", after)).toBe("Sat, Mar 13, 9:00 AM EST");
    // Fall-back day: the next day is still tomorrow.
    const fall = { ...opts, now: new Date("2026-11-01T04:30:00Z") };
    expect(routineRunTimeLabel("2026-11-02T14:00:00Z", fall)).toBe("Tomorrow 9:00 AM EST");
  });
  it("returns nothing for an unreadable date", () => {
    expect(routineRunTimeLabel("not a date", opts)).toBe("");
  });
});

describe("routineDestinationLabel", () => {
  it("names where runs land, except the coordinator", () => {
    expect(routineDestinationLabel({ threadId: null })).toBeNull();
    expect(routineDestinationLabel({ threadId: "t" as never })).toBe("Continues its thread");
    expect(routineDestinationLabel({ threadId: null, ownThread: true })).toBe(
      "Own thread from the first run",
    );
    expect(routineDestinationLabel({ threadId: "t" as never, ownThread: true })).toBe(
      "Its own thread",
    );
  });
});

describe("routineCountsLabel", () => {
  it("counts only the states present, in a fixed order", () => {
    expect(
      routineCountsLabel([
        task({ enabled: false }),
        task(),
        task({ schedule: { type: "manual" } }),
        task({ enabled: false }),
        task({ lastRunStatus: "failed" }),
      ]),
    ).toBe("2 active · 2 paused · 1 on request");
    expect(routineCountsLabel([task({ enabled: false })])).toBe("1 paused");
  });
});
