// @effect-diagnostics globalDate:off -- A datetime-local input is wall-clock time in this device's zone; only Date reads that zone's offset.
/**
 * Date and time values for an MCP server's form (1493).
 *
 * MCP servers check a `date-time` answer as RFC 3339 (the MCP SDK runs
 * ajv-formats' full `date-time`): seconds and a zone are required, and the
 * date and time must exist. A browser's `datetime-local` input gives neither
 * seconds nor a zone, so the card turns the person's local time into RFC 3339
 * with their offset before sending, and shows a server's default in local time.
 */

import type { McpElicitationField } from "./mcpElicitationForm.ts";

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

function daysIn(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function realDateAndTime(parts: ReadonlyArray<number>): boolean {
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/** A date and time an MCP server accepts: RFC 3339 with seconds and a zone. */
export function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339.exec(value);
  if (match === null) return false;
  if (!realDateAndTime(match.slice(1, 7).map(Number))) return false;
  if (match[9] === undefined) return true;
  return Number(match[10]) <= 23 && Number(match[11]) <= 59;
}

const pad = (value: number, size = 2) => String(Math.trunc(Math.abs(value))).padStart(size, "0");

/**
 * A `datetime-local` value (`2026-11-25T10:00`), read as the person's local
 * time, as RFC 3339 with their offset (`2026-11-25T10:00:00-08:00`). A value
 * that already has a zone is returned unchanged; anything else is undefined.
 * `offsetMinutes` is for tests; it defaults to the local offset at that time.
 */
export function localInputToRfc3339(local: string, offsetMinutes?: number): string | undefined {
  const value = local.trim();
  if (isRfc3339DateTime(value)) return value;
  const match = LOCAL_INPUT.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (!realDateAndTime([year, month, day, hour, minute, second])) return undefined;
  // getTimezoneOffset is minutes behind UTC; RFC 3339 writes minutes ahead.
  const ahead =
    offsetMinutes ?? -new Date(year, month - 1, day, hour, minute, second).getTimezoneOffset();
  const zone = `${ahead < 0 ? "-" : "+"}${pad(ahead / 60)}:${pad(ahead % 60)}`;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${pad(second)}${match[7] ?? ""}${zone}`;
}

/**
 * An RFC 3339 value as the same instant in local time, the way a
 * `datetime-local` input shows it (`2026-12-01T01:00`, seconds only when not
 * zero); undefined when the value isn't a date and time the card can show.
 */
export function rfc3339ToLocalInput(value: string): string | undefined {
  if (!isRfc3339DateTime(value)) return undefined;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  const date = `${pad(instant.getFullYear(), 4)}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
  const time = `${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
  const seconds = instant.getSeconds();
  return `${date}T${time}${seconds === 0 ? "" : `:${pad(seconds)}`}`;
}

const isDateTimeField = (field: McpElicitationField) =>
  field.kind === "text" && field.format === "date-time";

/**
 * The card's starting values with each date-time default in local time. A
 * default the card can't show is left out, so nothing unseen is sent.
 */
export function mcpElicitationCardValues(
  fields: ReadonlyArray<McpElicitationField>,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const shown: Record<string, unknown> = { ...values };
  for (const field of fields) {
    if (!isDateTimeField(field)) continue;
    const value = shown[field.key];
    if (typeof value === "string") shown[field.key] = rfc3339ToLocalInput(value);
  }
  return shown;
}

/**
 * The card's values with each date-time entry as RFC 3339 in the person's
 * offset, ready to check and send. An entry that isn't a date and time is left
 * as typed, so the check reports it.
 */
export function mcpElicitationSentValues(
  fields: ReadonlyArray<McpElicitationField>,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sent: Record<string, unknown> = { ...values };
  for (const field of fields) {
    if (!isDateTimeField(field)) continue;
    const value = sent[field.key];
    if (typeof value === "string" && value.trim() !== "")
      sent[field.key] = localInputToRfc3339(value) ?? value;
  }
  return sent;
}
