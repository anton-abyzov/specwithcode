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

/** How long one stage of a run took, in whole seconds; null when it never ran. */
export const ReleaseRunStageTiming = Schema.Struct({
  id: Schema.String,
  state: ReleaseRunStageState,
  seconds: Schema.NullOr(Schema.Number),
});
export type ReleaseRunStageTiming = typeof ReleaseRunStageTiming.Type;

/**
 * One release run's timings, without its steps and machines: what the Speed by
 * version section compares. `totalSeconds` is the time any stage ran, overlaps
 * counted once (`releaseRunSeconds`), so a pause before a resume is not in it.
 */
export const ReleaseRunTiming = Schema.Struct({
  runId: Schema.String,
  version: Schema.String,
  channel: Schema.String,
  state: ReleaseRunState,
  createdBy: Schema.String,
  startedAt: Schema.String,
  endedAt: Time,
  totalSeconds: Schema.NullOr(Schema.Number),
  stages: Schema.Array(ReleaseRunStageTiming),
});
export type ReleaseRunTiming = typeof ReleaseRunTiming.Type;

/**
 * One verified update install on this machine (update.py's receipt,
 * `updates/receipts/update-<version>-<stamp>.json`): its `timings.total` and
 * per-phase milliseconds.
 */
export const ReleaseInstallTiming = Schema.Struct({
  version: Schema.String,
  installedAt: Schema.String,
  totalMs: Schema.Number,
  phases: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
});
export type ReleaseInstallTiming = typeof ReleaseInstallTiming.Type;

/**
 * The newest release runs on this machine, newest first; `skipped` counts files it could not read.
 * `timings` (newest first, more runs than `runs`) and `installs` (newest first) are optional: a
 * server from before them sends neither, and the view derives timings from `runs` instead.
 */
export const ReleaseRunsSnapshot = Schema.Struct({
  runs: Schema.Array(ReleaseRun),
  skipped: Schema.Number,
  timings: Schema.optionalKey(Schema.Array(ReleaseRunTiming)),
  installs: Schema.optionalKey(Schema.Array(ReleaseInstallTiming)),
});
export type ReleaseRunsSnapshot = typeof ReleaseRunsSnapshot.Type;

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The intervals, in epoch milliseconds, a stage ran: its steps' (a step that
 * started but never recorded its end ran until the stage ended, or until now
 * while it runs), else the stage's own start and end. Empty before it started.
 */
export function releaseStageIntervals(
  stage: ReleaseRunStage,
  nowMs: number,
): ReadonlyArray<readonly [number, number]> {
  const intervals: Array<[number, number]> = [];
  for (const step of stage.steps) {
    const started = parseTime(step.startedAt);
    if (started === null) continue;
    // A finished stage never counts on.
    const ended =
      parseTime(step.endedAt) ??
      (stage.state === "running"
        ? nowMs
        : (parseTime(stage.endedAt) ?? (step.state === "running" ? nowMs : null)));
    if (ended !== null && ended >= started) intervals.push([started, ended]);
  }
  // A running stage between two steps (one passed, the next not started) keeps counting.
  if (
    stage.state === "running" &&
    intervals.length > 0 &&
    !stage.steps.some((step) => step.state === "running")
  ) {
    const last = Math.max(...intervals.map(([, end]) => end));
    if (nowMs > last) intervals.push([last, nowMs]);
  }
  if (intervals.length > 0) return intervals;
  const started = parseTime(stage.startedAt);
  if (started === null) return [];
  const ended = parseTime(stage.endedAt) ?? (stage.state === "running" ? nowMs : null);
  return ended === null ? [] : [[started, Math.max(started, ended)]];
}

/** Whole seconds the intervals cover, overlaps counted once; null for none. */
export function coveredSeconds(intervals: ReadonlyArray<readonly [number, number]>): number | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [from, to] = sorted[0]!;
  for (const [start, end] of sorted.slice(1)) {
    if (start > to) {
      total += to - from;
      [from, to] = [start, end];
    } else {
      to = Math.max(to, end);
    }
  }
  return Math.max(0, Math.round((total + (to - from)) / 1000));
}

/**
 * How long a stage took, or has run so far while running; null before it
 * started. With step times it is the time its steps ran: a stage's first and
 * last step can be far apart (a resume reruns one half an hour later), and
 * that gap is no time the stage took.
 */
export function releaseStageSeconds(stage: ReleaseRunStage, nowMs: number): number | null {
  return coveredSeconds(releaseStageIntervals(stage, nowMs));
}

/** The time any stage of the run ran, overlaps counted once; null before any started. */
export function releaseRunSeconds(run: Pick<ReleaseRun, "stages">, nowMs: number): number | null {
  return coveredSeconds(run.stages.flatMap((stage) => releaseStageIntervals(stage, nowMs)));
}

/** A run's timings for the Speed by version section. */
export function releaseRunTiming(run: ReleaseRun, nowMs: number): ReleaseRunTiming {
  return {
    runId: run.runId,
    version: run.version,
    channel: run.channel,
    state: run.state,
    createdBy: run.createdBy,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    totalSeconds: releaseRunSeconds(run, nowMs),
    stages: run.stages.map((stage) => ({
      id: stage.id,
      state: stage.state,
      seconds: releaseStageSeconds(stage, nowMs),
    })),
  };
}
