import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  STANDBY_DELIVERED_RUN_IDS_MAX,
  type CoordinatorStandbyRecord,
  type CoordinatorStandbyShadowWorker,
  CoordinatorStandbyStore,
  type CoordinatorStandbyStoreError,
} from "./CoordinatorStandbyStore.ts";

/**
 * The standby's side of automatic coordinator takeover: when it may fire.
 *
 * Silence is measured on the wall clock between this machine's own receive
 * times, and only across a watch the monotonic clock vouches for. A sleeping
 * Mac stops its monotonic clock while the wall clock runs on, so a gap
 * between the two means this machine was not awake to hear leases, and the
 * watch starts again. Effect's TestClock cannot model that gap, so the
 * monotonic source is injected.
 */

/** How often the standby checks, and how often the coordinator sends a lease. */
export const STANDBY_TICK_MS = 30_000;
/** The longest planned pause a coordinator may announce before a service update. */
export const PLANNED_PAUSE_MAX_MS = 30 * 60_000;

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export interface MonotonicClock {
  /** Milliseconds from an arbitrary origin that never moves backwards and stops while the machine sleeps. */
  readonly nowMs: () => number;
}

/** `performance.now()` comes from the OS monotonic clock, which pauses during system sleep. */
export const systemMonotonicClock: MonotonicClock = { nowMs: () => performance.now() };

export interface ClockSample {
  readonly wallMs: number;
  readonly monoMs: number;
}

/**
 * Whether the wall clock can be trusted since the previous tick: it must not
 * move backwards, nor run ahead of the monotonic clock by more than two ticks
 * (this machine slept, or the time was stepped forward).
 */
export function clockJumped(
  previous: ClockSample,
  current: ClockSample,
  tickMs: number = STANDBY_TICK_MS,
): boolean {
  const wallDelta = current.wallMs - previous.wallMs;
  const monoDelta = current.monoMs - previous.monoMs;
  return wallDelta < 0 || wallDelta - monoDelta > 2 * tickMs;
}

export type StandbyDecision =
  | { readonly fire: true; readonly takeOverAtMs: number }
  | {
      readonly fire: false;
      readonly reason:
        | "not-armed"
        | "paused"
        | "standby-sleeping"
        | "no-lease-while-watching"
        | "waiting";
      /** When it would fire if nothing else is heard, or null when it cannot fire yet. */
      readonly takeOverAtMs: number | null;
    };

/** Armed when every worker machine it checked lets it steer the project there (none to check is armed). */
export function standbyIsArmed(record: Pick<CoordinatorStandbyRecord, "armedFor">): boolean {
  return record.armedFor.every((entry) => entry.armed);
}

/**
 * The pure takeover rule (AC-05). It fires only when all hold:
 * - a lease was accepted since the current watch began;
 * - `afterMinutes` of silence passed since that lease, or since a planned pause ended;
 * - every worker machine it checked lets it steer there;
 * - neither a planned pause nor this machine's own sleep is in effect.
 */
export function shouldTakeOver(
  record: Pick<
    CoordinatorStandbyRecord,
    | "afterMinutes"
    | "lastLeaseAt"
    | "watchingSince"
    | "leaseSinceWatching"
    | "pausedUntil"
    | "standbySleeping"
    | "armedFor"
  >,
  nowMs: number,
): StandbyDecision {
  const lastLeaseMs = record.lastLeaseAt === null ? Number.NaN : Date.parse(record.lastLeaseAt);
  const watchingSinceMs = Date.parse(record.watchingSince);
  const pausedUntilMs = record.pausedUntil === null ? Number.NaN : Date.parse(record.pausedUntil);
  if (
    !record.leaseSinceWatching ||
    !Number.isFinite(lastLeaseMs) ||
    !(lastLeaseMs >= watchingSinceMs)
  )
    return { fire: false, reason: "no-lease-while-watching", takeOverAtMs: null };
  const silenceFrom = Number.isFinite(pausedUntilMs)
    ? Math.max(lastLeaseMs, pausedUntilMs)
    : lastLeaseMs;
  const takeOverAtMs = silenceFrom + record.afterMinutes * 60_000;
  if (record.standbySleeping)
    return { fire: false, reason: "standby-sleeping", takeOverAtMs: null };
  if (!standbyIsArmed(record)) return { fire: false, reason: "not-armed", takeOverAtMs: null };
  if (Number.isFinite(pausedUntilMs) && nowMs < pausedUntilMs)
    return { fire: false, reason: "paused", takeOverAtMs };
  if (nowMs < takeOverAtMs) return { fire: false, reason: "waiting", takeOverAtMs };
  return { fire: true, takeOverAtMs };
}

export interface CoordinatorLeaseInput {
  /** The environment the caller's grant names as its coordinator. */
  readonly callerEnvironmentId: string;
  readonly epoch: number;
  readonly seq: number;
  readonly runningThreads: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  readonly workers: ReadonlyArray<CoordinatorStandbyShadowWorker>;
  /** A planned pause, such as a service update. Capped at 30 minutes from receipt. */
  readonly pausedUntil?: string | undefined;
  /** The coordinator is about to sleep. */
  readonly sleeping?: boolean | undefined;
}

export type LeaseVerdict =
  | { readonly accepted: true; readonly record: CoordinatorStandbyRecord }
  | {
      readonly accepted: false;
      readonly reason: "not-registered-coordinator" | "wrong-epoch" | "stale-seq";
    };

/**
 * Applies one lease to the standby record (the AC-03 checks a record can make;
 * the route checks the grant's project scope). The receive time is this
 * machine's own, and the delay stays the one the owner accepted here: a lease
 * never changes who is registered or how long the standby waits.
 */
export function applyLease(
  record: CoordinatorStandbyRecord,
  lease: CoordinatorLeaseInput,
  receivedAtMs: number,
): LeaseVerdict {
  if (lease.callerEnvironmentId !== record.coordinator.environmentId)
    return { accepted: false, reason: "not-registered-coordinator" };
  if (lease.epoch !== record.epoch) return { accepted: false, reason: "wrong-epoch" };
  if (record.lastSeq !== null && !(lease.seq > record.lastSeq))
    return { accepted: false, reason: "stale-seq" };
  const receivedAt = isoAt(receivedAtMs);
  const requestedPauseMs =
    lease.pausedUntil === undefined ? Number.NaN : Date.parse(lease.pausedUntil);
  const pausedUntil =
    Number.isFinite(requestedPauseMs) && requestedPauseMs > receivedAtMs
      ? isoAt(Math.min(requestedPauseMs, receivedAtMs + PLANNED_PAUSE_MAX_MS))
      : null;
  return {
    accepted: true,
    record: {
      ...record,
      lastLeaseAt: receivedAt,
      lastSeq: lease.seq,
      leaseSinceWatching: true,
      pausedUntil,
      coordinatorSleptAt: lease.sleeping === true ? receivedAt : null,
      runningThreads: lease.runningThreads.map(({ threadId, title }) => ({ threadId, title })),
      shadowWorkers: lease.workers.map((worker) => ({
        ...worker,
        deliveredRunIds: worker.deliveredRunIds.slice(-STANDBY_DELIVERED_RUN_IDS_MAX),
      })),
      lastRefusal: null,
      updatedAt: receivedAt,
    },
  };
}

/** Starts a fresh watch: no earlier lease counts until a new one arrives. */
export function restartWatch(
  record: CoordinatorStandbyRecord,
  nowMs: number,
): CoordinatorStandbyRecord {
  const now = isoAt(nowMs);
  return {
    ...record,
    watchingSince: now,
    leaseSinceWatching: false,
    standbySleeping: false,
    updatedAt: now,
  };
}

export interface StandbyWatchTick {
  /** Whether the clock jumped since the previous tick and every watch started again. */
  readonly restarted: boolean;
  readonly due: ReadonlyArray<CoordinatorStandbyRecord>;
}

/**
 * The tick the standby loop runs every 30 seconds. Creating it is the process
 * start, so every watch begins again there. It only decides; the caller takes
 * over under the project lock and re-reads the lease time first.
 */
export const makeStandbyWatch = (monotonic: MonotonicClock = systemMonotonicClock) =>
  Effect.gen(function* () {
    const store = yield* CoordinatorStandbyStore;
    const sample = Effect.map(Clock.currentTimeMillis, (wallMs) => ({
      wallMs,
      monoMs: monotonic.nowMs(),
    }));
    const restartAll = (nowMs: number) =>
      Effect.gen(function* () {
        for (const record of yield* store.list)
          yield* store.modify(record.logicalProjectId, (current) =>
            current ? restartWatch(current, nowMs) : undefined,
          );
      });
    const first = yield* sample;
    yield* restartAll(first.wallMs);
    const previous = yield* Ref.make<ClockSample>(first);

    const tick: Effect.Effect<StandbyWatchTick, CoordinatorStandbyStoreError> = Effect.gen(
      function* () {
        const current = yield* sample;
        const restarted = clockJumped(yield* Ref.getAndSet(previous, current), current);
        if (restarted) yield* restartAll(current.wallMs);
        const due = (yield* store.list).filter(
          (record) => shouldTakeOver(record, current.wallMs).fire,
        );
        return { restarted, due };
      },
    );
    return { tick } as const;
  });
