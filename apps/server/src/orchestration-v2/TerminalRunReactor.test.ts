import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeTerminalRunReactor, TERMINAL_RUN_CONCURRENCY } from "./TerminalRunReactor.ts";

type Item = { threadId: ThreadId; ordinal: number };
const item = (thread: string, ordinal = 0): Item => ({ threadId: ThreadId.make(thread), ordinal });

describe("terminal reactions", () => {
  it.effect("reproduces the previous serial stream blocking B behind A", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const enteredA = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const completedB = yield* Deferred.make<void>();
        const worker = yield* Stream.make(item("A"), item("B")).pipe(
          Stream.runForEach((entry) =>
            entry.threadId === "A"
              ? Deferred.succeed(enteredA, undefined).pipe(Effect.andThen(Deferred.await(releaseA)))
              : Deferred.succeed(completedB, undefined),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(enteredA);
        expect(yield* Deferred.isDone(completedB)).toBe(false);
        yield* Deferred.succeed(releaseA, undefined);
        yield* Fiber.join(worker);
        expect(yield* Deferred.isDone(completedB)).toBe(true);
      }),
    ),
  );

  it.effect("lets B complete while A and a backlog larger than the worker pool wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const enteredA = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const completedB = yield* Deferred.make<void>();
        const handled = yield* Ref.make<Array<string>>([]);
        const reactor = yield* makeTerminalRunReactor(
          (entry: Item) => entry.threadId,
          (entry) =>
            Effect.gen(function* () {
              if (entry.threadId === "A" && entry.ordinal === 0) {
                yield* Deferred.succeed(enteredA, undefined);
                yield* Deferred.await(releaseA);
              }
              yield* Ref.update(handled, (values) => [
                ...values,
                `${entry.threadId}:${entry.ordinal}`,
              ]);
              if (entry.threadId === "B") yield* Deferred.succeed(completedB, undefined);
            }),
        );
        for (let n = 0; n < TERMINAL_RUN_CONCURRENCY + 2; n++) yield* reactor.enqueue(item("A", n));
        yield* Deferred.await(enteredA);
        yield* reactor.enqueue(item("B"));
        yield* Deferred.await(completedB);
        expect(yield* Ref.get(handled)).toEqual(["B:0"]);
        yield* Deferred.succeed(releaseA, undefined);
        yield* reactor.drain;
        expect(yield* Ref.get(handled)).toEqual([
          "B:0",
          ...Array.from({ length: TERMINAL_RUN_CONCURRENCY + 2 }, (_, n) => `A:${n}`),
        ]);
      }),
    ),
  );

  it.effect("bounds active handlers and releases a worker to the next ready thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        const active = yield* Ref.make(0);
        const max = yield* Ref.make(0);
        const reactor = yield* makeTerminalRunReactor(
          (entry: Item) => entry.threadId,
          (entry) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(active, (n) => n + 1);
              yield* Ref.update(max, (n) => Math.max(n, count));
              yield* Queue.offer(starts, entry.threadId);
              yield* Deferred.await(release);
              yield* Ref.update(active, (n) => n - 1);
            }),
          2,
        );
        yield* reactor.enqueue(item("A"));
        yield* reactor.enqueue(item("B"));
        yield* reactor.enqueue(item("C"));
        yield* Queue.take(starts);
        yield* Queue.take(starts);
        expect(yield* Ref.get(active)).toBe(2);
        yield* Deferred.succeed(release, undefined);
        yield* reactor.drain;
        expect(yield* Queue.take(starts)).toBe("C");
        expect(yield* Ref.get(max)).toBe(2);
      }),
    ),
  );

  it.effect("continues a thread after failure and releases its mailbox for reuse", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completed = yield* Ref.make<Array<number>>([]);
        const reactor = yield* makeTerminalRunReactor(
          (entry: Item) => entry.threadId,
          (entry) =>
            entry.ordinal === 0
              ? Effect.fail("fixture failure")
              : Ref.update(completed, (values) => [...values, entry.ordinal]),
        );
        yield* reactor.enqueue(item("A", 0));
        yield* reactor.enqueue(item("A", 1));
        yield* reactor.drain;
        yield* reactor.enqueue(item("A", 2));
        yield* reactor.drain;
        expect(yield* Ref.get(completed)).toEqual([1, 2]);
      }),
    ),
  );
  it.effect("scope closure interrupts active handlers and drops pending events", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Ref.make(false);
      const reactor = yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* makeTerminalRunReactor(
            (entry: Item) => entry.threadId,
            () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Ref.set(interrupted, true)),
              ),
          );
          yield* reactor.enqueue(item("A"));
          yield* reactor.enqueue(item("A", 1));
          yield* Deferred.await(entered);
          return reactor;
        }),
      );
      expect(yield* Ref.get(interrupted)).toBe(true);
      yield* reactor.enqueue(item("A", 2));
      yield* reactor.drain;
    }),
  );
});
