/**
 * The reset time Claude prints when a turn stops on a plan limit.
 *
 * The CLI's limit message carries the reset as text, for example
 * "You've hit your session limit · resets 5:20am (America/New_York)" or
 * "You've hit your weekly limit · resets Oct 17 at 9am (America/New_York)".
 * Older CLIs wrote "Claude AI usage limit reached|1760000000" (epoch seconds).
 * A stop whose `rate_limit_event` carried no `resetsAt` still gets a reset
 * time from this text, which is what lets the thread auto-continue at it.
 *
 * @module provider/claudeLimitReset
 */

import * as DateTime from "effect/DateTime";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A reset further off than this is not a plan window. */
const MAX_AHEAD_MS = 32 * 24 * 60 * 60 * 1000;

const LEGACY = /usage limit reached\|(\d{9,11})\b/i;
const RESETS =
  /\bresets\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i;

function validTimeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The wall-clock parts of `ms` in `zone` (the host zone when absent). */
function wallClock(ms: number, zone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? Number.NaN);
  return {
    year: part("year"),
    month: part("month") - 1,
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** Epoch ms of a wall-clock time in `zone`, correct across DST changes. */
function zonedEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string | undefined,
): number {
  const target = Date.UTC(year, month, day, hour, minute);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(guess, zone);
    const seenAsUtc = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    guess += target - seenAsUtc;
  }
  return guess;
}

/** ISO reset time from a Claude limit message, or null when it names none. */
export function parseClaudeLimitReset(text: string, nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  const accept = (ms: number) =>
    Number.isFinite(ms) && ms > nowMs && ms - nowMs <= MAX_AHEAD_MS
      ? DateTime.formatIso(DateTime.makeUnsafe(ms))
      : null;
  const legacy = LEGACY.exec(text);
  if (legacy) return accept(Number(legacy[1]) * 1000);
  const match = RESETS.exec(text);
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = match;
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem!.toLowerCase() === "p" ? 12 : 0);
  const zone = validTimeZone(zoneText?.trim());
  if (zoneText !== undefined && zone === undefined) return null;
  const today = wallClock(nowMs, zone);
  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) return null;
    // "Jan 2" read on Dec 30 is next year's.
    for (const year of [today.year, today.year + 1]) {
      if (DateTime.toPartsUtc(DateTime.makeUnsafe(Date.UTC(year, month, day))).month !== month + 1)
        return null;
      const ms = zonedEpoch(year, month, day, hour, minute, zone);
      const seen = wallClock(ms, zone);
      if (seen.hour !== hour || seen.minute !== minute) return null;
      if (ms > nowMs) return accept(ms);
    }
    return null;
  }
  // A bare clock time is its next occurrence: today, or tomorrow once it passed.
  for (const offset of [0, 1]) {
    const ms = zonedEpoch(today.year, today.month, today.day + offset, hour, minute, zone);
    if (ms > nowMs) return accept(ms);
  }
  return null;
}
