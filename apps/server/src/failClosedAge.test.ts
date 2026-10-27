import { describe, expect, it } from "vite-plus/test";

import { elapsedMs, newestFinite, olderThan } from "./failClosedAge.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

describe("olderThan", () => {
  it("is true only once the age is reached", () => {
    expect(olderThan(NOW - DAY, DAY, NOW)).toBe(true);
    expect(olderThan(NOW - DAY + 1, DAY, NOW)).toBe(false);
    expect(olderThan(NOW - 30 * DAY, DAY, NOW)).toBe(true);
  });

  it.each([
    ["NaN (unparsable text)", Date.parse("not a date")],
    ["an empty string parsed", Date.parse("")],
    ["-Infinity (max of nothing)", Math.max()],
    ["Infinity", Infinity],
    ["null (unreadable stat)", null],
    ["undefined", undefined],
  ])("never treats %s as old", (_label, at) => {
    expect(olderThan(at, DAY, NOW)).toBe(false);
    expect(olderThan(at, 0, NOW)).toBe(false);
  });

  it("never treats a future time as old", () => {
    expect(olderThan(NOW + DAY, 0, NOW)).toBe(false);
    expect(olderThan(NOW + 1, DAY, NOW)).toBe(false);
  });

  it("is false when now or the age itself is not finite", () => {
    expect(olderThan(NOW - DAY, DAY, Number.NaN)).toBe(false);
    expect(olderThan(NOW - DAY, Number.NaN, NOW)).toBe(false);
    expect(olderThan(NOW - DAY, -Infinity, NOW)).toBe(false);
  });

  it("treats a zero epoch as a known, old time", () => {
    // 0 is a real reading; callers must map unreadable values to null, not 0.
    expect(olderThan(0, DAY, NOW)).toBe(true);
  });
});

describe("elapsedMs", () => {
  it("returns the elapsed time or null", () => {
    expect(elapsedMs(NOW - 5, NOW)).toBe(5);
    expect(elapsedMs(NOW, NOW)).toBe(0);
    expect(elapsedMs(NOW + 5, NOW)).toBeNull();
    expect(elapsedMs(Number.NaN, NOW)).toBeNull();
    expect(elapsedMs(null, NOW)).toBeNull();
  });
});

describe("newestFinite", () => {
  it("skips unknown readings and returns null when none are known", () => {
    expect(newestFinite([])).toBeNull();
    expect(newestFinite([null, undefined, Number.NaN, -Infinity])).toBeNull();
    expect(newestFinite([3, null, 7, Number.NaN, 5])).toBe(7);
    expect(newestFinite([Infinity, 2])).toBe(2);
  });
});
