/**
 * Away mode: leave this machine and hand its threads, routines and
 * coordinators to an always-on machine. The preflight (`away.preflight`)
 * lists what would move, what stays and why, and every missing grant or
 * link, without changing anything. "Request access" sends every missing
 * item to the target as one pending request its owner approves there.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ProjectId } from "./baseSchemas.ts";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** The most rows a plan lists per kind; more are summarized, never sent. */
export const AWAY_PLAN_MAX_ITEMS = 300;
/** The most missing items one access request carries. */
export const AWAY_ACCESS_MAX_MISSING = 100;

/**
 * What the target still needs before work can move there:
 * - `work-grant`: the target does not let this machine run work there, or its
 *   grant leaves the project out.
 * - `routines`: the grant does not let this machine's coordinator manage routines.
 * - `project-link`: the project has no linked copy on the target.
 * - `provider`: a sign-in or model a thread needs is missing there.
 * - `secret-file`: a file such as `.env.local` is missing there.
 * - `standby`: the target cannot take over the project's coordinator.
 */
export const AwayMissingGrantKind = Schema.Literals([
  "work-grant",
  "routines",
  "project-link",
  "provider",
  "secret-file",
  "standby",
]);
export type AwayMissingGrantKind = typeof AwayMissingGrantKind.Type;

export const AwayMissingGrant = Schema.Struct({
  kind: AwayMissingGrantKind,
  /** The machine that has to change something: the target, or this machine for its own steps. */
  machineEnvironmentId: EnvironmentId,
  machineLabel: bounded(120),
  /** This machine's copy of the project, when the item is about one project. */
  projectId: Schema.optionalKey(ProjectId),
  projectTitle: Schema.optionalKey(bounded(500)),
  /** What is missing, in the user's words: "Ministorm: no .env.local". */
  detail: bounded(500),
  /** The one step that fixes it: "Turn on Routines for M4 in Settings > Machines on Ministorm". */
  fix: bounded(500),
});
export type AwayMissingGrant = typeof AwayMissingGrant.Type;

export const AwayPlanItemKind = Schema.Literals(["thread", "routine", "coordinator"]);
export type AwayPlanItemKind = typeof AwayPlanItemKind.Type;

/**
 * - `move`: goes to the target.
 * - `handoff-ready`: a check failed; it stays here, marked ready to continue elsewhere.
 * - `stay`: never leaves this machine (a worktree set, the personal assistant).
 * - `pause`: paused here while away and listed (a webhook routine).
 */
export const AwayPlanAction = Schema.Literals(["move", "handoff-ready", "stay", "pause"]);
export type AwayPlanAction = typeof AwayPlanAction.Type;

export const AwayPlanItem = Schema.Struct({
  kind: AwayPlanItemKind,
  /** A thread id, a routine id, or the project id for a coordinator. */
  id: bounded(512),
  title: bounded(500),
  projectId: Schema.optionalKey(ProjectId),
  action: AwayPlanAction,
  reason: bounded(500),
});
export type AwayPlanItem = typeof AwayPlanItem.Type;

export const AwayPlan = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  targetLabel: bounded(120),
  items: Schema.Array(AwayPlanItem),
  missingGrants: Schema.Array(AwayMissingGrant),
  /** Nothing missing: everything that can move, moves. */
  ready: Schema.Boolean,
  checkedAt: IsoDateTime,
});
export type AwayPlan = typeof AwayPlan.Type;

/** `live`: only projects with running or queued work or enabled routines (D-03). */
export const AwayCoordinatorScope = Schema.Literals(["live", "all"]);
export type AwayCoordinatorScope = typeof AwayCoordinatorScope.Type;

export const AwayPreflightInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  coordinatorScope: Schema.optionalKey(AwayCoordinatorScope),
});
export type AwayPreflightInput = typeof AwayPreflightInput.Type;

export const AwayAccessRequestInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  missing: Schema.Array(AwayMissingGrant).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AWAY_ACCESS_MAX_MISSING),
  ),
});
export type AwayAccessRequestInput = typeof AwayAccessRequestInput.Type;

export const AwayAccessRequestStatus = Schema.Literals([
  "sent",
  "already-pending",
  "approved",
  "declined",
]);
export type AwayAccessRequestStatus = typeof AwayAccessRequestStatus.Type;

export const AwayAccessRequestResult = Schema.Struct({
  requestId: bounded(128),
  status: AwayAccessRequestStatus,
  detail: bounded(1000),
});
export type AwayAccessRequestResult = typeof AwayAccessRequestResult.Type;

/** Asks the target how a request this machine sent stands. */
export const AwayAccessStatusInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  requestId: bounded(128),
});
export type AwayAccessStatusInput = typeof AwayAccessStatusInput.Type;

/**
 * A request another machine sent here, as this machine's owner sees it.
 * `changes` is what approving applies to that machine's work grant here;
 * the other items are steps the owner takes by hand.
 */
export const AwayAccessGrantChanges = Schema.Struct({
  routines: Schema.optionalKey(Schema.Boolean),
  /** This machine's projects added to that machine's listed grant projects. */
  addProjectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(256))),
});
export type AwayAccessGrantChanges = typeof AwayAccessGrantChanges.Type;

export const AwayAccessRequestRecord = Schema.Struct({
  requestId: bounded(128),
  fromEnvironmentId: EnvironmentId,
  fromLabel: bounded(120),
  missing: Schema.Array(AwayMissingGrant).check(Schema.isMaxLength(AWAY_ACCESS_MAX_MISSING)),
  changes: AwayAccessGrantChanges,
  status: Schema.Literals(["pending", "approved", "declined"]),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  /** Why approving could not apply every change, when it could not. */
  detail: Schema.NullOr(bounded(1000)),
});
export type AwayAccessRequestRecord = typeof AwayAccessRequestRecord.Type;

export const AwayAccessRequestList = Schema.Struct({
  requests: Schema.Array(AwayAccessRequestRecord),
});
export type AwayAccessRequestList = typeof AwayAccessRequestList.Type;

export const AwayAccessDecisionInput = Schema.Struct({
  requestId: bounded(128),
  decision: Schema.Literals(["approve", "decline"]),
});
export type AwayAccessDecisionInput = typeof AwayAccessDecisionInput.Type;

export const AwayEmptyInput = Schema.Struct({});

export const AwayErrorCode = Schema.Literals([
  "invalid",
  "unknown_machine",
  "unreachable",
  "not_allowed",
  "not_found",
  "failed",
]);
export type AwayErrorCode = typeof AwayErrorCode.Type;

export class AwayError extends Schema.TaggedError<AwayError>()("AwayError", {
  code: AwayErrorCode,
  message: Schema.String,
}) {}
