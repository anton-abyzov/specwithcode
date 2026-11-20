/**
 * The project coordinator's `clock` context section: its machine's name and
 * local date, time and timezone when the turn was sent. The name rides here,
 * not in the system prompt, so it stays right after a thread moves machines. System prompts are fixed
 * when a session starts, so the clock travels with each coordinator message
 * and wake instead; without it a coordinator answered "what time is it?" by
 * starting a worker. Workers read the time themselves.
 */
import { fenceLine } from "./promptFence.ts";

export const CURRENT_TIME_PREFIX = "Current local time on this machine:";

/**
 * The clock's opening words; `machine` is the label of the machine the agent runs on,
 * fenced because the owner names it and the line reaches the adapter as prompt text.
 */
export const currentTimePrefix = (machine: string | undefined) =>
  machine === undefined
    ? CURRENT_TIME_PREFIX
    : `Current local time on ${fenceLine(machine, 100)}, the machine this agent runs on:`;

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
export function currentTimeLine(
  epochMs: number,
  timeZone: string = machineTimeZone(),
  machine?: string,
): string {
  let zone = timeZone;
  let text: string;
  try {
    text = localText(epochMs, zone);
  } catch {
    zone = "UTC";
    text = localText(epochMs, zone);
  }
  // "Friday, November 13, 2026 at 12:41 PM EST": keep one comma-separated line.
  return `${currentTimePrefix(machine)} ${text.replace(" at ", ", ")} (${zone}, UTC${utcOffset(epochMs, zone)}).`;
}
