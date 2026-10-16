import * as DateTime from "effect/DateTime";

const VIEWER_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const VIEWER_DATE_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** A viewer header's date: "Oct 15", with the year once it is not this year's. */
export function formatViewerDate(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (date.getFullYear() === now.getFullYear() ? VIEWER_DATE : VIEWER_DATE_WITH_YEAR).format(
    date,
  );
}

/** A timestamp as ISO text, whether it is already text or a `DateTime`. */
export function viewerIso(value: string | DateTime.DateTime | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return DateTime.isDateTime(value) ? DateTime.formatIso(value) : null;
}
