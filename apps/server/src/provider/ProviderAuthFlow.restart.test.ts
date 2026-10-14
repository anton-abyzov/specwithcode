import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";

const instanceId = ProviderInstanceId.make("restart-fixture");
const method = { id: "terminal", name: "Terminal", type: "terminal" as const, description: null };
// Represents adapter-owned persistence. No native token store or filesystem is accessed.
const persistence = () => ({ credential: "existing-fixture-credential", logoutCalls: 0 });
const makeHarness = (saved: ReturnType<typeof persistence>, holdCleanup = false) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finishAuthentication = yield* Deferred.make<void>();
    const cleanupStarted = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    const cleanupFinished = yield* Deferred.make<void>();
    let starts = 0;
    const responses: string[] = [];
    const controller = yield* ProviderAuthFlow.make({
      instanceId,
      credentialBinding: { owner: "provider", key: "restart-fixture-binding" },
      methods: Effect.succeed([method]),
      authenticate: (_, context) =>
        Effect.gen(function* () {
          starts++;
          // An owned unfinished process with a drainable scoped finalizer.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(cleanupStarted, undefined);
              if (holdCleanup) yield* Deferred.await(releaseCleanup);
              yield* Deferred.succeed(cleanupFinished, undefined);
            }),
          );
          yield* context.setInteraction(
            { type: "terminal", id: "terminal", output: "Waiting for consent" },
            (response) =>
              Effect.sync(() => {
                if (response.type === "terminal") responses.push(response.data);
              }),
          );
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finishAuthentication);
        }),
      logout: Effect.sync(() => {
        saved.logoutCalls++;
        saved.credential = "";
      }),
    });
    const phase = (value: ProviderAuthState["phase"]) =>
      controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === value),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    return {
      controller,
      entered,
      finishAuthentication,
      cleanupStarted,
      releaseCleanup,
      cleanupFinished,
      phase,
      responses,
      starts: () => starts,
    };
  });

it.effect(
  "service disposal drains unfinished authentication; replacement starts a fresh flow without signing out",
  () =>
    Effect.gen(function* () {
      const saved = persistence();
      const oldScope = yield* Scope.make();
      const previous = yield* makeHarness(saved, true).pipe(
        Effect.provideService(Scope.Scope, oldScope),
      );
      const oldFlow = yield* previous.controller.start("owner");
      yield* Deferred.await(previous.entered);
      const oldResponse = {
        instanceId,
        flowId: oldFlow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal" as const, data: "old-response" },
      };

      const closing = yield* Scope.close(oldScope, Exit.void).pipe(Effect.forkChild);
      yield* Deferred.await(previous.cleanupStarted);
      const beforeCleanupFinished = closing.pollUnsafe();
      yield* Deferred.succeed(previous.releaseCleanup, undefined);
      yield* Fiber.join(closing);
      assert.isUndefined(beforeCleanupFinished);
      assert.isTrue(yield* Deferred.isDone(previous.cleanupFinished));
      assert.strictEqual(
        (yield* previous.controller.start("owner").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* previous.controller.respond!("owner", oldResponse).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(previous.responses, []);
      assert.deepEqual(saved, { credential: "existing-fixture-credential", logoutCalls: 0 });

      const newScope = yield* Scope.make();
      const replacement = yield* makeHarness(saved).pipe(
        Effect.provideService(Scope.Scope, newScope),
      );
      const idle = yield* replacement.phase("idle");
      assert.isNull(idle.flowId);
      assert.isNull(idle.interaction);
      assert.strictEqual(replacement.starts(), 0);
      const newFlow = yield* replacement.controller.start("owner");
      yield* Deferred.await(replacement.entered);
      assert.notStrictEqual(newFlow.flowId, oldFlow.flowId);
      assert.strictEqual(replacement.starts(), 1);
      assert.strictEqual(
        (yield* replacement.controller.respond!("owner", oldResponse).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* replacement.controller.respond!("owner", {
        ...oldResponse,
        flowId: newFlow.flowId!,
        response: { type: "terminal", data: "new-response" },
      });
      assert.deepEqual(replacement.responses, ["new-response"]);
      yield* Deferred.succeed(replacement.finishAuthentication, undefined);
      yield* replacement.phase("succeeded");
      yield* Scope.close(newScope, Exit.void);
      assert.isTrue(yield* Deferred.isDone(replacement.cleanupFinished));
      assert.deepEqual(saved, { credential: "existing-fixture-credential", logoutCalls: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "disconnecting and resubscribing the same owner preserves a running flow without granting another client access",
  () =>
    Effect.gen(function* () {
      const saved = persistence();
      const harness = yield* makeHarness(saved);
      const started = yield* harness.controller.start("owner");
      yield* Deferred.await(harness.entered);
      const observed = yield* Deferred.make<void>();
      const subscriber = yield* harness.controller.subscribe("owner").pipe(
        Stream.tap(() => Deferred.succeed(observed, undefined)),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(observed);
      yield* Fiber.interrupt(subscriber);
      assert.isFalse(yield* Deferred.isDone(harness.cleanupStarted));
      const reconnected = yield* harness.phase("waiting");
      assert.strictEqual(reconnected.flowId, started.flowId);
      assert.strictEqual(reconnected.interaction?.type, "terminal");
      assert.strictEqual((yield* harness.controller.start("owner")).flowId, started.flowId);
      assert.strictEqual(harness.starts(), 1);
      const other = yield* harness.controller
        .subscribe("different-owner")
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.isNull(other.flowId);
      assert.isNull(other.interaction);
      assert.strictEqual(
        (yield* harness.controller.start("different-owner").pipe(Effect.result))._tag,
        "Failure",
      );
      yield* harness.controller.cancel("owner", started.flowId!);
      assert.isTrue(yield* Deferred.isDone(harness.cleanupFinished));
      assert.deepEqual(saved, { credential: "existing-fixture-credential", logoutCalls: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
