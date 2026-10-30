import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/** Shown for work refused while the service is held for an update. */
export const SERVICE_UPDATE_IN_PROGRESS_MESSAGE =
  "SpecWithCode is installing an update. Send this again after it restarts.";
/** Recorded on the turns, requests and effects an update's drain stops or cancels. */
export const SERVICE_UPDATE_STOP_REASON = "Stopped to install the SpecWithCode update";
/** Shown after the restart, while the update helper still checks the new release. */
export const SERVICE_UPDATE_VERIFYING_MESSAGE =
  "SpecWithCode is finishing an update. Send this again in a minute.";

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
  /**
   * The project continues threads after restarts: an interrupted turn
   * continues and a cancelled queued message is queued again. Older services omit it.
   */
  continuesAfterRestart: Schema.optional(Schema.Boolean),
  /**
   * On a `request` blocker: how many of its requests are questions (a question
   * or a sign-in) and how many are approvals. A forced update closes them and
   * asks them again after the update. Older services, which close them without
   * asking again, omit both.
   */
  questions: Schema.optional(NonNegativeInt),
  approvals: Schema.optional(NonNegativeInt),
});
export type ServiceUpdateBlocker = typeof ServiceUpdateBlocker.Type;

export const ServiceUpdatePrepareReason = Schema.Literals(["app-restart", "install"]);
export type ServiceUpdatePrepareReason = typeof ServiceUpdatePrepareReason.Type;

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
  /**
   * With `hold` and without `stopWork`: hold the service only when nothing runs, and stop
   * nothing. The hold is taken only when no other hold is in place, it closes admission at
   * once, and the look waits for commands already past admission; when something runs it is
   * released again. Only a hold taken for this call answers with `holdToken`.
   * `specweave-studio update --if-idle` sends it right before it restarts the service. Older
   * services ignore it and never answer with `holdToken`.
   */
  ifIdle: Schema.optional(Schema.Boolean),
  /**
   * The `holdToken` an if-idle hold answered with. With `ifIdle`: confirm and extend that hold,
   * only while it is still this caller's and nothing runs. With `releaseHold`: release that hold
   * only, never another caller's.
   */
  holdToken: Schema.optional(Schema.String),
  /** Cancels the update hold and lets work start again. Ignores `stopWork`. */
  releaseHold: Schema.optional(Schema.Boolean),
  /**
   * Why the caller asks. `app-restart` drains before the app restarts, which
   * ends a bundled service: its hold is short, since no install request may
   * follow. `install` (the default) precedes an install request to the update
   * agent. Older services ignore it.
   */
  reason: Schema.optional(ServiceUpdatePrepareReason),
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
  /**
   * While held: why. A window that finds an `app-restart` hold leaves it to the
   * service, which ends it soon when no install request follows; releasing it
   * would let work start again just before the app quits. Older services omit it.
   */
  holdReason: Schema.optional(ServiceUpdatePrepareReason),
  /**
   * With `ifIdle`: identifies the hold taken (or confirmed) for this call, present only then.
   * Older services omit it, and a caller must not treat their `held` as its own.
   */
  holdToken: Schema.optional(Schema.String),
  /** Turns this call interrupted; the person can continue each by hand after the update. */
  interruptedRuns: Schema.optional(NonNegativeInt),
  /** Terminals that are open now, or that this call closed when it stops work. */
  openTerminals: Schema.optional(NonNegativeInt),
  /**
   * Folder copies in flight here, as source or destination, and coordinators moving with
   * one. While any is in flight `idle` is false and an if-idle hold is refused, so a normal
   * update waits; a forced one goes ahead and they may need Retry. Older services omit it.
   */
  folderCopies: Schema.optional(NonNegativeInt),
});
export type ServerPrepareServiceUpdateResult = typeof ServerPrepareServiceUpdateResult.Type;

export class ServerPrepareServiceUpdateError extends Schema.TaggedError<ServerPrepareServiceUpdateError>()(
  "ServerPrepareServiceUpdateError",
  { message: Schema.String },
) {}
