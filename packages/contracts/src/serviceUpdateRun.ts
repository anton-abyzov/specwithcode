import * as Schema from "effect/Schema";

/**
 * One Update now press, as every window sees it (0988).
 *
 * The desktop's main process creates `updates/run.json` when a person presses
 * Update now, keyed by `runId`; the service's update agent owns it once it
 * claims it, renewing a lease with a heartbeat while it installs; the main
 * process then installs the app (`updates/run-app.json`) once the service is
 * verified. Windows only follow the run: while it is not terminal none of them
 * offers Update now, Restart to update or Retry.
 */

export const StudioServiceUpdateRunPhaseSchema = Schema.Literals([
  "preparing",
  "requested",
  "downloading",
  "waiting",
  "installing",
  "verified",
  "failed",
  "cancelled",
  "expired",
]);
export type StudioServiceUpdateRunPhase = typeof StudioServiceUpdateRunPhaseSchema.Type;

export const StudioServiceUpdateRunAppPhaseSchema = Schema.Literals([
  "waiting-for-service",
  "installing",
  "relaunching",
  "done",
  "failed",
]);
export type StudioServiceUpdateRunAppPhase = typeof StudioServiceUpdateRunAppPhaseSchema.Type;

/** The install helper's current step, from `updates/install-progress.json`. */
export const StudioServiceUpdateRunStepSchema = Schema.Struct({
  /** The helper's phase name, such as `beforeRead`. */
  label: Schema.String,
  /** Step i of n, counted from 1. */
  i: Schema.Number,
  n: Schema.Number,
  phaseStartedAt: Schema.NullOr(Schema.String),
  /** When the helper began applying the release: the clock its expected time is measured on. */
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** How long the last verified install took in all, or null when none is known. */
  expectedMs: Schema.NullOr(Schema.Number),
  /** The service was restarted: it is back while the helper finishes its checks. */
  serviceBack: Schema.Boolean,
  /**
   * The helper's result once it ended: `verified`, `refused`, `rolled-back`,
   * `held` or `failed`; null while it runs. Absent from older desktops.
   */
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type StudioServiceUpdateRunStep = typeof StudioServiceUpdateRunStepSchema.Type;

export const StudioServiceUpdateRunSchema = Schema.Struct({
  runId: Schema.String,
  phase: StudioServiceUpdateRunPhaseSchema,
  /** Nothing more happens for this run: the windows may offer actions again. */
  terminal: Schema.Boolean,
  targetVersion: Schema.String,
  /** The app release installed after the service, or null when the app needs none. */
  appTargetVersion: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  deadlineAt: Schema.String,
  /** The newest sign of life: the owner's heartbeat, the helper's, or the run's start. */
  lastSignAt: Schema.String,
  /** No sign of life for over two minutes; shown in amber, never with a button. */
  noProgress: Schema.Boolean,
  step: Schema.NullOr(StudioServiceUpdateRunStepSchema),
  app: Schema.NullOr(
    Schema.Struct({
      phase: StudioServiceUpdateRunAppPhaseSchema,
      message: Schema.NullOr(Schema.String),
      /** When the app half ended (done or failed), or null while it runs. */
      finishedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  message: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["updated", "failed", "cancelled", "expired"])),
  /** When the service half ended, or null while it runs. */
  endedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type StudioServiceUpdateRun = typeof StudioServiceUpdateRunSchema.Type;

/**
 * What a window asks of the run. `begin` creates the run (or answers the one
 * already running); `acknowledge` records that the outcome was shown;
 * `retry-app` installs the app again on the same run ("Restart now");
 * `cancel` withdraws a run the agent has not claimed; with a `reason` (the
 * install request failed) the run ends as failed with it, not as cancelled.
 */
export const StudioServiceUpdateRunActionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("begin"),
    targetVersion: Schema.String,
    appTargetVersion: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("acknowledge"), runId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("retry-app"), runId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    runId: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  }),
]);
export type StudioServiceUpdateRunAction = typeof StudioServiceUpdateRunActionSchema.Type;

export const StudioServiceUpdateRunResultSchema = Schema.Struct({
  /**
   * False when this Mac's update agent does not advertise run support (an
   * older agent): the window then updates the way it did before runs.
   */
  supported: Schema.Boolean,
  /** `begin` made a new run; false when it answered one already running. */
  created: Schema.Boolean,
  run: Schema.NullOr(StudioServiceUpdateRunSchema),
});
export type StudioServiceUpdateRunResult = typeof StudioServiceUpdateRunResultSchema.Type;
