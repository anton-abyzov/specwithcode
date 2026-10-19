import type { OrchestrationV2ThreadShellSnapshot } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * How old a shell snapshot a background sweep accepts. The full shell scan is
 * the longest single statement the server runs, and five sweeps used to run
 * it each on their own clock. Every sweep that acts re-reads the thread it
 * acts on first, so a few seconds of age changes no decision.
 */
export const SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS = 5_000;

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
 * Shares shell snapshot reads between background sweeps. Calls that accept an
 * age reuse a recent snapshot, or wait on the read already running for the
 * same options instead of starting another. `invalidate` counts a projection
 * write: a snapshot read before it is reused only within the caller's age.
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

    const get = (
      options?: ShellSnapshotCacheOptions,
    ): Effect.Effect<OrchestrationV2ThreadShellSnapshot, E> =>
      Effect.gen(function* () {
        const key = keyOf(options);
        const readOptions = readOptionsOf(options);
        const maxAgeMs = options?.maxAgeMs;
        if (maxAgeMs === undefined) {
          // An exact read still refreshes the shared copy for the sweeps.
          return yield* readAndStore(key, readOptions, generation);
        }
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

    const invalidate = Effect.sync(() => {
      generation += 1;
    });

    /** Projection writes counted so far in this process. */
    const writeCount = Effect.sync(() => generation);

    return { get, invalidate, writeCount };
  });
