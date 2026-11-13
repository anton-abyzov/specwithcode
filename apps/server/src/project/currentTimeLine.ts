/**
 * The one line every project turn starts with: this machine's local date,
 * time and timezone when the turn was sent. System prompts are fixed when a
 * session starts, so the clock travels with each message instead; without it
 * a coordinator answered "what time is it?" by starting a worker.
 */
export const CURRENT_TIME_PREFIX = "Current local time on this machine:";

/** The machine's IANA zone, or UTC when the runtime cannot name one. */
export function machineTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "+05:30" style offset of `timeZone` at `epochMs`. */
function utcOffset(epochMs: number, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(epochMs)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = name.replace(/^GMT/, "");
  return offset === "" ? "+00:00" : offset;
}

function localText(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(epochMs);
}

/**
 * For example "Current local time on this machine: Friday, November 13, 2026,
 * 12:41 PM EST (America/New_York, UTC-05:00)."
 */
export function currentTimeLine(epochMs: number, timeZone: string = machineTimeZone()): string {
  let zone = timeZone;
  let text: string;
  try {
    text = localText(epochMs, zone);
  } catch {
    zone = "UTC";
    text = localText(epochMs, zone);
  }
  // "Friday, November 13, 2026 at 12:41 PM EST": keep one comma-separated line.
  return `${CURRENT_TIME_PREFIX} ${text.replace(" at ", ", ")} (${zone}, UTC${utcOffset(epochMs, zone)}).`;
}
