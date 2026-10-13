import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Work that keeps the Studio service from installing an update. The service's
 * update helper refuses to snapshot the database while any of it exists, so
 * "Restart to update" stops it first and names whatever is left.
 *
 * - `run`: a turn still preparing, starting or running.
 * - `queued`: a message waiting behind a turn.
 * - `request`: an approval or question waiting for an answer.
 * - `effect`: provider work the service has accepted but not finished.
 * - `session`: an agent process still starting or working.
 */
export const ServiceUpdateBlockerKind = Schema.Literals([
  "run",
  "queued",
  "request",
  "effect",
  "session",
]);
export type ServiceUpdateBlockerKind = typeof ServiceUpdateBlockerKind.Type;

export const ServiceUpdateBlocker = Schema.Struct({
  kind: ServiceUpdateBlockerKind,
  count: NonNegativeInt,
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(Schema.String),
});
export type ServiceUpdateBlocker = typeof ServiceUpdateBlocker.Type;

export const ServerPrepareServiceUpdateInput = Schema.Struct({
  /**
   * True stops every running task first, as Stop would, cancels queued
   * messages, and ends what the provider does not end on its own. False only
   * reports what is still running.
   */
  stopWork: Schema.Boolean,
  /**
   * With `stopWork`, also hold the service for the update: new turns, queued
   * messages, scheduled tasks and terminals are refused until the update
   * installs, fails or is cancelled, so the drained service stays quiet while
   * the update helper snapshots it. Older services ignore it.
   */
  hold: Schema.optional(Schema.Boolean),
  /** Cancels the update hold and lets work start again. Ignores `stopWork`. */
  releaseHold: Schema.optional(Schema.Boolean),
});
export type ServerPrepareServiceUpdateInput = typeof ServerPrepareServiceUpdateInput.Type;

export const ServerPrepareServiceUpdateResult = Schema.Struct({
  /** Nothing the update helper waits for is left. */
  idle: Schema.Boolean,
  /** Threads this call asked to stop. */
  stoppedThreads: NonNegativeInt,
  blockers: Schema.Array(ServiceUpdateBlocker),
  /** True while the service refuses new work for the update. */
  held: Schema.optional(Schema.Boolean),
  /**
   * While held: when the hold ends unless the update agent is still installing
   * the request (ISO time). A forced install request can retry until then.
   */
  holdUntil: Schema.optional(Schema.String),
  /** Turns this call interrupted; the person can continue each by hand after the update. */
  interruptedRuns: Schema.optional(NonNegativeInt),
  /** Terminals that are open now, or that this call closed when it stops work. */
  openTerminals: Schema.optional(NonNegativeInt),
});
export type ServerPrepareServiceUpdateResult = typeof ServerPrepareServiceUpdateResult.Type;

export class ServerPrepareServiceUpdateError extends Schema.TaggedError<ServerPrepareServiceUpdateError>()(
  "ServerPrepareServiceUpdateError",
  { message: Schema.String },
) {}
