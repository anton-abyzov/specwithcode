import type { ProviderSessionId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

/** A provider session that left the live map, for runs it may have left behind. */
export interface ReleasedProviderSession {
  readonly providerSessionId: ProviderSessionId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly reason: string;
}

export interface RunLivenessShape {
  /**
   * Keeps the run live while `effect` runs. Holds count, so a turn start that
   * hands the run to its ingestion fiber leaves no moment where it looks dead.
   */
  readonly hold: <A, E, R>(runId: RunId, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Keeps the run live until the returned release runs (at most once). */
  readonly acquire: (runId: RunId) => Effect.Effect<Effect.Effect<void>>;
  readonly isLive: (runId: RunId) => Effect.Effect<boolean>;
  readonly sessionReleased: (session: ReleasedProviderSession) => Effect.Effect<void>;
  readonly takeReleasedSession: Effect.Effect<ReleasedProviderSession>;
}

/**
 * Which runs this process is still driving: a turn start in progress or an
 * ingestion fiber reading the provider's events. Every run in the database is
 * driven by this process (startup recovery settles the rest), so a running
 * run nobody holds is orphaned. The default knows nothing and reports every
 * run live, so code built without the shared layer never settles a run; the
 * live layer must be the same reference wherever runs start and are checked.
 */
export class RunLiveness extends Context.Reference<RunLivenessShape>(
  "specweave-studio/orchestration-v2/RunLiveness",
  {
    defaultValue: () => ({
      hold: (_runId, effect) => effect,
      acquire: () => Effect.succeed(Effect.void),
      isLive: () => Effect.succeed(true),
      sessionReleased: () => Effect.void,
      takeReleasedSession: Effect.never,
    }),
  },
) {}

export const make = Effect.gen(function* () {
  const holds = yield* Ref.make<ReadonlyMap<RunId, number>>(new Map());
  // Sliding: a burst of releases must never block the session manager, and
  // the periodic sweep still catches any run a dropped signal left behind.
  const releasedSessions = yield* Queue.sliding<ReleasedProviderSession>(256);
  const adjust = (runId: RunId, delta: number) =>
    Ref.update(holds, (current) => {
      const next = new Map(current);
      const count = (next.get(runId) ?? 0) + delta;
      if (count > 0) next.set(runId, count);
      else next.delete(runId);
      return next;
    });
  const acquire = (runId: RunId) =>
    Effect.gen(function* () {
      yield* adjust(runId, 1);
      const released = yield* Ref.make(false);
      return Ref.getAndSet(released, true).pipe(
        Effect.flatMap((already) => (already ? Effect.void : adjust(runId, -1))),
      );
    }).pipe(Effect.uninterruptible);
  return {
    hold: (runId, effect) =>
      Effect.acquireUseRelease(
        acquire(runId),
        () => effect,
        (release) => release,
      ),
    acquire,
    isLive: (runId) => Ref.get(holds).pipe(Effect.map((current) => current.has(runId))),
    sessionReleased: (session) => Queue.offer(releasedSessions, session).pipe(Effect.asVoid),
    takeReleasedSession: Queue.take(releasedSessions),
  } satisfies RunLivenessShape;
});

export const layer = Layer.effect(RunLiveness, make);
