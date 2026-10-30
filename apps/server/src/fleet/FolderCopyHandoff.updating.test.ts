import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { UPDATING_DETAIL, unlessUpdating } from "./FolderCopyHandoff.ts";

const makeHold = ServiceUpdateHold.makeWithOptions({
  agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
});

it.effect("starts a copy step while the service is not held", () =>
  Effect.gen(function* () {
    const hold = yield* makeHold;
    const started = yield* unlessUpdating(Effect.succeed("started")).pipe(
      Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
    );
    assert.equal(started, "started");
    // Tools and tests without a hold never refuse.
    assert.equal(yield* unlessUpdating(Effect.succeed("alone")), "alone");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a copy step while the service is held for an update", () =>
  Effect.gen(function* () {
    const hold = yield* makeHold;
    yield* hold.acquire({ ttlMs: 60_000 });
    let ran = false;
    const refused = yield* Effect.flip(
      unlessUpdating(Effect.sync(() => (ran = true))).pipe(
        Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
      ),
    );
    assert.isFalse(ran);
    assert.equal(refused._tag, "FolderCopyError");
    assert.equal(refused.code, "refused");
    assert.equal(refused.detail, UPDATING_DETAIL);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a drain waits for a copy step already admitted, so it counts that copy", () =>
  Effect.gen(function* () {
    const hold = yield* makeHold;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const step = yield* unlessUpdating(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
    ).pipe(Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold), Effect.forkScoped);
    yield* Deferred.await(entered);
    assert.isTrue(Option.isSome(yield* hold.acquireIfUnheld(60_000)));
    const fence = yield* hold.awaitAdmissions.pipe(Effect.forkScoped);
    assert.isUndefined(fence.pollUnsafe());
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(step);
    yield* Fiber.join(fence);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
