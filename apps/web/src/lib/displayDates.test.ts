import { describe, expect, it } from "vite-plus/test";
import { formatDisplayDate, formatDisplayDates, getDisplayDateSegments } from "./displayDates";

const ny = { locale: "en-US", timeZone: "America/New_York" };

describe("display dates", () => {
  it("renders the screenshot reset in the viewer's timezone, including the correct day", () => {
    expect(
      formatDisplayDates("Next observed reset: 2026-10-18T03:58:37.000Z.", "12-hour", ny),
    ).toBe("Next observed reset: Oct 17, 2026, 11:58:37 PM EDT.");
    expect(formatDisplayDate("2026-10-18T03:58:37.000Z", "24-hour", ny)).toBe(
      "Oct 17, 2026, 23:58:37 EDT",
    );
  });

  it("formats calendar dates before a heading colon", () => {
    expect(formatDisplayDates("2026-10-18: deadline", "locale", ny)).toBe("Oct 18, 2026: deadline");
  });

  it("formats natural date ranges without treating identifier hyphens as separators", () => {
    expect(formatDisplayDates("2026-10-13–2026-10-18", "locale", ny)).toBe(
      "Oct 13, 2026–Oct 18, 2026",
    );
    expect(formatDisplayDates("2026-10-13—2026-10-18", "locale", ny)).toBe(
      "Oct 13, 2026—Oct 18, 2026",
    );
    expect(formatDisplayDates("release-2026-10-18", "locale", ny)).toBe("release-2026-10-18");
  });

  it("retains calendar dates even west of UTC and supports leap days", () => {
    expect(formatDisplayDate("2024-02-29", "12-hour", ny)).toBe("Feb 29, 2024");
    expect(
      formatDisplayDate("2026-10-18", "24-hour", { locale: "en-GB", timeZone: "Pacific/Honolulu" }),
    ).toBe("18 Oct 2026");
  });

  it("distinguishes both occurrences of the repeated DST hour", () => {
    expect(formatDisplayDate("2026-11-01T05:30:00Z", "12-hour", ny)).toContain("1:30:00 AM EDT");
    expect(formatDisplayDate("2026-11-01T06:30:00Z", "12-hour", ny)).toContain("1:30:00 AM EST");
    expect(formatDisplayDate("2026-10-18T05:58:37+02:00", "12-hour", ny)).toBe(
      formatDisplayDate("2026-10-18T03:58:37Z", "12-hour", ny),
    );
  });

  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-02-30T12:00:00Z",
    "2026-10-18T24:01:00Z",
    "2026-10-18T12:60:00Z",
    "2026-10-18T12:00:60Z",
    "2026-10-18T12:00:00",
    "2026-10-18T12:00",
    "2026-10-18T",
    "2026-10-18T03:",
    "10/11/26",
    "1760000000",
    "Invalid Date",
  ])("does not invent a date or timezone for %s", (value) => {
    expect(formatDisplayDate(value, "locale", ny)).toBeNull();
    expect(formatDisplayDates(`When: ${value}.`, "locale", ny)).toBe(`When: ${value}.`);
  });

  it.each([
    "`2026-10-18`",
    "``2026-10-18T03:58:37Z``",
    '```json\n{"at":"2026-10-18"}\n```',
    "https://example.com/2026-10-18",
    "https://example.com?q=2026-10-18",
    "/reports/2026-10-18.md",
    "2026-10-18.json",
    "release-2026-10-18",
    "id_2026-10-18",
    "2026-10-18T03:58:37Z_suffix",
    "2026-10-18T03:58:37Z/file",
    "2026-10-18T03:58:37Z.json",
  ])("preserves machine/literal content %s", (text) => {
    expect(formatDisplayDates(text, "12-hour", ny)).toBe(text);
  });

  it("retains exact source in segments and only transforms safe prose", () => {
    const source = "Due (2026-10-18); retry 2026-10-18T03:58:37Z. See `2026-10-18`.";
    const parts = getDisplayDateSegments(source, "12-hour", ny);
    expect(parts.map((p) => p.value).join("")).toBe(source);
    expect(parts.filter((p) => p.type === "date")).toHaveLength(2);
    expect(formatDisplayDates("", "locale", ny)).toBe("");
    expect(formatDisplayDates("No dates here", "locale", ny)).toBe("No dates here");
  });

  it("handles unknown locale safely and refuses invalid timezone", () => {
    expect(formatDisplayDate("2026-10-18", "locale", { locale: "not_a_locale" })).toBeTruthy();
    expect(
      formatDisplayDate("2026-10-18T03:58:37Z", "locale", { timeZone: "Bad/Zone" }),
    ).toBeNull();
  });
});
