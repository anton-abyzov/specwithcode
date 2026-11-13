import { assert, it } from "@effect/vitest";
import { CURRENT_TIME_PREFIX, currentTimeLine } from "./currentTimeLine.ts";

const instant = Date.UTC(2026, 10, 13, 17, 41);

it("names the weekday, date, time, zone abbreviation, IANA zone and offset", () => {
  assert.equal(
    currentTimeLine(instant, "America/New_York"),
    `${CURRENT_TIME_PREFIX} Friday, November 13, 2026, 12:41 PM EST (America/New_York, UTC-05:00).`,
  );
});

it("follows daylight saving and half-hour zones", () => {
  assert.include(currentTimeLine(Date.UTC(2026, 6, 4, 16, 5), "America/New_York"), "12:05 PM EDT");
  assert.include(currentTimeLine(Date.UTC(2026, 6, 4, 16, 5), "America/New_York"), "UTC-04:00");
  assert.include(currentTimeLine(instant, "Asia/Kolkata"), "11:11 PM");
  assert.include(currentTimeLine(instant, "Asia/Kolkata"), "(Asia/Kolkata, UTC+05:30)");
});

it("writes UTC as +00:00 and falls back to UTC for an unknown zone", () => {
  assert.include(currentTimeLine(instant, "UTC"), "5:41 PM UTC (UTC, UTC+00:00)");
  assert.include(currentTimeLine(instant, "Not/AZone"), "(UTC, UTC+00:00)");
});
