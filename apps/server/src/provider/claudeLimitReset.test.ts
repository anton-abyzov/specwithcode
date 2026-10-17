import { describe, expect, it } from "vite-plus/test";

import { parseClaudeLimitReset } from "./claudeLimitReset.ts";

// Friday, October 16, 2026, 1:00 PM in New York (EDT, UTC-4).
const now = Date.parse("2026-10-16T17:00:00.000Z");

describe("parseClaudeLimitReset", () => {
  it.each([
    [
      "You've hit your session limit · resets 5:20pm (America/New_York)",
      "2026-10-16T21:20:00.000Z",
    ],
    // A clock time already past today is tomorrow's.
    [
      "You've hit your session limit · resets 5:20am (America/New_York)",
      "2026-10-17T09:20:00.000Z",
    ],
    ["You've hit your session limit · resets 11pm (America/New_York)", "2026-10-17T03:00:00.000Z"],
    [
      "You've hit your weekly limit · resets Oct 17 at 9am (America/New_York) · progress saved",
      "2026-10-17T13:00:00.000Z",
    ],
    [
      "You've hit your weekly limit · resets Oct 20, 10pm (Europe/Berlin)",
      "2026-10-20T20:00:00.000Z",
    ],
    ["5-hour limit reached ∙ resets 3pm (UTC)", "2026-10-17T15:00:00.000Z"],
    ["Claude AI usage limit reached|1792252800", "2026-10-17T16:00:00.000Z"],
  ])("reads %s", (text, expected) => {
    expect(parseClaudeLimitReset(text, now)).toBe(expected);
  });

  it("crosses into next year for an early-January reset read in December", () => {
    expect(
      parseClaudeLimitReset(
        "You've hit your weekly limit · resets Jan 2 at 9am (UTC)",
        Date.parse("2026-12-30T12:00:00.000Z"),
      ),
    ).toBe("2027-01-02T09:00:00.000Z");
  });

  it("keeps the wall-clock time across a daylight-saving change", () => {
    // New York leaves EDT on November 1, 2026; 9am EST is 14:00 UTC.
    expect(
      parseClaudeLimitReset(
        "You've hit your weekly limit · resets Nov 3 at 9am (America/New_York)",
        now,
      ),
    ).toBe("2026-11-03T14:00:00.000Z");
  });

  it.each([
    "Claude usage limit reached. Send the message again once the limit resets.",
    "API Error: 529 overloaded",
    "resets 13pm (UTC)",
    "resets 3pm (Mars/Olympus)",
    "resets Oct 32 at 9am (UTC)",
    "resets Feb 30 at 9am (UTC)",
    // Past, and implausibly far off.
    "Claude AI usage limit reached|1700000000",
    "Claude AI usage limit reached|1999999999",
  ])("returns null for %s", (text) => {
    expect(parseClaudeLimitReset(text, now)).toBeNull();
  });
});
