import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerActivation from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as Scheduler from "./Scheduler.ts";

it.effect("keeps other sources running after a source defects", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const receipts = yield* Queue.unbounded<string>();
    yield* scheduler.register(
      "broken",
      Queue.offer(receipts, "broken").pipe(Effect.andThen(Effect.die("fixture failure"))),
    );
    yield* scheduler.register("healthy", Queue.offer(receipts, "healthy").pipe(Effect.asVoid));
    for (let tick = 0; tick < 3; tick += 1) {
      if (tick > 0) yield* TestClock.adjust("5 seconds");
      assert.deepEqual([yield* Queue.take(receipts), yield* Queue.take(receipts)].sort(), [
        "broken",
        "healthy",
      ]);
    }
  }).pipe(Effect.provide(Scheduler.layer)),
);

it.effect("does not overlap slow work or hold up another source", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const runs = yield* Ref.make(0);
    const receipts = yield* Queue.unbounded<void>();
    yield* scheduler.register(
      "slow",
      Ref.update(runs, (n) => n + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    );
    yield* scheduler.register("healthy", Queue.offer(receipts, undefined).pipe(Effect.asVoid));
    yield* Deferred.await(started);
    yield* Queue.take(receipts);
    yield* TestClock.adjust("10 seconds");
    yield* Queue.take(receipts);
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 1);
    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 2);
  }).pipe(Effect.provide(Scheduler.layer)),
);

it.effect("unregisters closed sources and interrupts their in-flight work", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const runs = yield* Ref.make(0);
    const registration = yield* Effect.scoped(
      scheduler
        .register(
          "scoped",
          Ref.update(runs, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        )
        .pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(registration);
    yield* Deferred.await(stopped);
    const receipts = yield* Queue.unbounded<void>();
    yield* scheduler.register("remaining", Queue.offer(receipts, undefined).pipe(Effect.asVoid));
    yield* Queue.take(receipts);
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 1);
  }).pipe(Effect.provide(Scheduler.layer)),
);

it.effect("holds due work and the clock until startup recovery activates the server", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const runs = yield* Ref.make(0);
    const ran = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      yield* scheduler.register(
        "due",
        Ref.update(runs, (n) => n + 1).pipe(Effect.andThen(Deferred.succeed(ran, undefined))),
      );
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Ref.get(runs), 0);
      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
    }).pipe(
      Effect.provide(Scheduler.layer),
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
    );
    assert.isAtLeast(yield* Ref.get(runs), 1);
  }),
);

it.effect("records how long it sat out an update hold", () =>
  Effect.gen(function* () {
    const startMs = Date.parse("2026-07-01T08:50:00.000Z");
    yield* TestClock.setTime(startMs);
    const hold = yield* ServiceUpdateHold.makeWithOptions({
      agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
    });
    yield* hold.acquire({ ttlMs: 60 * 60_000 });
    const ranAt = yield* Queue.unbounded<number>();
    yield* Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      yield* scheduler.register(
        "due",
        Effect.flatMap(Clock.currentTimeMillis, (now) => Queue.offer(ranAt, now)).pipe(
          Effect.asVoid,
        ),
      );
      yield* TestClock.adjust("30 minutes");
      assert.isTrue(Option.isNone(yield* Queue.poll(ranAt)));
      yield* hold.release("test");
      yield* TestClock.adjust("5 seconds");
      const resumedMs = yield* Queue.take(ranAt);
      const heldMsBetween = scheduler.heldMsBetween;
      if (heldMsBetween === undefined) return assert.fail("heldMsBetween is missing");
      // From the registration it skipped to the first tick after the release.
      assert.equal(yield* heldMsBetween(startMs, resumedMs), resumedMs - startMs);
      // A slot at 09:00 waited 20 minutes and 5 seconds, all of it held.
      const slotMs = Date.parse("2026-07-01T09:00:00.000Z");
      assert.equal(yield* heldMsBetween(slotMs, resumedMs), resumedMs - slotMs);
      // Time after the hold is not held.
      assert.equal(yield* heldMsBetween(resumedMs, resumedMs + 60_000), 0);
    }).pipe(
      Effect.provide(Scheduler.layer),
      Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("spreads the sources across each tick instead of starting them together", () =>
  Effect.gen(function* () {
    const ranAt = yield* Queue.unbounded<readonly [string, number]>();
    yield* Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const record = (name: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Queue.offer(ranAt, [name, now] as const),
        ).pipe(Effect.asVoid);
      const startMs = yield* Clock.currentTimeMillis;
      for (const name of ["provider-fallback", "usage-limit-recovery", "scheduled-tasks"]) {
        yield* scheduler.register(name, record(name));
      }
      // Registration runs each source once, straight away, and the tick that
      // was already counting when they registered runs them all at its end.
      for (let index = 0; index < 6; index += 1) {
        if (index === 3) yield* TestClock.adjust("5 seconds");
        yield* Queue.take(ranAt);
      }
      for (let tick = 1; tick <= 2; tick += 1) {
        yield* TestClock.adjust("5 seconds");
        const runs = [yield* Queue.take(ranAt), yield* Queue.take(ranAt), yield* Queue.take(ranAt)];
        const offsets = runs.map(([, at]) => at - startMs - tick * 5_000);
        assert.deepEqual(
          runs.map(([name]) => name),
          ["provider-fallback", "usage-limit-recovery", "scheduled-tasks"],
        );
        assert.deepEqual(offsets, [1_666, 3_332, 4_998]);
      }
    }).pipe(Effect.provide(Scheduler.layer));
  }),
);
