import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { resolveTimestampLocale } from "../timestampFormat";

export type DisplayDateOptions = { locale?: string; timeZone?: string };
export type DisplayDateSegment =
  | { type: "text"; value: string }
  | { type: "date"; value: string; label: string };

const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/;
const zonedDate =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Display only. A calendar date has no timezone; an instant must have one. */
export function formatDisplayDate(
  value: string,
  timestampFormat: TimestampFormat = "locale",
  options: DisplayDateOptions = {},
): string | null {
  const match = calendarDate.exec(value) ?? zonedDate.exec(value);
  if (!match) return null;
  const dateOnly = match.length === 4;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    calendar.getUTCFullYear() !== Number(match[1]) ||
    calendar.getUTCMonth() !== Number(match[2]) - 1 ||
    calendar.getUTCDate() !== Number(match[3])
  )
    return null;
  const date = dateOnly ? calendar : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const hostLocale =
    typeof window === "undefined" ? undefined : window.desktopBridge?.getSystemLocale?.();
  const locale = resolveTimestampLocale(options.locale ?? hostLocale);
  const timeZone = dateOnly ? "UTC" : options.timeZone;
  const key = JSON.stringify([locale, timeZone, timestampFormat, dateOnly]);
  try {
    let formatter = formatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone,
        ...(dateOnly
          ? {}
          : {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
              ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
            }),
      });
      if (formatters.size >= 32) formatters.clear();
      formatters.set(key, formatter);
    }
    return formatter.format(date);
  } catch {
    // Invalid caller timezone must not crash or silently claim a different zone.
    return null;
  }
}

/**
 * Conservative prose recognition, never a global replacement of stored output.
 * Read whole date-like tokens so a partial/invalid timestamp cannot become a date.
 * Paths, URLs, identifiers and backtick literals remain byte-for-byte intact.
 */
export function getDisplayDateSegments(
  text: string,
  timestampFormat: TimestampFormat = "locale",
  options: DisplayDateOptions = {},
): DisplayDateSegment[] {
  const segments: DisplayDateSegment[] = [];
  const candidates = /(`+)[\s\S]*?\1|\d{4}-\d{2}-\d{2}(?:T[\d:.]*(?:Z|[+-][\d:]+)?)?/g;
  let cursor = 0;
  for (const match of text.matchAll(candidates)) {
    const value = match[0];
    if (value.startsWith("`")) continue;
    const start = match.index;
    const end = start + value.length;
    const before = text[start - 1];
    const after = text[end];
    if (before && !/[\s([{'"“‘–—]/.test(before)) continue;
    if (after && !/[\s)\]}'"”’.,;:!?–—]/.test(after)) continue;
    if (after === "." && /[\w]/.test(text[end + 1] ?? "")) continue;
    const label = formatDisplayDate(value, timestampFormat, options);
    if (!label) continue;
    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push({ type: "date", value, label });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}

export function formatDisplayDates(
  text: string,
  timestampFormat: TimestampFormat = "locale",
  options: DisplayDateOptions = {},
): string {
  return getDisplayDateSegments(text, timestampFormat, options)
    .map((segment) => (segment.type === "date" ? segment.label : segment.value))
    .join("");
}
