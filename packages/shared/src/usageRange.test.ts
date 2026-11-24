import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  USAGE_CUSTOM_RANGE_MAX_DAYS,
  customRangeProblem,
  formatUsageRange,
  rangeDayCount,
  restoreUsageRange,
  usageRangeIsPast,
  usageRangeWindow,
} from "./usageRange.ts";

describe("customRangeProblem", () => {
  const today = "2026-11-24";
  it("accepts a range ending today", () => {
    expect(customRangeProblem("2026-11-01", "2026-11-24", today)).toBeNull();
  });
  it("rejects an end after today", () => {
    expect(customRangeProblem("2026-11-01", "2026-11-25", today)).toBe("future");
  });
  it("rejects a start after the end", () => {
    expect(customRangeProblem("2026-11-10", "2026-11-09", today)).toBe("reversed");
  });
  it("allows exactly the cap and rejects one day more", () => {
    expect(rangeDayCount("2026-08-25", "2026-11-24")).toBe(USAGE_CUSTOM_RANGE_MAX_DAYS);
    expect(customRangeProblem("2026-08-25", "2026-11-24", today)).toBeNull();
    expect(customRangeProblem("2026-08-24", "2026-11-24", today)).toBe("tooLong");
  });
  it("rejects missing or impossible days", () => {
    expect(customRangeProblem("", "2026-11-01", today)).toBe("invalid");
    expect(customRangeProblem("2026-02-30", "2026-03-01", today)).toBe("invalid");
  });
});

describe("usageRangeWindow", () => {
  it("keeps a custom range's own days at day resolution", () => {
    expect(
      usageRangeWindow(
        { kind: "custom", sinceDay: "2026-11-01", untilDay: "2026-11-15" },
        DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-24T12:00:00Z")),
        "America/Los_Angeles",
      ),
    ).toEqual({
      sinceDay: "2026-11-01",
      untilDay: "2026-11-15",
      timeZone: "America/Los_Angeles",
      resolution: "day",
    });
  });
  it("asks hourly for Past 24h and daily for presets", () => {
    const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-24T12:00:00Z"));
    expect(usageRangeWindow({ kind: "preset", days: 1 }, now).resolution).toBe("hour");
    const week = usageRangeWindow({ kind: "preset", days: 7 }, now);
    expect(week.resolution).toBe("day");
    expect(rangeDayCount(week.sinceDay, week.untilDay)).toBe(7);
  });
});

describe("labels and restore", () => {
  it("labels a range in this year without the year", () => {
    expect(formatUsageRange("2026-11-01", "2026-11-15", "2026-11-24")).toBe("Nov 1 – Nov 15");
    expect(formatUsageRange("2025-12-20", "2026-01-05", "2026-11-24")).toBe("Dec 20, 2025 – Jan 5");
  });
  it("marks only custom ranges ending before today as past", () => {
    expect(
      usageRangeIsPast(
        { kind: "custom", sinceDay: "2026-11-01", untilDay: "2026-11-15" },
        "2026-11-24",
      ),
    ).toBe(true);
    expect(
      usageRangeIsPast(
        { kind: "custom", sinceDay: "2026-11-01", untilDay: "2026-11-24" },
        "2026-11-24",
      ),
    ).toBe(false);
    expect(usageRangeIsPast({ kind: "preset", days: 30 }, "2026-11-24")).toBe(false);
  });
  it("drops a saved custom range that no longer passes the rules", () => {
    expect(
      restoreUsageRange(
        { kind: "custom", sinceDay: "2026-11-01", untilDay: "2026-11-30" },
        "2026-11-24",
      ),
    ).toBeNull();
    expect(restoreUsageRange({ kind: "preset", days: 7 }, "2026-11-24")).toEqual({
      kind: "preset",
      days: 7,
    });
    expect(restoreUsageRange(undefined, "2026-11-24")).toBeNull();
  });
});
