import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

const layerOutbox = Layer.fresh(
  EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

const workerLayerFor = (
  outbox: EffectOutbox.EffectOutboxV2Shape,
  execute: EffectWorker.OrchestrationEffectExecutorV2Shape["execute"],
  workerId: string,
) =>
  EffectWorker.layerWithOptions({ workerId }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
        Layer.succeed(
          EffectWorker.OrchestrationEffectExecutorV2,
          EffectWorker.OrchestrationEffectExecutorV2.of({ execute }),
        ),
      ),
    ),
  );

const turnStart = (key: string, thread: string, index: number) => ({
  id: `effect:${key}:${thread}:${index}`,
  commandId: CommandId.make(`command:${key}:${thread}:${index}`),
  threadId: ThreadId.make(`thread:${key}:${thread}`),
  request: {
    type: "provider-turn.start" as const,
    runId: RunId.make(`run:${key}:${thread}:${index}`),
  },
});

const titleGeneration = (key: string, thread: string) => ({
  id: `effect:${key}:${thread}:title`,
  commandId: CommandId.make(`command:${key}:${thread}:title`),
  threadId: ThreadId.make(`thread:${key}:${thread}`),
  request: {
    type: "thread-title.generate" as const,
    kind: { type: "initial" as const, messageId: MessageId.make(`message:${key}:${thread}`) },
  },
});

const statusOf = (outbox: EffectOutbox.EffectOutboxV2Shape, effectId: string) =>
  outbox.get(effectId).pipe(Effect.map(Option.map((effect) => effect.status)));

it.effect("keeps other threads' effects running while provider calls never return", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const key = "effect-slots-hung-provider";
    const hungA = turnStart(key, "a", 1);
    const hungB = turnStart(key, "b", 1);
    const laterA = turnStart(key, "a", 2);
    const otherThread = turnStart(key, "c", 1);
    const started = new Map(
      yield* Effect.forEach([hungA, hungB, laterA, otherThread], (effect) =>
        Deferred.make<void>().pipe(Effect.map((deferred) => [effect.id, deferred] as const)),
      ),
    );
    const startedFor = (effectId: string) => {
      const deferred = started.get(effectId);
      if (deferred === undefined) throw new Error(`Missing start signal for ${effectId}`);
      return deferred;
    };
    const execute = (effect: EffectOutbox.OrchestrationEffectV2) =>
      Deferred.succeed(startedFor(effect.id), undefined).pipe(
        Effect.andThen(
          effect.id === hungA.id || effect.id === hungB.id ? Effect.never : Effect.void,
        ),
      );

    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
      yield* outbox.enqueue([hungA, hungB]);
      yield* outbox.notifyAvailable(2);
      yield* Deferred.await(startedFor(hungA.id));
      yield* Deferred.await(startedFor(hungB.id));

      // Both slots now hold a provider call that will never answer.
      yield* outbox.enqueue([laterA, otherThread]);
      yield* outbox.notifyAvailable(2);

      const other = yield* Deferred.await(startedFor(otherThread.id)).pipe(
        Effect.timeoutOption("1 hour"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 hour");
      assert.isTrue(
        Option.isSome(yield* Fiber.join(other)),
        "another thread's effect never ran while every slot held a hung provider call",
      );
      assert.deepStrictEqual(yield* statusOf(outbox, otherThread.id), Option.some("succeeded"));

      // A hung call still blocks the later effects of its own thread.
      assert.isFalse(yield* Deferred.isDone(startedFor(laterA.id)));
      assert.deepStrictEqual(yield* statusOf(outbox, hungA.id), Option.some("running"));
      assert.deepStrictEqual(yield* statusOf(outbox, laterA.id), Option.some("pending"));
    }).pipe(Effect.provide(workerLayerFor(outbox, execute, `${key}-worker`)), Effect.scoped);
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect("caps running title generations below the worker count", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const key = "effect-slots-title-cap";
    const titles = ["a", "b", "c", "d"].map((thread) => titleGeneration(key, thread));
    const turn = turnStart(key, "turn", 1);
    const gates = new Map(
      yield* Effect.forEach([...titles, turn], (effect) =>
        Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }).pipe(
          Effect.map((gate) => [effect.id, gate] as const),
        ),
      ),
    );
    const gateFor = (effectId: string) => {
      const gate = gates.get(effectId);
      if (gate === undefined) throw new Error(`Missing gate for ${effectId}`);
      return gate;
    };
    const execute = (effect: EffectOutbox.OrchestrationEffectV2) => {
      const gate = gateFor(effect.id);
      return Deferred.succeed(gate.started, undefined).pipe(
        Effect.andThen(
          effect.request.type === "thread-title.generate"
            ? Deferred.await(gate.release)
            : Effect.void,
        ),
      );
    };
    const [first, second, third, fourth] = titles;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return assert.fail("expected four title generations");
    }

    yield* Effect.gen(function* () {
      // The default daemon runs four workers.
      yield* EffectWorker.runDaemonWithOptions().pipe(Effect.forkScoped);
      yield* outbox.enqueue(titles);
      yield* outbox.notifyAvailable(titles.length);
      yield* Deferred.await(gateFor(first.id).started);
      yield* Deferred.await(gateFor(second.id).started);
      yield* Deferred.await(gateFor(third.id).started);
      // Let every idle worker attempt a claim before checking the fourth title.
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      assert.isFalse(
        yield* Deferred.isDone(gateFor(fourth.id).started),
        "a fourth title generation took the last effect worker",
      );
      assert.deepStrictEqual(yield* statusOf(outbox, fourth.id), Option.some("pending"));

      // Turn work still gets the free worker without waiting on any timer.
      yield* outbox.enqueue([turn]);
      yield* outbox.notifyAvailable();
      yield* Deferred.await(gateFor(turn.id).started);

      // The waiting title generation runs once a running one finishes.
      yield* Deferred.succeed(gateFor(first.id).release, undefined);
      yield* Deferred.await(gateFor(fourth.id).started);
      for (const title of titles) yield* Deferred.succeed(gateFor(title.id).release, undefined);
    }).pipe(Effect.provide(workerLayerFor(outbox, execute, `${key}-worker`)), Effect.scoped);
  }).pipe(Effect.provide(layerOutbox)),
);
