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
import { STANDBY_TICK_MS } from "./CoordinatorStandbyWatch.ts";

/** Lease request timeout on the coordinator side (handoffPeers.ts TIMEOUT_MS). */
const LEASE_TIMEOUT_MS = 10_000;
/** Clock drift allowed between the coordinator and its standby. */
const CLOCK_DRIFT_MS = 60_000;
/** 130 seconds below `afterMinutes`: the fence is up before the standby can fire. */
export const COORDINATOR_FENCE_MARGIN_MS = 2 * STANDBY_TICK_MS + LEASE_TIMEOUT_MS + CLOCK_DRIFT_MS;

export const COORDINATOR_FENCE_REFUSAL =
  "Checking with the standby Mac before running. It has not answered, so this Mac paused its coordinator. Choose Run here anyway to run it here. This turns off automatic takeover.";

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
  const heard = Math.max(
    ...[record.lastSuccessfulLeaseAt, record.lastPausedAnswerAt, target.enabledAt]
      .map(parse)
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(heard)) return Number.NEGATIVE_INFINITY;
  return heard + target.afterMinutes * 60_000 - COORDINATOR_FENCE_MARGIN_MS;
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

export const makeCheck =
  (store: CoordinatorLeaseStore["Service"]): CoordinatorWakeGateShape["check"] =>
  (threadId) =>
    Effect.gen(function* () {
      const records = yield* store.list;
      const record = records.find(
        (candidate) => candidate.target !== null && isRecordCoordinatorThread(candidate, threadId),
      );
      if (record === undefined) return null;
      return coordinatorFenced(record, yield* Clock.currentTimeMillis)
        ? COORDINATOR_FENCE_REFUSAL
        : null;
    }).pipe(
      // A records file that cannot be read never blocks work: the lease loop logs it.
      Effect.catchCause((cause) =>
        Effect.logWarning("Coordinator wake gate could not read the lease records", {
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

export interface FenceSweepDeps {
  readonly store: CoordinatorLeaseStore["Service"];
  readonly loadProject: (projectId: Project["id"]) => Effect.Effect<Project | undefined>;
  /** Interrupts the project's coordinator turn and the local children it started. */
  readonly stopCoordinator: (project: Project, reason: string) => Effect.Effect<void>;
}

/**
 * Runs after every lease round: raises the fence where silence passed the
 * threshold, persists it, and interrupts the coordinator turn running there.
 */
export const makeFenceSweep =
  (deps: FenceSweepDeps) => (records: ReadonlyArray<CoordinatorLeaseRecord>) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      for (const record of records) {
        if (record.target === null || record.fencedSince !== null) continue;
        if (!coordinatorFenced(record, nowMs)) continue;
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

/** The gate over this server's lease records. */
export const layer = Layer.effect(
  CoordinatorWakeGate,
  Effect.gen(function* () {
    const store = yield* CoordinatorLeaseStore;
    return { check: makeCheck(store) };
  }),
).pipe(Layer.provide(CoordinatorLeaseStoreLayer));
