import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import { CoordinatorStandbyAfterMinutes, LogicalProjectMember } from "./logicalProject.ts";

/**
 * Server-driven sync of linked copies. Each pair of copies is driven by one of
 * its servers over the handoff peer route; `projectLink.syncStatus` on that
 * server says how its passes went, so the app drives a pair itself only while
 * the server cannot (no work grant there, unreachable, an older peer).
 */

/** What a pass keeps in step: the notes replica, memory, plan claims, giving way after a takeover. */
export const LinkedServerSyncKind = Schema.Literals(["replica", "memory", "plan", "supersede"]);
export type LinkedServerSyncKind = typeof LinkedServerSyncKind.Type;

/** Why the last pass for a pair failed. */
export const LinkedServerSyncError = Schema.Literals([
  /** This machine holds no usable work grant on the peer. */
  "needs_grant",
  "unreachable",
  /** The peer runs a version without server-driven sync. */
  "outdated",
  /** The peer answered and refused. */
  "refused",
  "failed",
]);
export type LinkedServerSyncError = typeof LinkedServerSyncError.Type;

export const ProjectLinkSyncStatusInput = Schema.Struct({ projectId: ProjectId });
export type ProjectLinkSyncStatusInput = typeof ProjectLinkSyncStatusInput.Type;

export const LinkedServerSyncPair = Schema.Struct({
  peerEnvironmentId: EnvironmentId,
  peerProjectId: ProjectId,
  kind: LinkedServerSyncKind,
  /** The end of the last pass that left this pair in step. */
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  /** Null after a successful pass. */
  lastError: Schema.NullOr(LinkedServerSyncError),
});
export type LinkedServerSyncPair = typeof LinkedServerSyncPair.Type;

/** Why re-arming a standby after an automatic takeover has not finished, or stopped. */
export const StandbyRearmReason = Schema.Literals([
  "no_candidates",
  "unreachable",
  "needs_grant",
  "needs_update",
  "not_member",
  "no_consent",
  "superseded_conflict",
  "team_rules",
  "refused",
  "lease_failed",
  "standby_missing",
  "owner_changed",
  "superseded",
  "off",
]);
export type StandbyRearmReason = typeof StandbyRearmReason.Type;

/**
 * This machine's re-arm for one copy: the owner's consent here, and, while
 * this copy coordinates after an automatic takeover, how far re-arming went.
 */
export const ProjectStandbyRearmStatus = Schema.Struct({
  consent: Schema.NullOr(
    Schema.Struct({
      chainId: Schema.String,
      members: Schema.Array(LogicalProjectMember),
      afterMinutes: CoordinatorStandbyAfterMinutes,
    }),
  ),
  /** Only for the epoch this copy coordinates at now. */
  run: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(["pending", "verifying", "armed", "stopped"]),
      reason: Schema.NullOr(StandbyRearmReason),
      detail: Schema.NullOr(Schema.String),
      standby: Schema.NullOr(LogicalProjectMember),
      epoch: NonNegativeInt,
      since: IsoDateTime,
    }),
  ),
});
export type ProjectStandbyRearmStatus = typeof ProjectStandbyRearmStatus.Type;

/** The pairs this server drives for one of its copies; empty when it drives none. */
export const ProjectLinkSyncStatus = Schema.Struct({
  pairs: Schema.Array(LinkedServerSyncPair).check(Schema.isMaxLength(1000)),
  /** Absent from older servers, and where this copy has no re-arm consent or run. */
  standbyRearm: Schema.optional(ProjectStandbyRearmStatus),
});
export type ProjectLinkSyncStatus = typeof ProjectLinkSyncStatus.Type;
