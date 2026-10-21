import type { ScheduledTaskBrief, ScheduledTaskSchedule } from "@specweave-studio/contracts";

/** A calendar date in the routine host's time zone. */
export interface RoutineRunDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (value: number) => String(value).padStart(2, "0");

/** The month before the run, which monthly bookkeeping usually covers. */
export function routinePeriod(date: RoutineRunDate): {
  readonly key: string;
  readonly label: string;
} {
  const year = date.month === 1 ? date.year - 1 : date.year;
  const month = date.month === 1 ? 12 : date.month - 1;
  return { key: `${year}-${pad(month)}`, label: `${MONTHS[month - 1]} ${year}` };
}

/** `{period}` is the previous month (2026-09) and `{date}` the run date (2026-10-01). */
export function routineOutputLocation(output: string, date: RoutineRunDate): string {
  return output
    .replaceAll("{period}", routinePeriod(date).key)
    .replaceAll("{date}", `${date.year}-${pad(date.month)}-${pad(date.day)}`);
}

/**
 * The lines every run of a routine with a brief opens with. The routine's own
 * prompt follows unchanged, after a separator line.
 */
export function routineBriefHeader(input: {
  readonly title: string;
  readonly brief: ScheduledTaskBrief;
  readonly date: RoutineRunDate;
}): string {
  const { brief, date } = input;
  const period = routinePeriod(date);
  const lines = [
    `Routine "${input.title}", run on ${MONTHS[date.month - 1]} ${date.day}, ${date.year}. Previous month: ${period.label} (${period.key}).`,
  ];
  if (brief.inputs.length > 0) {
    lines.push(
      "Work only from these inputs. Before anything else, check that each exists and is current, and give its newest date. If one is missing or stale, stop and list what is missing or stale and what you need from me:",
      ...brief.inputs.map((entry) => `- ${entry.label}: ${entry.location}`),
    );
  }
  if (brief.output !== null) {
    lines.push(
      `Write the result to ${routineOutputLocation(brief.output, date)}. If it already exists from an earlier run, update it in place instead of starting another.`,
    );
  }
  if (brief.prepareOnly) {
    lines.push(
      "Prepare and draft only. Do not file, pay, send, post, buy or change any account. End with the actions I must take myself.",
    );
  }
  return `${lines.join("\n")}\n---\n`;
}

const ordinal = (day: number) => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A routine's cadence in words, short enough for a phone row. */
export function routineCadenceLabel(schedule: ScheduledTaskSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "When you ask";
    case "monthly":
      return `Monthly on the ${ordinal(schedule.dayOfMonth)} at ${schedule.timeOfDay}`;
    case "webhook":
      return "On webhook";
    case "interval": {
      const minutes = schedule.everyMs / 60_000;
      return Number.isInteger(minutes)
        ? `Every ${minutes === 1 ? "minute" : `${minutes} min`}`
        : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
    }
    case "fixed_time": {
      const weekdays = schedule.weekdays ?? [];
      const days =
        weekdays.length === 0 || weekdays.length === 7
          ? "Daily"
          : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
            ? "Weekdays"
            : weekdays.map((day) => WEEKDAYS[day]).join(", ");
      return `${days} at ${schedule.timeOfDay}`;
    }
  }
}
