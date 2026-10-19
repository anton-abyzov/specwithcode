import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

/**
 * How many provider events in a row may fail to store before a run's
 * ingestion gives up. One bad event (a write lost to a stalled database, an
 * event the normalizer rejects) must not cost the run every event after it,
 * including the one that ends the turn.
 */
export const MAX_CONSECUTIVE_INGEST_FAILURES = 3;

/**
 * Stores one provider event, or skips it when storing fails and fewer than
 * `MAX_CONSECUTIVE_INGEST_FAILURES` failed in a row. None means skipped.
 * Interruption always passes through.
 */
export const isolateIngestFailure = <A, E, R>(
  ingest: Effect.Effect<A, E, R>,
  input: {
    readonly runId: string;
    readonly eventType: string;
    readonly consecutiveFailures: Ref.Ref<number>;
  },
): Effect.Effect<Option.Option<A>, E, R> =>
  ingest.pipe(
    Effect.tap(() => Ref.set(input.consecutiveFailures, 0)),
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
        const failures = yield* Ref.updateAndGet(input.consecutiveFailures, (count) => count + 1);
        yield* Effect.logWarning("orchestration V2 provider event could not be stored", {
          runId: input.runId,
          eventType: input.eventType,
          consecutiveFailures: failures,
          cause: Cause.pretty(cause),
        });
        if (failures >= MAX_CONSECUTIVE_INGEST_FAILURES) return yield* Effect.failCause(cause);
        return Option.none<A>();
      }),
    ),
  );

/** Retries after the first attempt at settling a run whose ingestion failed (about 2 minutes). */
export const FINAL_WRITE_RETRY_TIMES = 8;
const finalWriteRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * Retries the write that settles a run after its ingestion failed. That write
 * is the only thing between the run and "running" forever, and it usually
 * fails for the same passing reason the ingestion did (a stalled database),
 * so one attempt is not enough. The write itself checks the run is still
 * current, so a retry never overwrites a newer outcome. Bounded: the liveness
 * watchdog settles a run this still cannot.
 */
export const retryFinalWrite = <A, E, R>(
  write: Effect.Effect<A, E, R>,
  runId: string,
): Effect.Effect<A, E, R> => {
  // A failed SQL commit surfaces as a defect, so every cause but
  // interruption is retried, as release records are.
  const attempt: Effect.Effect<A, Cause.Cause<E>, R> = write.pipe(
    Effect.catchCause((cause) =>
      (Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("orchestration V2 could not settle a run after ingestion failed", {
            runId,
            cause: Cause.pretty(cause),
          })
      ).pipe(Effect.andThen(Effect.fail(cause))),
    ),
  );
  return attempt.pipe(
    Effect.retry({
      schedule: finalWriteRetrySchedule,
      times: FINAL_WRITE_RETRY_TIMES,
      while: (cause) => !Cause.hasInterruptsOnly(cause),
    }),
    Effect.catch((cause) => Effect.failCause(cause)),
  );
};
