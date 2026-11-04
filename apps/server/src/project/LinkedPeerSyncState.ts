/**
 * What this server knows about the linked pairs it drives: per pair and kind,
 * when a pass last left it in step and why the last one failed, which the
 * app reads (`projectLink.syncStatus`) to leave those pairs to the server;
 * per pair, how long to back off after failures; and a wake-up that starts a
 * pass at once when a linked machine shows it is back, by calling this one or
 * by answering a reachability probe; and the takeovers another copy showed
 * of a copy here that has not given way yet, so its coordinator starts no new
 * turn meanwhile (`CoordinatorWakeGate`).
 *
 * In memory only: after a restart the app drives every pair until the first
 * passes succeed again.
 *
 * @module LinkedPeerSyncState
 */
import type {
  EnvironmentId,
  LinkedServerSyncError,
  LinkedServerSyncKind,
  LinkedServerSyncPair,
  ProjectId,
} from "@specweave-studio/contracts";
import { pairBackoffMs } from "@specweave-studio/shared/linkedPairSync";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { stringifyJson } from "../json.ts";

/** One of this server's copies and one copy of the same project on another machine. */
export interface LinkedPair {
  readonly projectId: ProjectId;
  readonly peerEnvironmentId: EnvironmentId;
  readonly peerProjectId: ProjectId;
}

/** Status entries kept per copy; more pairs than any real project has. */
const MAX_ENTRIES = 4096;

export const pairKey = (pair: LinkedPair) =>
  stringifyJson([pair.projectId, pair.peerEnvironmentId, pair.peerProjectId]);

interface KindStatus {
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number;
  readonly lastError: LinkedServerSyncError | null;
}

interface PairState {
  readonly pair: LinkedPair;
  readonly kinds: ReadonlyMap<LinkedServerSyncKind, KindStatus>;
  /** Failed passes in a row; reset by a success or by the peer showing it is back. */
  readonly failures: number;
  readonly nextAttemptAt: number;
}

export class LinkedPeerSyncState extends Context.Service<
  LinkedPeerSyncState,
  {
    /** Whether the pair's backoff allows a pass at `now`. */
    readonly due: (pair: LinkedPair, now: number) => Effect.Effect<boolean>;
    /** Records how each kind went in one pass; any error backs the pair off. */
    readonly record: (
      pair: LinkedPair,
      now: number,
      outcomes: ReadonlyArray<{
        readonly kind: LinkedServerSyncKind;
        readonly error: LinkedServerSyncError | null;
      }>,
    ) => Effect.Effect<void>;
    /** The pairs this server drives for `projectId`. */
    readonly status: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<LinkedServerSyncPair>>;
    /** Drops pairs that are no longer linked. */
    readonly retain: (pairs: ReadonlyArray<LinkedPair>) => Effect.Effect<void>;
    /**
     * Machines whose pairs wait out a backoff at `now` after their last pass
     * could not reach them; a probe that reaches one again calls `peerSeen`.
     */
    readonly unreachable: (now: number) => Effect.Effect<ReadonlyArray<EnvironmentId>>;
    /** `environmentId` reached this server: its pairs that could not reach it retry at once, in a pass that starts now. */
    readonly peerSeen: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Starts a pass soon, for example after a link was made. */
    readonly wake: Effect.Effect<void>;
    /**
     * `projectId`'s member list changed here: its pairs skip their backoff
     * and a pass starts now, so the other copies learn the list soon.
     */
    readonly expedite: (projectId: ProjectId) => Effect.Effect<void>;
    /** Resolves on the next `wake` or `peerSeen` after it was taken. */
    readonly nextWake: Effect.Effect<Effect.Effect<void>>;
    /** Another copy showed it took over from `seen.projectId` here; the highest epoch is kept. */
    readonly markSuperseded: (seen: SupersededCopy) => Effect.Effect<void>;
    /**
     * The copy gave way, or no copy claims a takeover of it any more; with
     * `onlyFrom`, only a takeover that machine's copy claimed is cleared.
     */
    readonly clearSuperseded: (
      projectId: ProjectId,
      onlyFrom?: EnvironmentId,
    ) => Effect.Effect<void>;
    /** The takeover not yet given way to whose coordinator thread is `threadId`, if any. */
    readonly supersededFor: (threadId: string) => Effect.Effect<SupersededCopy | undefined>;
  }
>()("specweave-studio/project/LinkedPeerSyncState") {}

/**
 * A copy on this machine that another copy took over from, at a higher epoch,
 * as that copy's own digest showed it: this copy must give way.
 */
export interface SupersededCopy {
  readonly projectId: ProjectId;
  /** This copy's coordinator thread, as its shared project lists it. */
  readonly coordinatorThreadId: string | undefined;
  readonly epoch: number;
  readonly successorEnvironmentId: EnvironmentId;
}

/** Whether `threadId` is the coordinator thread of the copy `seen` names. */
export const isSupersededCoordinatorThread = (seen: SupersededCopy, threadId: string) =>
  threadId === `project-coordinator:${seen.projectId}` ||
  (seen.coordinatorThreadId !== undefined && threadId === seen.coordinatorThreadId);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const make = Effect.gen(function* () {
  const pairs = yield* Ref.make(new Map<string, PairState>());
  const signal = yield* Ref.make(yield* Deferred.make<void>());
  const superseded = yield* Ref.make(new Map<string, SupersededCopy>());

  const wake = Ref.get(signal).pipe(
    Effect.flatMap((deferred) => Deferred.succeed(deferred, undefined)),
    Effect.asVoid,
  );

  return LinkedPeerSyncState.of({
    due: (pair, now) =>
      Ref.get(pairs).pipe(Effect.map((all) => (all.get(pairKey(pair))?.nextAttemptAt ?? 0) <= now)),
    record: (pair, now, outcomes) =>
      Ref.update(pairs, (all) => {
        const key = pairKey(pair);
        const current = all.get(key);
        const kinds = new Map(current?.kinds);
        for (const { kind, error } of outcomes)
          kinds.set(kind, {
            lastSuccessAt: error === null ? now : (kinds.get(kind)?.lastSuccessAt ?? null),
            lastAttemptAt: now,
            lastError: error,
          });
        // A peer too old for a kind never will be: that alone does not back the pair off.
        const failed = outcomes.some(
          (outcome) => outcome.error !== null && outcome.error !== "outdated",
        );
        const failures = failed ? (current?.failures ?? 0) + 1 : 0;
        const next = new Map(all);
        if (!next.has(key) && next.size >= MAX_ENTRIES) next.delete(next.keys().next().value!);
        next.set(key, { pair, kinds, failures, nextAttemptAt: now + pairBackoffMs(failures) });
        return next;
      }),
    status: (projectId) =>
      Ref.get(pairs).pipe(
        Effect.map((all) =>
          [...all.values()]
            .filter((state) => state.pair.projectId === projectId)
            .flatMap((state) =>
              [...state.kinds].map(([kind, status]): LinkedServerSyncPair => ({
                peerEnvironmentId: state.pair.peerEnvironmentId,
                peerProjectId: state.pair.peerProjectId,
                kind,
                lastSuccessAt: status.lastSuccessAt === null ? null : iso(status.lastSuccessAt),
                lastAttemptAt: iso(status.lastAttemptAt),
                lastError: status.lastError,
              })),
            )
            .slice(0, 1000),
        ),
      ),
    retain: (kept) =>
      Ref.update(pairs, (all) => {
        const keys = new Set(kept.map(pairKey));
        return new Map([...all].filter(([key]) => keys.has(key)));
      }),
    unreachable: (now) =>
      Ref.get(pairs).pipe(
        Effect.map((all) => [
          ...new Set(
            [...all.values()]
              .filter(
                (state) =>
                  state.nextAttemptAt > now &&
                  [...state.kinds.values()].some((status) => status.lastError === "unreachable"),
              )
              .map((state) => state.pair.peerEnvironmentId),
          ),
        ]),
      ),
    peerSeen: (environmentId) =>
      Ref.modify(pairs, (all) => {
        let backedOff = false;
        const next = new Map(
          [...all].map(([key, state]) => {
            // A call proves only that the peer is reachable: refusals keep their backoff.
            if (
              state.pair.peerEnvironmentId !== environmentId ||
              state.failures === 0 ||
              ![...state.kinds.values()].some((status) => status.lastError === "unreachable")
            )
              return [key, state] as const;
            backedOff = true;
            return [key, { ...state, failures: 0, nextAttemptAt: 0 }] as const;
          }),
        );
        return [backedOff, backedOff ? next : all] as const;
      }).pipe(Effect.flatMap((backedOff) => (backedOff ? wake : Effect.void))),
    wake,
    expedite: (projectId) =>
      Ref.update(
        pairs,
        (all) =>
          new Map(
            [...all].map(([key, state]) =>
              state.pair.projectId === projectId
                ? ([key, { ...state, nextAttemptAt: 0 }] as const)
                : ([key, state] as const),
            ),
          ),
      ).pipe(Effect.andThen(wake)),
    nextWake: Effect.gen(function* () {
      const current = yield* Ref.get(signal);
      // A wake that already fired is spent: wait for the next one.
      if (yield* Deferred.isDone(current)) {
        const fresh = yield* Deferred.make<void>();
        yield* Ref.set(signal, fresh);
        // @effect-diagnostics-next-line returnEffectInGen:off - the caller awaits it later.
        return Deferred.await(fresh);
      }
      // @effect-diagnostics-next-line returnEffectInGen:off - the caller awaits it later.
      return Deferred.await(current);
    }),
    markSuperseded: (seen) =>
      Ref.update(superseded, (all) => {
        const held = all.get(seen.projectId);
        if (held !== undefined && held.epoch >= seen.epoch) return all;
        const next = new Map(all);
        if (!next.has(seen.projectId) && next.size >= MAX_ENTRIES)
          next.delete(next.keys().next().value!);
        next.set(seen.projectId, seen);
        return next;
      }),
    clearSuperseded: (projectId, onlyFrom) =>
      Ref.update(superseded, (all) => {
        const held = all.get(projectId);
        if (held === undefined) return all;
        if (onlyFrom !== undefined && held.successorEnvironmentId !== onlyFrom) return all;
        const next = new Map(all);
        next.delete(projectId);
        return next;
      }),
    supersededFor: (threadId) =>
      Ref.get(superseded).pipe(
        Effect.map((all) =>
          [...all.values()].find((seen) => isSupersededCoordinatorThread(seen, threadId)),
        ),
      ),
  });
});

export const layer = Layer.effect(LinkedPeerSyncState, make);
