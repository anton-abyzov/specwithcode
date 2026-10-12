import type { OrchestrationV2StoredEvent, ThreadId } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

/** Bound active thread reactions, not the number of events waiting on one thread. */
export const TERMINAL_RUN_CONCURRENCY = 8;

/**
 * Each thread has one FIFO mailbox. Only its head occupies a worker, so a long
 * backlog on a blocked thread cannot consume every worker. Existing command
 * locks and run identity checks remain inside the caller's handler.
 */
export const makeTerminalRunReactor = <A, E, R>(
  keyOf: (item: A) => ThreadId,
  process: (item: A) => Effect.Effect<void, E, R>,
  concurrency = TERMINAL_RUN_CONCURRENCY,
) =>
  Effect.gen(function* () {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > TERMINAL_RUN_CONCURRENCY
    ) {
      return yield* Effect.die(new Error("Invalid terminal run concurrency"));
    }
    const mailboxes = yield* TxRef.make<ReadonlyMap<ThreadId, ReadonlyArray<A>>>(new Map());
    const ready = yield* Effect.acquireRelease(TxQueue.unbounded<ThreadId>(), (queue) =>
      TxRef.set(mailboxes, new Map()).pipe(Effect.andThen(TxQueue.shutdown(queue)), Effect.tx),
    );

    const finish = (key: ThreadId) =>
      Effect.gen(function* () {
        const current = yield* TxRef.get(mailboxes);
        const rest = current.get(key)?.slice(1) ?? [];
        const next = new Map(current);
        if (rest.length === 0) next.delete(key);
        else {
          next.set(key, rest);
          yield* TxQueue.offer(ready, key);
        }
        yield* TxRef.set(mailboxes, next);
      }).pipe(Effect.tx);

    const worker = TxQueue.take(ready).pipe(
      Effect.flatMap((key) =>
        TxRef.get(mailboxes).pipe(
          Effect.flatMap((current) => {
            const pending = current.get(key);
            if (pending === undefined || pending.length === 0) return Effect.void;
            const item = pending[0]!;
            return Effect.suspend(() => process(item)).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logWarning("Terminal run reaction failed", { threadId: key, cause }),
              ),
              Effect.ensuring(finish(key)),
            );
          }),
        ),
      ),
      Effect.forever,
    );
    for (let index = 0; index < concurrency; index++) yield* worker.pipe(Effect.forkScoped);
    // Close admission before worker finalizers run: finishing an interrupted
    // head must not hand pending work to a still-idle sibling during shutdown.
    yield* Effect.addFinalizer(() =>
      TxRef.set(mailboxes, new Map()).pipe(Effect.andThen(TxQueue.shutdown(ready)), Effect.tx),
    );

    const enqueue = (item: A) =>
      Effect.gen(function* () {
        const key = keyOf(item);
        const current = yield* TxRef.get(mailboxes);
        const pending = current.get(key);
        if (pending === undefined && !(yield* TxQueue.offer(ready, key))) return;
        yield* TxRef.set(mailboxes, new Map(current).set(key, [...(pending ?? []), item]));
      }).pipe(Effect.tx);
    const drain = TxRef.get(mailboxes).pipe(
      Effect.flatMap((current) => (current.size > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );
    return { enqueue, drain };
  });

/** The stream is already filtered; preserve subscription and recovery boundaries. */
export const runTerminalRunReactor =
  <E, R>(process: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void, E, R>) =>
  <E2, R2>(
    stream: Stream.Stream<OrchestrationV2StoredEvent, E2, R2>,
  ): Effect.Effect<void, E2, R | R2> =>
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* makeTerminalRunReactor(
          (stored: OrchestrationV2StoredEvent) => stored.event.threadId,
          process,
        );
        yield* Stream.runForEach(stream, reactor.enqueue);
        yield* reactor.drain;
      }),
    );
