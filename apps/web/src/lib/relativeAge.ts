const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/**
 * "2 days ago", "5 minutes ago" in `locale` (the system's when omitted), counting
 * whole units down. Null under a minute, for the caller's own "just now".
 */
export function relativeAge(at: number, now: number, locale?: string): string | null {
  const elapsed = Math.max(0, now - at);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS)
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  return null;
}
