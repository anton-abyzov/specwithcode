import { describe, expect, it } from "vite-plus/test";

import { summarizeSignUps } from "./AdminSignUps.ts";
import { countByWeek, countInWindows, usageWeekStarts } from "./usageWindows.ts";

const at = (iso: string) => Date.parse(iso);
/** A Wednesday. */
const NOW = at("2026-11-11T12:00:00.000Z");

describe("the windows the usage numbers are counted in", () => {
  it("starts every week on a Monday in UTC, the running week last", () => {
    const starts = usageWeekStarts(NOW);
    expect(starts).toHaveLength(12);
    expect(starts[0]).toBe(at("2026-08-24T00:00:00.000Z"));
    expect(starts.at(-1)).toBe(at("2026-11-09T00:00:00.000Z"));
    // A Monday and a Sunday belong to the week they are in.
    expect(usageWeekStarts(at("2026-11-09T00:00:00.000Z")).at(-1)).toBe(
      at("2026-11-09T00:00:00.000Z"),
    );
    expect(usageWeekStarts(at("2026-11-15T23:59:59.999Z")).at(-1)).toBe(
      at("2026-11-09T00:00:00.000Z"),
    );
  });

  it("counts a moment in every window it falls in, and none after now", () => {
    expect(
      countInWindows(
        [
          at("2026-11-11T11:00:00.000Z"),
          at("2026-11-10T12:00:00.000Z"),
          at("2026-11-08T00:00:00.000Z"),
          at("2026-10-20T00:00:00.000Z"),
          at("2026-10-12T11:59:59.999Z"),
          at("2026-11-11T12:00:00.001Z"),
        ],
        NOW,
      ),
    ).toEqual({ day: 2, week: 3, month: 4 });
  });

  it("counts by week and leaves out what is older, later or not a time", () => {
    const weeks = countByWeek(
      [
        at("2026-08-23T23:59:59.999Z"),
        at("2026-08-24T00:00:00.000Z"),
        at("2026-11-08T23:59:59.999Z"),
        at("2026-11-09T00:00:00.000Z"),
        at("2026-11-11T12:00:00.000Z"),
        at("2026-11-12T00:00:00.000Z"),
        Number.NaN,
      ],
      NOW,
    );
    expect(weeks.map((week) => week.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    expect(weeks[0]?.weekStart).toBe("2026-08-24T00:00:00.000Z");
  });
});

describe("sign-ups counted from Clerk", () => {
  const person = (createdAt: string, lastActiveAt: string | null) => ({
    createdAt: at(createdAt),
    lastActiveAt: lastActiveAt === null ? null : at(lastActiveAt),
  });
  const people = [
    person("2026-11-11T09:00:00.000Z", "2026-11-11T10:00:00.000Z"),
    person("2026-11-06T00:00:00.000Z", "2026-11-07T00:00:00.000Z"),
    person("2026-10-20T00:00:00.000Z", null),
    person("2026-06-01T00:00:00.000Z", "2026-11-11T08:00:00.000Z"),
  ];
  const byActivity = [...people].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));

  it("counts new and active people per window, and new people per week", () => {
    const summary = summarizeSignUps({
      nowMs: NOW,
      total: 4,
      newest: people,
      lastActive: byActivity,
    });
    expect(summary).toMatchObject({
      total: 4,
      created: { day: 1, week: 2, month: 3 },
      active: { day: 2, week: 3, month: 3 },
      complete: true,
    });
    expect(summary.weekly.map((week) => week.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1]);
  });

  it("says so when a read stops inside the windows", () => {
    // Clerk knows 900 people; each read returned the first three of them.
    const partial = summarizeSignUps({
      nowMs: NOW,
      total: 900,
      newest: people.slice(0, 3),
      lastActive: byActivity.slice(0, 3),
    });
    expect(partial.complete).toBe(false);
    expect(partial.total).toBe(900);
  });

  it("is complete when both reads went back past the windows", () => {
    const summary = summarizeSignUps({
      nowMs: NOW,
      total: 900,
      newest: people,
      lastActive: [
        person("2026-01-01T00:00:00.000Z", "2026-11-11T08:00:00.000Z"),
        person("2026-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
      ],
    });
    expect(summary.complete).toBe(true);
    expect(summary.active).toEqual({ day: 1, week: 1, month: 1 });
  });

  it("is not complete when the activity read ends on people never seen active", () => {
    const summary = summarizeSignUps({
      nowMs: NOW,
      total: 900,
      newest: people,
      lastActive: [person("2026-01-01T00:00:00.000Z", null)],
    });
    expect(summary.complete).toBe(false);
  });
});
