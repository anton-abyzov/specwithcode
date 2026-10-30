/**
 * How a routine reads in a list: one state word, a short local date for its
 * next and last run, and where its runs land. Shared by the project's
 * Routines pane and Settings > Routines so both say the same thing.
 */
import type { ScheduledTask } from "@specweave-studio/contracts";

export type RoutineTone =
  | "active"
  | "paused"
  | "finished"
  | "manual"
  | "listening"
  | "running"
  | "failed";

/** The `.sws-dot` tone each state draws with; paused, finished and manual stay grey. */
const DOT_TONE: Record<RoutineTone, string | undefined> = {
  active: "resolved",
  listening: "resolved",
  running: "working",
  failed: "failed",
  paused: undefined,
  finished: undefined,
  manual: undefined,
};

type RoutineStateInput = Pick<ScheduledTask, "enabled" | "lastRunStatus"> &
  Partial<Pick<ScheduledTask, "lastRunAt">> & {
    readonly schedule: Pick<ScheduledTask["schedule"], "type">;
  };

export function routineState(task: RoutineStateInput): {
  readonly tone: RoutineTone;
  readonly label: string;
  readonly dotTone: string | undefined;
} {
  const manual = task.schedule.type === "manual";
  const tone: RoutineTone =
    task.lastRunStatus === "running"
      ? "running"
      : // A one-time routine turns itself off once it has run: done, not paused. One whose run
        // failed stays a failure: the server says to turn it back on to try again.
        task.schedule.type === "once" && !task.enabled && task.lastRunAt
        ? task.lastRunStatus === "failed"
          ? "failed"
          : "finished"
        : !manual && !task.enabled
          ? "paused"
          : task.lastRunStatus === "failed"
            ? "failed"
            : manual
              ? "manual"
              : task.schedule.type === "webhook"
                ? "listening"
                : "active";
  const label = {
    running: "Running",
    paused: "Paused",
    finished: "Finished",
    failed: "Last run failed",
    manual: "On request",
    listening: "Listening",
    active: "Active",
  }[tone];
  return { tone, label, dotTone: DOT_TONE[tone] };
}

/** Year, month and day of an instant in a time zone, for "Today" and "Tomorrow". */
function calendarDay(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * A run time in the reader's own zone, short enough for a phone row:
 * "Today 12:19 AM PDT", "Tomorrow 9:00 AM PDT", "Tue, Nov 3, 9:00 AM PST",
 * and the year only when it is not this year.
 */
export function routineRunTimeLabel(
  value: string,
  options: { readonly now?: Date; readonly locale?: string; readonly timeZone?: string } = {},
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = options.now ?? new Date();
  const { locale, timeZone } = options;
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  const day = calendarDay(date, timeZone);
  // Step calendar days, not 24-hour spans, so a daylight-saving change never skips a day.
  const today = calendarDay(now, timeZone);
  const offset = (days: number) => {
    const [year, month, dayOfMonth] = today.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, dayOfMonth! + days)).toISOString().slice(0, 10);
  };
  if (day === today) return `Today ${time}`;
  if (day === offset(1)) return `Tomorrow ${time}`;
  if (day === offset(-1)) return `Yesterday ${time}`;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const dayLabel = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
  return `${dayLabel}, ${time}`;
}

/**
 * Where a routine's runs land, in a few words. Every routine has a thread of
 * its own unless it continues a worker thread it was bound to; a host from
 * before own threads still sends a threadless routine to its coordinator.
 */
export function routineDestinationLabel(
  task: Pick<ScheduledTask, "threadId"> & { readonly ownThread?: boolean | undefined },
): string {
  // Not started yet: its first run starts it.
  if (task.ownThread) return task.threadId ? "Its own thread" : "Own thread";
  return task.threadId ? "Continues a worker's thread" : "Coordinator";
}

/** "1 active · 4 paused" for a list header; counts states that are present only. */
export function routineCountsLabel(tasks: readonly RoutineStateInput[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    // Counted by schedule, not by the last run: a failed run is still an active schedule.
    const key = task.schedule.type === "manual" ? "on request" : task.enabled ? "active" : "paused";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return ["active", "paused", "on request"]
    .flatMap((key) => (counts.has(key) ? [`${counts.get(key)} ${key}`] : []))
    .join(" · ");
}
