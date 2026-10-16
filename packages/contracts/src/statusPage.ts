import * as Schema from "effect/Schema";

/**
 * The Status page: this host's own services, its machines and the providers
 * it depends on, with a 90-day daily history kept on the host.
 *
 * The host checks in the background and serves the latest result; reading the
 * page never waits on a network call.
 */

export const STATUS_HISTORY_DAYS = 90;

/** Worst first, the order a group or a day rolls up in. */
export const STATUS_LEVELS = [
  "major_outage",
  "partial_outage",
  "degraded",
  "unknown",
  "maintenance",
  "operational",
] as const;

export const StatusLevel = Schema.Literals(STATUS_LEVELS);
export type StatusLevel = typeof StatusLevel.Type;

export const STATUS_LEVEL_LABELS: Record<StatusLevel, string> = {
  operational: "Operational",
  degraded: "Needs attention",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
};

/** The worst level in `levels`; unknown when there is nothing to judge. */
export function rollupStatusLevels(levels: Iterable<StatusLevel>): StatusLevel {
  let worst: number | null = null;
  for (const level of levels) {
    const rank = STATUS_LEVELS.indexOf(level);
    if (worst === null || rank < worst) worst = rank;
  }
  return worst === null ? "unknown" : STATUS_LEVELS[worst]!;
}

export const StatusServiceGroup = Schema.Literals(["app", "machines", "dependencies"]);
export type StatusServiceGroup = typeof StatusServiceGroup.Type;

export const StatusComponent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  level: StatusLevel,
  detail: Schema.NullOr(Schema.String),
});
export type StatusComponent = typeof StatusComponent.Type;

export const StatusDay = Schema.Struct({
  /** Local calendar day, `YYYY-MM-DD`. */
  date: Schema.String,
  /** Worst level seen that day; unknown when nothing was checked. */
  level: StatusLevel,
  checks: Schema.Number,
  /** Checks that were not operational (unknown excluded). */
  failures: Schema.Number,
  /** Short notes for the day, such as an incident title or an error count. */
  notes: Schema.Array(Schema.String),
});
export type StatusDay = typeof StatusDay.Type;

export const StatusService = Schema.Struct({
  id: Schema.String,
  group: StatusServiceGroup,
  name: Schema.String,
  level: StatusLevel,
  /** Why the service has its level, in a sentence. */
  detail: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
  /** Where the level comes from, such as "This Mac" or "status.claude.com". */
  source: Schema.String,
  sourceUrl: Schema.NullOr(Schema.String),
  /** App features that stop working or degrade when this service is down. */
  dependents: Schema.Array(Schema.String),
  components: Schema.Array(StatusComponent),
  /** Oldest first, one entry per day of the history window. */
  days: Schema.Array(StatusDay),
  /** Share of known checks that were operational; null before any. */
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type StatusService = typeof StatusService.Type;

export const StatusIncidentStage = Schema.Literals([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);
export type StatusIncidentStage = typeof StatusIncidentStage.Type;

export const StatusIncident = Schema.Struct({
  id: Schema.String,
  serviceId: Schema.String,
  title: Schema.String,
  level: StatusLevel,
  stage: StatusIncidentStage,
  /** "public" comes from a provider's status page, "local" from this host. */
  origin: Schema.Literals(["public", "local"]),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type StatusIncident = typeof StatusIncident.Type;

export const StatusSnapshot = Schema.Struct({
  generatedAt: Schema.String,
  level: StatusLevel,
  /** When the last background check finished; null before the first one. */
  checkedAt: Schema.NullOr(Schema.String),
  /** A check is running now. */
  checking: Schema.Boolean,
  services: Schema.Array(StatusService),
  /** Open incidents first, then the most recently resolved. */
  incidents: Schema.Array(StatusIncident),
});
export type StatusSnapshot = typeof StatusSnapshot.Type;

export class StatusPageError extends Schema.TaggedError<StatusPageError>()("StatusPageError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
