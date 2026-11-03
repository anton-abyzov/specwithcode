import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type AdoptWorkersInput,
  type AdoptWorkersResult,
  RemoteWorkerAdoption,
} from "../fleet/RemoteWorkerAdoption.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import {
  type CoordinatorStandbyRecord,
  CoordinatorStandbyStore,
  type CoordinatorStandbyStoreError,
} from "./CoordinatorStandbyStore.ts";
import {
  makeStandbyWatch,
  type MonotonicClock,
  STANDBY_TICK_MS,
  type StandbyWatchTick,
  systemMonotonicClock,
} from "./CoordinatorStandbyWatch.ts";
import { ProjectLink } from "./ProjectLink.ts";

/**
 * The standby's loop for automatic coordinator takeover. Every 30 seconds,
 * on every server, it ticks the standby watch; for each armed project the
 * watch says is due it takes over under the project lock (`autoTakeover`),
 * then claims the new epoch on every worker machine and takes on the workers
 * the replaced coordinator was following there.
 *
 * The takeover is written before the claims are made. A claim or an adoption
 * that fails afterwards is tried again on later rounds, with backoff, until
 * every machine answered: `autoTakeover` replays by its operation id (named
 * by the epoch), a repeated claim at the same epoch stands, and adopted rows
 * are named after the old coordinator's rows. A restart re-checks each armed
 * project once, so a follow-up the old process owed is not lost.
 *
 * Nothing starts while a service update holds this machine. While held, the
 * lease route answers busy and the coordinator stays unfenced, so on the
 * round after the hold ends silence counts from then, as after a planned
 * pause.
 */

/** The longest wait between two tries of a follow-up still owed. */
const FOLLOW_UP_BACKOFF_MAX_MS = 30 * 60_000;

export interface StandbyTakeoverDeps {
  readonly watch: {
    readonly tick: Effect.Effect<StandbyWatchTick, CoordinatorStandbyStoreError>;
    /** Counts silence from now; run on the first round after a hold ends. */
    readonly resumeAfterHold: Effect.Effect<void, CoordinatorStandbyStoreError>;
  };
  readonly store: Pick<CoordinatorStandbyStore["Service"], "list">;
  readonly autoTakeover: ProjectLink["Service"]["autoTakeover"];
  readonly selfEnvironmentId: string;
  /**
   * Claims the epoch on each worker machine and takes on the replaced
   * coordinator's workers; `unclaimed` names machines to try again.
   */
  readonly followUp: (
    input: AdoptWorkersInput,
  ) => Effect.Effect<Pick<AdoptWorkersResult, "unclaimed">>;
  /** Whether a service update holds this machine; a held round does nothing. */
  readonly held: Effect.Effect<boolean>;
}

export interface StandbyRoundResult {
  /** Takeovers this round made or replayed. */
  readonly takenOver: ReadonlyArray<{
    readonly logicalProjectId: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly replayed: boolean;
  }>;
  /** Follow-ups this round ran; `complete` when every machine answered its claim. */
  readonly followedUp: ReadonlyArray<{
    readonly logicalProjectId: string;
    readonly epoch: number;
    readonly complete: boolean;
  }>;
}

/** One registration of this machine as a standby: a new acceptance is a new takeover. */
const registrationKey = (record: CoordinatorStandbyRecord) =>
  `${record.logicalProjectId}|${record.epoch}|${record.acceptedAt}`;

/**
 * The standby round, apart from its schedule. Creating it is the process
 * start: every armed project is checked once for a follow-up still owed.
 */
export const makeStandbyTakeover = (deps: StandbyTakeoverDeps) => {
  /** Registrations whose takeover and follow-up are both done. */
  const settled = new Set<string>();
  /** Registrations checked once since the start for a takeover made before it. */
  const checked = new Set<string>();
  /** Registrations whose last try failed, and when the next may run. */
  const retry = new Map<string, { readonly failures: number; readonly atMs: number }>();
  /** Whether the last round found this machine held by a service update. */
  let wasHeld = false;

  const failed = (key: string, nowMs: number, message: string, detail: object) =>
    Effect.gen(function* () {
      const failures = (retry.get(key)?.failures ?? 0) + 1;
      retry.set(key, {
        failures,
        atMs: nowMs + Math.min(STANDBY_TICK_MS * 2 ** (failures - 1), FOLLOW_UP_BACKOFF_MAX_MS),
      });
      if (failures === 1) yield* Effect.logWarning(message, detail);
      else yield* Effect.logDebug(message, { ...detail, failures });
    });

  const round: Effect.Effect<StandbyRoundResult> = Effect.gen(function* () {
    const takenOver: Array<StandbyRoundResult["takenOver"][number]> = [];
    const followedUp: Array<StandbyRoundResult["followedUp"][number]> = [];
    if (yield* deps.held) {
      wasHeld = true;
      return { takenOver, followedUp };
    }
    if (wasHeld) {
      yield* deps.watch.resumeAfterHold;
      wasHeld = false;
    }
    const { due } = yield* deps.watch.tick;
    const dueIds = new Set(due.map((record) => record.logicalProjectId));
    const nowMs = yield* Clock.currentTimeMillis;
    const records = yield* deps.store.list;
    // Forget registrations that are gone, so a long-running server keeps no stale keys.
    const live = new Set(records.map(registrationKey));
    for (const keys of [settled, checked])
      for (const key of keys) if (!live.has(key)) keys.delete(key);
    for (const key of retry.keys()) if (!live.has(key)) retry.delete(key);
    for (const record of records) {
      const key = registrationKey(record);
      if (settled.has(key)) continue;
      const waiting = retry.get(key);
      if (waiting !== undefined) {
        if (nowMs < waiting.atMs) continue;
      } else if (!dueIds.has(record.logicalProjectId) && checked.has(key)) continue;
      checked.add(key);
      const outcome = yield* deps.autoTakeover({ logicalProjectId: record.logicalProjectId }).pipe(
        Effect.catch((error) =>
          failed(key, nowMs, "Coordinator standby could not take over", {
            logicalProjectId: record.logicalProjectId,
            error,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (outcome === undefined) continue;
      if (outcome.outcome !== "taken-over") {
        retry.delete(key);
        continue;
      }
      const { result } = outcome;
      const binding = result.coordinatorBinding;
      takenOver.push({
        logicalProjectId: record.logicalProjectId,
        epoch: binding.epoch,
        operationId: result.operationId,
        replayed: result.replayed,
      });
      if (!result.replayed)
        yield* Effect.logWarning("Coordinator standby took over after the coordinator went quiet", {
          logicalProjectId: record.logicalProjectId,
          epoch: binding.epoch,
          predecessor: record.coordinator.environmentId,
        });
      const self = result.logicalProject.members.find(
        (member) =>
          member.environmentId === deps.selfEnvironmentId && member.projectId === record.projectId,
      );
      if (self === undefined) {
        yield* failed(key, nowMs, "Coordinator standby is not listed with its own copy", {
          logicalProjectId: record.logicalProjectId,
        });
        continue;
      }
      const { unclaimed } = yield* deps.followUp({
        logicalProjectId: record.logicalProjectId,
        epoch: binding.epoch,
        projectId: record.projectId,
        coordinatorThreadId: self.coordinatorThreadId,
        predecessor: record.coordinator,
        shadowWorkers: record.shadowWorkers,
        // Every machine the replaced coordinator ran a worker on, and every other copy listed here.
        claimOn: [
          ...new Set<string>([
            ...record.shadowWorkers.map((worker) => worker.environmentId),
            ...result.logicalProject.members.map((member) => member.environmentId),
          ]),
        ].filter(
          (environmentId) =>
            environmentId !== deps.selfEnvironmentId &&
            environmentId !== record.coordinator.environmentId,
        ),
      });
      const complete = unclaimed.length === 0;
      followedUp.push({
        logicalProjectId: record.logicalProjectId,
        epoch: binding.epoch,
        complete,
      });
      if (complete) {
        settled.add(key);
        retry.delete(key);
      } else
        yield* failed(key, nowMs, "Coordinator standby could not claim its epoch everywhere yet", {
          logicalProjectId: record.logicalProjectId,
          epoch: binding.epoch,
          unclaimed,
        });
    }
    return { takenOver, followedUp };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Coordinator standby round failed", { cause }).pipe(
        Effect.as({ takenOver: [], followedUp: [] }),
      ),
    ),
  );

  return { round } as const;
};

export interface StandbyLoopOptions {
  /** The clock that stops while this machine sleeps; tests move it by hand. */
  readonly monotonic?: MonotonicClock | undefined;
}

/**
 * Runs the standby round every 30 seconds for as long as the server runs,
 * parked until the server is activated so it never delays startup.
 */
export const layerWith = (options: StandbyLoopOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* CoordinatorStandbyStore;
      const link = yield* ProjectLink;
      const adoption = yield* RemoteWorkerAdoption;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const updateHold = yield* ServiceUpdateHold.optional;
      const every = Schedule.spaced(Duration.millis(STANDBY_TICK_MS));
      yield* forkParked(
        Effect.gen(function* () {
          const selfEnvironmentId = yield* environment.getEnvironmentId;
          // Making the watch is the process start: every watch begins again here.
          const watch = yield* makeStandbyWatch(options.monotonic ?? systemMonotonicClock).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Coordinator standby could not start its watch", { error }),
            ),
            Effect.retry(every),
          );
          const standby = makeStandbyTakeover({
            watch,
            store,
            autoTakeover: link.autoTakeover,
            selfEnvironmentId,
            followUp: adoption.adopt,
            held: updateHold.isHeld,
          });
          yield* standby.round.pipe(Effect.repeat(every), Effect.asVoid);
        }).pipe(Effect.provideService(CoordinatorStandbyStore, store)),
      );
    }),
  );

/** The loop with this machine's own monotonic clock. */
export const layer = layerWith();
