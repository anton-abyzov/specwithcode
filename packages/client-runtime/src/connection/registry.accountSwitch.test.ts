import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { RelayConnectionRegistration } from "./catalog.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  SSH_CONNECTION,
  SSH_PROFILE,
  hasRoutes,
  makeHarness,
} from "./registry.testHarness.ts";

// Synthetic accounts only: nothing here reaches a real Connect account or machine.
describe("EnvironmentRegistry account switch", () => {
  it.effect("a Connect save started before the cleanup does not outlive it", () =>
    Effect.gen(function* () {
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforeRegistrationRegister: (registration) =>
          registration.target.environmentId === SECOND_RELAY_TARGET.environmentId
            ? Deferred.succeed(saveStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSave)),
              )
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // Account A's late answer: a Connect route save that is still being written.
        const lateSave = yield* registry
          .register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }))
          .pipe(Effect.forkChild);
        yield* Deferred.await(saveStarted);

        // The switch to account B removes every Connect route.
        yield* registry.removeRelayEnvironments();
        yield* Deferred.succeed(releaseSave, undefined);
        yield* Fiber.join(lateSave);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY_TARGET.environmentId)).toBe(false);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("the new account's save right after a late one is kept", () =>
    Effect.gen(function* () {
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const held = yield* Ref.make(true);
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforeRegistrationRegister: (registration) =>
          Effect.gen(function* () {
            if (registration.target.environmentId !== SECOND_RELAY_TARGET.environmentId) return;
            if (!(yield* Ref.getAndSet(held, false))) return;
            yield* Deferred.succeed(saveStarted, undefined);
            yield* Deferred.await(releaseSave);
          }),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const lateSave = yield* registry
          .register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }))
          .pipe(Effect.forkChild);
        yield* Deferred.await(saveStarted);
        yield* registry.removeRelayEnvironments();
        // Account B saves the same machine while A's save is still being written.
        const newSave = yield* registry
          .register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }))
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseSave, undefined);
        yield* Fiber.join(lateSave);
        yield* Fiber.join(newSave);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("one failed removal does not stop the others", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET], [], [], {
        beforeRegistrationRemove: (environmentId) =>
          environmentId === RELAY_TARGET.environmentId
            ? Effect.die(new Error("Fixture storage failure"))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments().pipe(Effect.exit);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("forgetting a machine on this window never stops its SSH server", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.remove(SSH_CONNECTION.environmentId, { keepRemote: true });

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, SSH_CONNECTION.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([SSH_CONNECTION.environmentId]);
        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a late save whose undo fails is still removed after the lock", () =>
    Effect.gen(function* () {
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const failNextRemove = yield* Ref.make(true);
      const harness = yield* makeHarness([], [], [], {
        beforeRegistrationRegister: () =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
          ),
        beforeRegistrationRemove: () =>
          Ref.getAndSet(failNextRemove, false).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new Persistence.ConnectionPersistenceError({
                      operation: "remove-connection",
                      message: "Fixture storage refused the undo",
                    }),
                  )
                : Effect.void,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const lateSave = yield* registry
          .register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }))
          .pipe(Effect.forkChild);
        yield* Deferred.await(saveStarted);
        yield* registry.removeRelayEnvironments();
        yield* Deferred.succeed(releaseSave, undefined);
        yield* Fiber.join(lateSave);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
