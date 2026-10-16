// @effect-diagnostics globalDate:off - history days are host-local calendar dates in pure helpers.
/**
 * The Status page's local history: per-day check counts for each service and
 * the incidents this host opened itself. Kept in one small JSON file under the
 * state directory and pruned to the history window.
 */
import {
  STATUS_HISTORY_DAYS,
  STATUS_LEVELS,
  rollupStatusLevels,
  type StatusDay,
  type StatusIncident,
  type StatusLevel,
} from "@specweave-studio/contracts";

const MAX_DAY_NOTES = 4;
const MAX_LOCAL_INCIDENTS = 200;
/** Consecutive checks needed to open or resolve a local incident. */
export const INCIDENT_CONFIRMATIONS = 2;

export interface StatusDayEntry {
  readonly counts: Partial<Record<StatusLevel, number>>;
  readonly notes: ReadonlyArray<string>;
}

export interface StatusStreak {
  readonly level: StatusLevel;
  readonly count: number;
}

export interface StatusHistory {
  readonly version: 1;
  /** `YYYY-MM-DD` (host local time) -> service id -> counts. */
  readonly days: Readonly<Record<string, Readonly<Record<string, StatusDayEntry>>>>;
  readonly incidents: ReadonlyArray<StatusIncident>;
  readonly streaks: Readonly<Record<string, StatusStreak>>;
  /** The last check this host finished; bounds when an unexpected stop happened. */
  readonly lastAliveAt: number | null;
}

export const emptyStatusHistory = (): StatusHistory => ({
  version: 1,
  days: {},
  incidents: [],
  streaks: {},
  lastAliveAt: null,
});

export interface StatusSample {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly level: StatusLevel;
  /** Recorded as a day note when the service is not operational. */
  readonly note: string | null;
  /** Opens and resolves local incidents from this service's checks. */
  readonly tracksIncidents: boolean;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The history window's days, oldest first, ending today. */
export function historyDates(now: number, days = STATUS_HISTORY_DAYS): Array<string> {
  const today = new Date(now);
  return Array.from({ length: days }, (_, index) =>
    localDate(
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - (days - 1 - index),
        12,
      ).getTime(),
    ),
  );
}

const isStatusLevel = (value: unknown): value is StatusLevel =>
  typeof value === "string" && (STATUS_LEVELS as ReadonlyArray<string>).includes(value);

/** Accepts a stored file, dropping anything malformed instead of failing. */
export function decodeStatusHistory(raw: unknown): StatusHistory {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) {
    return emptyStatusHistory();
  }
  const input = raw as Record<string, unknown>;
  const days: Record<string, Record<string, StatusDayEntry>> = {};
  if (typeof input.days === "object" && input.days !== null) {
    for (const [date, services] of Object.entries(input.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || typeof services !== "object" || services === null)
        continue;
      const day: Record<string, StatusDayEntry> = {};
      for (const [serviceId, entry] of Object.entries(services)) {
        if (typeof entry !== "object" || entry === null) continue;
        const counts: Partial<Record<StatusLevel, number>> = {};
        const rawCounts = (entry as { counts?: unknown }).counts;
        if (typeof rawCounts === "object" && rawCounts !== null) {
          for (const [level, count] of Object.entries(rawCounts)) {
            if (isStatusLevel(level) && Number.isSafeInteger(count) && (count as number) > 0) {
              counts[level] = count as number;
            }
          }
        }
        const rawNotes = (entry as { notes?: unknown }).notes;
        const notes = Array.isArray(rawNotes)
          ? rawNotes
              .filter((note): note is string => typeof note === "string")
              .slice(0, MAX_DAY_NOTES)
          : [];
        day[serviceId] = { counts, notes };
      }
      days[date] = day;
    }
  }
  const incidents = Array.isArray(input.incidents)
    ? (input.incidents as Array<StatusIncident>).filter(
        (incident) =>
          typeof incident === "object" &&
          incident !== null &&
          typeof incident.id === "string" &&
          typeof incident.serviceId === "string" &&
          typeof incident.title === "string" &&
          typeof incident.startedAt === "string" &&
          isStatusLevel(incident.level),
      )
    : [];
  const streaks: Record<string, StatusStreak> = {};
  if (typeof input.streaks === "object" && input.streaks !== null) {
    for (const [serviceId, streak] of Object.entries(input.streaks)) {
      const value = streak as Partial<StatusStreak>;
      if (isStatusLevel(value?.level) && Number.isSafeInteger(value.count)) {
        streaks[serviceId] = { level: value.level, count: value.count! };
      }
    }
  }
  const lastAliveAt = Number.isSafeInteger(input.lastAliveAt)
    ? (input.lastAliveAt as number)
    : null;
  return { version: 1, days, incidents, streaks, lastAliveAt };
}

const healthy = (level: StatusLevel) => level === "operational" || level === "maintenance";

/** Folds one round of checks into the history, opening or resolving local incidents. */
export function recordStatusChecks(
  history: StatusHistory,
  samples: ReadonlyArray<StatusSample>,
  now: number,
): StatusHistory {
  const date = localDate(now);
  const at = new Date(now).toISOString();
  const today: Record<string, StatusDayEntry> = { ...history.days[date] };
  const streaks: Record<string, StatusStreak> = { ...history.streaks };
  const incidents = [...history.incidents];

  for (const sample of samples) {
    const entry = today[sample.serviceId] ?? { counts: {}, notes: [] };
    const counts = { ...entry.counts, [sample.level]: (entry.counts[sample.level] ?? 0) + 1 };
    const notes =
      sample.note !== null &&
      !healthy(sample.level) &&
      sample.level !== "unknown" &&
      !entry.notes.includes(sample.note) &&
      entry.notes.length < MAX_DAY_NOTES
        ? [...entry.notes, sample.note]
        : entry.notes;
    today[sample.serviceId] = { counts, notes };

    if (!sample.tracksIncidents || sample.level === "unknown") continue;
    const previous = streaks[sample.serviceId];
    const sameSide = previous !== undefined && healthy(previous.level) === healthy(sample.level);
    const streak = { level: sample.level, count: sameSide ? previous.count + 1 : 1 };
    streaks[sample.serviceId] = streak;

    const openIndex = incidents.findIndex(
      (incident) =>
        incident.origin === "local" &&
        incident.serviceId === sample.serviceId &&
        incident.resolvedAt === null,
    );
    if (healthy(sample.level)) {
      if (openIndex >= 0 && streak.count >= INCIDENT_CONFIRMATIONS) {
        incidents[openIndex] = {
          ...incidents[openIndex]!,
          stage: "resolved",
          updatedAt: at,
          resolvedAt: at,
        };
      } else if (openIndex >= 0 && incidents[openIndex]!.stage !== "monitoring") {
        incidents[openIndex] = { ...incidents[openIndex]!, stage: "monitoring", updatedAt: at };
      }
    } else if (openIndex >= 0) {
      const open = incidents[openIndex]!;
      incidents[openIndex] = {
        ...open,
        level: rollupStatusLevels([open.level, sample.level]),
        stage: "identified",
        updatedAt: at,
      };
    } else if (streak.count >= INCIDENT_CONFIRMATIONS) {
      incidents.push({
        id: `local:${sample.serviceId}:${now}`,
        serviceId: sample.serviceId,
        title: sample.note ?? `${sample.serviceName} is not operational`,
        level: sample.level,
        stage: "investigating",
        origin: "local",
        startedAt: at,
        updatedAt: at,
        resolvedAt: null,
        url: null,
      });
    }
  }

  return pruneStatusHistory(
    {
      version: 1,
      days: { ...history.days, [date]: today },
      incidents: incidents.slice(-MAX_LOCAL_INCIDENTS),
      streaks,
      lastAliveAt: now,
    },
    now,
  );
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

/**
 * Records that the previous run of the local service ended without shutting
 * down (a crash or a kill), as a resolved incident from its last finished
 * check, or its start when it never finished one, to this run's start.
 */
export function recordUnexpectedStop(
  history: StatusHistory,
  stop: { readonly previousStartedAt: number; readonly restartedAt: number },
): StatusHistory {
  const lastAlive =
    history.lastAliveAt !== null &&
    history.lastAliveAt >= stop.previousStartedAt &&
    history.lastAliveAt <= stop.restartedAt
      ? history.lastAliveAt
      : stop.previousStartedAt;
  const id = `local:local-service:stopped:${stop.previousStartedAt}`;
  if (history.incidents.some((incident) => incident.id === id)) return history;
  const note = `Stopped unexpectedly; restarted at ${clock(stop.restartedAt)}`;
  const date = localDate(stop.restartedAt);
  const today = { ...history.days[date] };
  const entry = today["local-service"] ?? { counts: {}, notes: [] };
  today["local-service"] = {
    counts: { ...entry.counts, major_outage: (entry.counts.major_outage ?? 0) + 1 },
    notes: entry.notes.length < MAX_DAY_NOTES ? [...entry.notes, note] : entry.notes,
  };
  return pruneStatusHistory(
    {
      ...history,
      days: { ...history.days, [date]: today },
      incidents: [
        ...history.incidents,
        {
          id,
          serviceId: "local-service",
          title: "Local service stopped unexpectedly",
          level: "major_outage",
          stage: "resolved",
          origin: "local",
          startedAt: new Date(lastAlive).toISOString(),
          updatedAt: new Date(stop.restartedAt).toISOString(),
          resolvedAt: new Date(stop.restartedAt).toISOString(),
          url: null,
        } satisfies StatusIncident,
      ].slice(-MAX_LOCAL_INCIDENTS),
    },
    stop.restartedAt,
  );
}

export function pruneStatusHistory(history: StatusHistory, now: number): StatusHistory {
  const oldest = historyDates(now)[0]!;
  const cutoff = Date.parse(`${oldest}T00:00:00`);
  return {
    ...history,
    days: Object.fromEntries(Object.entries(history.days).filter(([date]) => date >= oldest)),
    incidents: history.incidents.filter(
      (incident) => incident.resolvedAt === null || Date.parse(incident.resolvedAt) >= cutoff,
    ),
  };
}

/**
 * A day's level: the worst level seen. A single failing check among others
 * is capped at "Needs attention", so one blip in hundreds of checks does not
 * paint the whole day as an outage.
 */
export function dayLevel(counts: Partial<Record<StatusLevel, number>>): StatusLevel {
  const known = STATUS_LEVELS.filter((level) => level !== "unknown" && (counts[level] ?? 0) > 0);
  if (known.length === 0) return "unknown";
  const worst = rollupStatusLevels(known);
  const knownChecks = known.reduce((sum, level) => sum + (counts[level] ?? 0), 0);
  const blip = !healthy(worst) && counts[worst] === 1 && knownChecks > 1;
  return blip
    ? rollupStatusLevels(["degraded", ...known.filter((level) => level !== worst)])
    : worst;
}

export function serviceDays(
  history: StatusHistory,
  serviceId: string,
  now: number,
): Array<StatusDay> {
  return historyDates(now).map((date) => {
    const entry = history.days[date]?.[serviceId];
    const counts = entry?.counts ?? {};
    const checks = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
    const failures =
      checks - (counts.operational ?? 0) - (counts.maintenance ?? 0) - (counts.unknown ?? 0);
    return {
      date,
      level: dayLevel(counts),
      checks,
      failures,
      notes: entry?.notes ?? [],
    };
  });
}

/** Share of known checks that were operational, or null before any. */
export function serviceUptime(
  days: ReadonlyArray<StatusDay>,
  history: StatusHistory,
  serviceId: string,
) {
  let known = 0;
  let good = 0;
  for (const day of days) {
    const counts = history.days[day.date]?.[serviceId]?.counts ?? {};
    for (const level of STATUS_LEVELS) {
      if (level === "unknown") continue;
      const count = counts[level] ?? 0;
      known += count;
      if (healthy(level)) good += count;
    }
  }
  return known === 0 ? null : Math.round((good / known) * 10_000) / 100;
}
