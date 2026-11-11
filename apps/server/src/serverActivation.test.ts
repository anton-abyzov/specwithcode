import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerActivation from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* ServerActivation.forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

const makeParkedLaunch = Effect.gen(function* () {
  const activation = yield* Deferred.make<void>();
  const parked = yield* Deferred.make<void>();
  const steps = yield* Ref.make<ReadonlyArray<string>>([]);
  const step = (name: string) => Ref.update(steps, (current) => [...current, name]);
  // The shape of the server's runtime-state and Tailscale Serve layers.
  const launch = Layer.launch(
    Layer.effectDiscard(
      ServerActivation.parkUntilActivation(parked, Deferred.await(activation)).pipe(
        Effect.andThen(Effect.acquireRelease(step("acquired"), () => step("released"))),
      ),
    ),
  );
  return { activation, parked, steps, launch };
});

it.effect("a stop signal ends a launch that is still parked before activation", () =>
  Effect.gen(function* () {
    const { parked, steps, launch } = yield* makeParkedLaunch;
    const fiber = yield* Effect.forkChild(launch);
    yield* Deferred.await(parked);

    // The server's SIGTERM handler interrupts the launch. With the wait inside the acquire this
    // never returned, and the process outlived its stop signal.
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(steps)).toEqual([]);
  }),
);

it.effect("an activated launch acquires once and releases when it is stopped", () =>
  Effect.gen(function* () {
    const { activation, parked, steps, launch } = yield* makeParkedLaunch;
    const fiber = yield* Effect.forkChild(launch);
    yield* Deferred.await(parked);
    expect(yield* Ref.get(steps)).toEqual([]);

    yield* Deferred.succeed(activation, undefined);
    yield* Effect.yieldNow.pipe(
      Effect.repeat({
        until: () => Ref.get(steps).pipe(Effect.map((current) => current.length > 0)),
      }),
    );
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(steps)).toEqual(["acquired", "released"]);
  }),
);
