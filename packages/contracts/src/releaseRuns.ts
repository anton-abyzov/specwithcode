import * as Schema from "effect/Schema";

/**
 * A release run record, `updates/runs/release-<version>-<runId>.json` on the
 * machine that runs releases (scripts/release/run_record.py writes it).
 * `stages` follow the release graph, the same ids release.yml's jobs use;
 * `hosts` hold one row per machine the canary and fleet stages asked.
 */

export const RELEASE_RUN_STAGE_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
] as const;
export const ReleaseRunStageState = Schema.Literals(RELEASE_RUN_STAGE_STATES);
export type ReleaseRunStageState = typeof ReleaseRunStageState.Type;

export const RELEASE_RUN_HOST_STATES = [
  "pending",
  "asked",
  "acked",
  "installed",
  "verified",
  "not-updated",
] as const;
export const ReleaseRunHostState = Schema.Literals(RELEASE_RUN_HOST_STATES);
export type ReleaseRunHostState = typeof ReleaseRunHostState.Type;

export const ReleaseRunState = Schema.Literals(["running", "held", "failed", "done"]);
export type ReleaseRunState = typeof ReleaseRunState.Type;

const Time = Schema.NullOr(Schema.String);

export const ReleaseRunStep = Schema.Struct({
  name: Schema.String,
  state: ReleaseRunStageState,
  startedAt: Time,
  endedAt: Time,
  log: Schema.NullOr(Schema.String),
  attempt: Schema.optionalKey(Schema.Number),
});
export type ReleaseRunStep = typeof ReleaseRunStep.Type;

export const ReleaseRunShard = Schema.Struct({ n: Schema.Number, state: ReleaseRunStageState });
export type ReleaseRunShard = typeof ReleaseRunShard.Type;

export const ReleaseRunStage = Schema.Struct({
  id: Schema.String,
  needs: Schema.Array(Schema.String),
  state: ReleaseRunStageState,
  startedAt: Time,
  endedAt: Time,
  log: Schema.NullOr(Schema.String),
  steps: Schema.Array(ReleaseRunStep),
  shards: Schema.optionalKey(Schema.Array(ReleaseRunShard)),
  facts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ReleaseRunStage = typeof ReleaseRunStage.Type;

export const ReleaseRunHost = Schema.Struct({
  identity: Schema.String,
  role: Schema.Literals(["canary", "fleet"]),
  required: Schema.Boolean,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  state: ReleaseRunHostState,
  askedAt: Time,
  ackedAt: Time,
  installedAt: Time,
  verifiedAt: Time,
  reason: Schema.NullOr(Schema.String),
  receipt: Schema.optionalKey(Schema.String),
  desktop: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nextRetryAt: Schema.optionalKey(Schema.String),
});
export type ReleaseRunHost = typeof ReleaseRunHost.Type;

export const ReleaseRun = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("release"),
  runId: Schema.String,
  rev: Schema.Number,
  version: Schema.String,
  previous: Schema.NullOr(Schema.String),
  channel: Schema.String,
  sha: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  createdBy: Schema.String,
  startedAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Time,
  state: ReleaseRunState,
  resumes: Schema.optionalKey(Schema.Number),
  stages: Schema.Array(ReleaseRunStage),
  hosts: Schema.Array(ReleaseRunHost),
});
export type ReleaseRun = typeof ReleaseRun.Type;

/** The newest release runs on this machine, newest first; `skipped` counts files it could not read. */
export const ReleaseRunsSnapshot = Schema.Struct({
  runs: Schema.Array(ReleaseRun),
  skipped: Schema.Number,
});
export type ReleaseRunsSnapshot = typeof ReleaseRunsSnapshot.Type;
