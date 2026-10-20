import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * How old a shell snapshot a background sweep accepts. The full shell scan is
 * the longest single statement the server runs, and five sweeps used to run
 * it each on their own clock. Every sweep that acts re-reads the thread it
 * acts on first, so half a minute of age changes no decision. A sweep that
 * must see writes made after a known moment, such as a catch-up after an
 * event stream gap, reads exactly instead.
 */
export const SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS = 30_000;

/**
 * With no projection write since it was read, a snapshot still matches the
 * database, so sweeps on an idle server reuse it. Capped anyway, in case a
 * write ever reaches the tables without going through `apply`.
 */
export const UNCHANGED_SHELL_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export interface ShellSnapshotReadOptions {
  readonly location?: "active" | "archive";
  readonly unsettledOnly?: boolean;
}

export interface ShellSnapshotCacheOptions extends ShellSnapshotReadOptions {
  /**
   * Accept a snapshot read up to this long ago. Left out, the call reads the
   * database, as user-facing reads and deletion guards must.
   */
  readonly maxAgeMs?: number;
}

interface Entry {
  readonly generation: number;
  readonly readAtMs: number;
  readonly snapshot: OrchestrationV2ThreadShellSnapshot;
}

type Decision<E> =
  | { readonly _tag: "Cached"; readonly snapshot: OrchestrationV2ThreadShellSnapshot }
  | {
      readonly _tag: "Join";
      readonly flight: Deferred.Deferred<OrchestrationV2ThreadShellSnapshot, E>;
    }
  | {
      readonly _tag: "Lead";
      readonly flight: Deferred.Deferred<OrchestrationV2ThreadShellSnapshot, E>;
      readonly generation: number;
    };

const keyOf = (options: ShellSnapshotReadOptions | undefined) =>
  `${options?.location ?? "all"}:${options?.unsettledOnly === true ? "unsettled" : "every"}`;

/**
 * The same rule as the `unsettledOnly` filter in `selectShellThreadRows`
 * (ProjectionStore.ts): `settledAt` unset and `settledOverride` not
 * "settled". A shell's own fields decide it, so filtering a full snapshot
 * gives what the filtered read gives.
 */
const isUnsettled = (thread: OrchestrationV2ThreadShell) =>
  thread.settledAt === null && thread.settledOverride !== "settled";

// One filtered copy per snapshot, so repeat sweeps get the same object.
const unsettledViews = new WeakMap<
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadShellSnapshot
>();

const unsettledView = (snapshot: OrchestrationV2ThreadShellSnapshot) => {
  const cached = unsettledViews.get(snapshot);
  if (cached !== undefined) return cached;
  const view = {
    ...snapshot,
    threads: snapshot.threads.filter(isUnsettled),
    archivedThreads: snapshot.archivedThreads.filter(isUnsettled),
  };
  unsettledViews.set(snapshot, view);
  return view;
};

/**
 * Shares shell snapshot reads between background sweeps. Calls that accept an
 * age reuse a recent snapshot, or wait on the read already running for the
 * same location instead of starting another. They always share the read of
 * every thread in that location and drop settled threads in memory, so
 * sweeps that want only unsettled threads reuse the same scan as the rest.
 * `invalidate` counts a projection write: a snapshot read before it is
 * reused only within the caller's age.
 */
export const make = <E>(
  read: (options: ShellSnapshotReadOptions) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, E>,
) =>
  Effect.sync(() => {
    let generation = 0;
    const entries = new Map<string, Entry>();
    const flights = new Map<string, Deferred.Deferred<OrchestrationV2ThreadShellSnapshot, E>>();

    const readOptionsOf = (options: ShellSnapshotCacheOptions | undefined) => ({
      ...(options?.location === undefined ? {} : { location: options.location }),
      ...(options?.unsettledOnly === undefined ? {} : { unsettledOnly: options.unsettledOnly }),
    });

    // The generation is taken before the read starts, so a write that lands
    // while it runs marks the result as possibly older than the database.
    const readAndStore = (
      key: string,
      options: ShellSnapshotReadOptions,
      startedGeneration: number,
    ) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const snapshot = yield* read(options);
        const previous = entries.get(key);
        if (previous === undefined || previous.readAtMs <= startedAtMs) {
          entries.set(key, { generation: startedGeneration, readAtMs: startedAtMs, snapshot });
        }
        return snapshot;
      });

    const sharedRead = (
      key: string,
      readOptions: ShellSnapshotReadOptions,
      maxAgeMs: number,
    ): Effect.Effect<OrchestrationV2ThreadShellSnapshot, E> =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        // Uninterruptible from the decision until the leader's exit handler is
        // in place: a leader interrupted between the two would leave its
        // flight registered and never completed, and every later sweep would
        // wait on it forever. Only the read and the wait stay interruptible.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // One synchronous step, so two callers cannot both start a read.
            const decision = yield* Effect.sync((): Decision<E> => {
              const entry = entries.get(key);
              if (entry !== undefined) {
                const ageMs = nowMs - entry.readAtMs;
                if (
                  ageMs >= 0 &&
                  (ageMs < maxAgeMs ||
                    (entry.generation === generation &&
                      ageMs < UNCHANGED_SHELL_SNAPSHOT_MAX_AGE_MS))
                ) {
                  return { _tag: "Cached", snapshot: entry.snapshot };
                }
              }
              const running = flights.get(key);
              if (running !== undefined) return { _tag: "Join", flight: running };
              const flight = Deferred.makeUnsafe<OrchestrationV2ThreadShellSnapshot, E>();
              flights.set(key, flight);
              return { _tag: "Lead", flight, generation };
            });
            switch (decision._tag) {
              case "Cached":
                return decision.snapshot;
              case "Join":
                // A read cut short by its own caller's interruption says nothing
                // about the database; read again rather than pass the interrupt on.
                return yield* restore(
                  Deferred.await(decision.flight).pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause) ? read(readOptions) : Effect.failCause(cause),
                    ),
                  ),
                );
              case "Lead":
                return yield* restore(readAndStore(key, readOptions, decision.generation)).pipe(
                  Effect.onExit((exit) =>
                    Effect.suspend(() => {
                      if (flights.get(key) === decision.flight) flights.delete(key);
                      return Deferred.done(decision.flight, exit);
                    }),
                  ),
                );
            }
          }),
        );
      });

    const get = (
      options?: ShellSnapshotCacheOptions,
    ): Effect.Effect<OrchestrationV2ThreadShellSnapshot, E> =>
      Effect.gen(function* () {
        const maxAgeMs = options?.maxAgeMs;
        if (maxAgeMs === undefined) {
          // An exact read still refreshes the shared copy for the sweeps.
          return yield* readAndStore(keyOf(options), readOptionsOf(options), generation);
        }
        const readOptions = options?.location === undefined ? {} : { location: options.location };
        const key = keyOf(readOptions);
        const view =
          options?.unsettledOnly === true
            ? unsettledView
            : (snapshot: OrchestrationV2ThreadShellSnapshot) => snapshot;
        return yield* sharedRead(key, readOptions, maxAgeMs).pipe(Effect.map(view));
      });

    const invalidate = Effect.sync(() => {
      generation += 1;
    });

    /** Projection writes counted so far in this process. */
    const writeCount = Effect.sync(() => generation);

    return { get, invalidate, writeCount };
  });
