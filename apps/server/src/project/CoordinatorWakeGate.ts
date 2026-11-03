/**
 * The coordinator's self-fence for automatic takeover (AC-06). With a standby
 * set, a coordinator that has not heard back from it for `afterMinutes` less
 * a margin stops starting coordinator turns, and the lease loop interrupts the
 * one running and its local children. The standby can only take over after
 * `afterMinutes` of silence on its own clock, so this copy has stopped first:
 * two coordinators never run.
 *
 * The margin covers two missed lease ticks, one lease timeout and a minute of
 * clock drift between the machines. The state lives in the lease records, so
 * it survives restarts, and a copy that never heard from its standby counts
 * from when the owner turned the standby on.
 */
import type { Project, ThreadId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type CoordinatorLeaseRecord,
  CoordinatorLeaseStore,
  layer as CoordinatorLeaseStoreLayer,
} from "./CoordinatorLeaseStore.ts";
import {
  type MonotonicClock,
  STANDBY_TICK_MS,
  systemMonotonicClock,
} from "./CoordinatorStandbyWatch.ts";

/** Lease request timeout on the coordinator side (handoffPeers.ts TIMEOUT_MS). */
const LEASE_TIMEOUT_MS = 10_000;
/** Clock drift allowed between the coordinator and its standby. */
const CLOCK_DRIFT_MS = 60_000;
/** 130 seconds below `afterMinutes`: the fence is up before the standby can fire. */
export const COORDINATOR_FENCE_MARGIN_MS = 2 * STANDBY_TICK_MS + LEASE_TIMEOUT_MS + CLOCK_DRIFT_MS;

export const COORDINATOR_FENCE_REFUSAL =
  "Checking with the standby Mac before running. It has not answered, so this Mac paused its coordinator. Choose Run here anyway to run it here. This turns off automatic takeover.";

export const COORDINATOR_FENCE_UNREADABLE_REFUSAL =
  "This Mac could not read its standby records, so it paused its coordinator rather than risk running beside the standby. Restart SpecWithCode; if this stays, turn the standby off in the project's settings.";

const parse = (value: string | null | undefined) =>
  value === null || value === undefined ? Number.NaN : Date.parse(value);

/**
 * When the fence goes up if nothing more is heard, or null when no fence can
 * apply: no standby, or a standby that answered it does not stand by here.
 * Silence counts from the last lease the standby confirmed, the last time it
 * said it was busy updating, or when the standby was turned on.
 */
export function fenceAt(record: CoordinatorLeaseRecord): number | null {
  const target = record.target;
  if (target === null || record.standbyMissingAt !== null) return null;
  const heard = lastHeardAt(record);
  if (!Number.isFinite(heard)) return Number.NEGATIVE_INFINITY;
  return heard + target.afterMinutes * 60_000 - COORDINATOR_FENCE_MARGIN_MS;
}

/** The latest of the last confirmed lease, the last busy answer and when the standby was turned on. */
function lastHeardAt(record: CoordinatorLeaseRecord): number {
  return Math.max(
    ...[record.lastSuccessfulLeaseAt, record.lastPausedAnswerAt, record.target?.enabledAt]
      .map(parse)
      .filter(Number.isFinite),
  );
}

/**
 * Whether the copy is fenced now. A fence once raised stays until a lease
 * round trip comes back with no takeover (the lease loop clears it then), or
 * the standby is released or turned off.
 */
export function coordinatorFenced(record: CoordinatorLeaseRecord, nowMs: number): boolean {
  if (record.target === null) return false;
  if (record.fencedSince !== null) return true;
  const at = fenceAt(record);
  return at !== null && nowMs >= at;
}

/**
 * The last time silence was measured from, on the monotonic clock as well: a
 * wall clock stepped backwards would otherwise move the fence past the
 * standby's own deadline, which the standby measures on its clock.
 */
export interface MonotonicSilence {
  /** The answers silence was measured from; any new one starts it again. */
  readonly answers: string;
  /** The monotonic time silence counts from. */
  readonly heardMonoMs: number;
}

/**
 * Where silence counts from on the monotonic clock: kept while the record's
 * answers are unchanged, otherwise taken from the wall clock now. A last
 * answer the wall clock places in the future counts from now, so a clock
 * stepped backwards never fences a copy whose standby keeps answering.
 */
export function monotonicSilence(
  previous: MonotonicSilence | undefined,
  record: CoordinatorLeaseRecord,
  sample: { readonly wallMs: number; readonly monoMs: number },
): MonotonicSilence | undefined {
  if (fenceAt(record) === null || record.target === null) return undefined;
  const answers = JSON.stringify([
    record.lastSuccessfulLeaseAt,
    record.lastPausedAnswerAt,
    record.target.enabledAt,
  ]);
  if (previous !== undefined && previous.answers === answers) return previous;
  const heard = lastHeardAt(record);
  const since = Number.isFinite(heard) ? Math.max(0, sample.wallMs - heard) : 0;
  return { answers, heardMonoMs: sample.monoMs - since };
}

/** Whether the silence measured on the monotonic clock alone reached the fence. */
export function monotonicFenceDue(
  silence: MonotonicSilence,
  record: CoordinatorLeaseRecord,
  monoMs: number,
): boolean {
  if (record.target === null) return false;
  return (
    monoMs - silence.heardMonoMs >=
    record.target.afterMinutes * 60_000 - COORDINATOR_FENCE_MARGIN_MS
  );
}

/** Whether `threadId` is the coordinator of the copy `record` leases for. */
export function isRecordCoordinatorThread(record: CoordinatorLeaseRecord, threadId: string) {
  return (
    threadId === `project-coordinator:${record.projectId}` ||
    (record.coordinatorThreadId != null && threadId === record.coordinatorThreadId)
  );
}

export interface CoordinatorWakeGateShape {
  /** Null when a turn may start on `threadId`; otherwise why not. Never fails. */
  readonly check: (threadId: ThreadId) => Effect.Effect<string | null>;
}

/** Without lease records every turn is allowed (the default), as for tests and servers without the feature. */
export class CoordinatorWakeGate extends Context.Reference<CoordinatorWakeGateShape>(
  "specweave-studio/project/CoordinatorWakeGate",
  { defaultValue: () => ({ check: () => Effect.succeed(null) }) },
) {}

/**
 * The gate. When the records file cannot be read, the last records this
 * process read decide, as if no answer came since, so a fence due by then
 * holds. Before any read succeeded every turn starts, as it always did: the
 * coordinator of a project without a standby must never be blocked by it.
 */
export const makeCheck = (
  store: CoordinatorLeaseStore["Service"],
): CoordinatorWakeGateShape["check"] => {
  let lastRead: ReadonlyArray<CoordinatorLeaseRecord> | null = null;
  const decide = (
    records: ReadonlyArray<CoordinatorLeaseRecord>,
    threadId: ThreadId,
    nowMs: number,
  ) => {
    const record = records.find(
      (candidate) => candidate.target !== null && isRecordCoordinatorThread(candidate, threadId),
    );
    if (record === undefined) return null;
    return coordinatorFenced(record, nowMs) ? COORDINATOR_FENCE_REFUSAL : null;
  };
  return (threadId) =>
    Effect.gen(function* () {
      const records = yield* store.list;
      lastRead = records;
      return decide(records, threadId, yield* Clock.currentTimeMillis);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Coordinator wake gate could not read the lease records", {
            cause,
          });
          if (lastRead === null) return null;
          const refusal = decide(lastRead, threadId, yield* Clock.currentTimeMillis);
          return refusal === null ? null : COORDINATOR_FENCE_UNREADABLE_REFUSAL;
        }),
      ),
    );
};

export interface FenceSweepDeps {
  readonly store: CoordinatorLeaseStore["Service"];
  /** The clock that never steps backwards; tests move it by hand. */
  readonly monotonic?: MonotonicClock | undefined;
  readonly loadProject: (projectId: Project["id"]) => Effect.Effect<Project | undefined>;
  /** Interrupts the project's coordinator turn and the local children it started. */
  readonly stopCoordinator: (project: Project, reason: string) => Effect.Effect<void>;
}

/**
 * Runs after every lease round: raises the fence where silence passed the
 * threshold, persists it, and interrupts the coordinator turn running there.
 * Silence is measured on the wall clock and, within this process, on the
 * monotonic clock too; the fence goes up when either reaches it.
 */
export const makeFenceSweep = (deps: FenceSweepDeps) => {
  const monotonic = deps.monotonic ?? systemMonotonicClock;
  const silences = new Map<string, MonotonicSilence>();
  return (records: ReadonlyArray<CoordinatorLeaseRecord>) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const sample = { wallMs: nowMs, monoMs: monotonic.nowMs() };
      for (const record of records) {
        if (record.target === null || record.fencedSince !== null) continue;
        const silence = monotonicSilence(silences.get(record.projectId), record, sample);
        if (silence === undefined) silences.delete(record.projectId);
        else silences.set(record.projectId, silence);
        const due =
          coordinatorFenced(record, nowMs) ||
          (silence !== undefined && monotonicFenceDue(silence, record, sample.monoMs));
        if (!due) continue;
        const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const raised = yield* deps.store.modify(record.projectId, (current) =>
          current === undefined || current.target === null || current.fencedSince !== null
            ? undefined
            : { ...current, fencedSince: at, updatedAt: at },
        );
        if (raised?.fencedSince !== at) continue;
        yield* Effect.logWarning("Coordinator paused: its standby has not answered", {
          projectId: record.projectId,
          standby: record.target.standby.environmentId,
        });
        const project = yield* deps.loadProject(record.projectId as Project["id"]);
        if (project !== undefined)
          yield* deps.stopCoordinator(
            project,
            "The standby Mac has not answered, so this Mac paused its coordinator.",
          );
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Coordinator fence sweep failed", { cause })),
    );
};

/** The gate over this server's lease records. */
export const layer = Layer.effect(
  CoordinatorWakeGate,
  Effect.gen(function* () {
    const store = yield* CoordinatorLeaseStore;
    return { check: makeCheck(store) };
  }),
).pipe(Layer.provide(CoordinatorLeaseStoreLayer));
