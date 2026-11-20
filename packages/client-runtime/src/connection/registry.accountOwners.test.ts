import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { RelayConnectionRegistration } from "./catalog.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  BEARER_PROFILE,
  BEARER_TARGET,
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  SSH_CONNECTION,
  SSH_PROFILE,
  hasRoutes,
  makeHarness,
} from "./registry.testHarness.ts";

// Synthetic accounts only: nothing here reaches a real Connect account or machine.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const RELAY_2 = SECOND_RELAY_TARGET.environmentId;
const BEARER = BEARER_TARGET.environmentId;
const SSH = SSH_CONNECTION.environmentId;

const storageFailure = new Persistence.ConnectionPersistenceError({
  operation: "remove-connection",
  message: "Fixture storage refused the removal",
});

describe("EnvironmentRegistry account owners (1434)", () => {
  it.effect("a switch forgets the previous account's machines and keeps signed-out ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [RELAY_TARGET, BEARER_TARGET, SSH_CONNECTION],
        [BEARER_PROFILE, SSH_PROFILE],
        [],
        { accountOwners: { lastAccount: A, machines: { [RELAY]: A, [BEARER]: "", [SSH]: "?" } } },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(false);
        expect(hasRoutes(targets, SSH)).toBe(false);
        expect(hasRoutes(targets, BEARER)).toBe(true);
        expect([...(yield* Ref.get(harness.forgottenMachines))].sort()).toEqual(
          [RELAY, SSH].sort(),
        );
        // Forgotten on this client only: the SSH server on the other host keeps running.
        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([]);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [BEARER]: "" },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("signing in for the first time, or signing out, forgets nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: null,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        yield* registry.setAccount(null);
        // Saved while signed out: it stays through the next switch.
        yield* registry.register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }));
        yield* registry.setAccount(A);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(true);
        expect(hasRoutes(targets, RELAY_2)).toBe(true);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [RELAY]: "?", [RELAY_2]: "" },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("an automatic save started for the account that left is not kept", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: {} },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        // A's pairing answers after the switch to B.
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: A,
        });
        // B's own save is kept, and is B's.
        yield* registry.register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }), {
          forAccount: B,
        });

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(false);
        expect(hasRoutes(targets, RELAY_2)).toBe(true);
        expect((yield* Ref.get(harness.storedOwners))?.machines).toEqual({ [RELAY_2]: B });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save held across the switch is checked under the lease, then forgotten", () =>
    Effect.gen(function* () {
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: {} },
        beforeRegistrationRegister: () =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
          ),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        const held = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: A })
          .pipe(Effect.forkChild);
        yield* Deferred.await(saveStarted);
        // The switch waits for the save that is being written, then forgets it.
        const switching = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseSave, undefined);
        yield* Fiber.join(held);
        yield* Fiber.join(switching);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(false);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({ lastAccount: B, machines: {} });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a machine the new account saves again is its own, even within moments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });
        // Settling the same account again keeps it.
        yield* registry.setAccount(B);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(true);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [RELAY]: B },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "a removal that fails is owed: the previous account stays until a restart finishes",
    () =>
      Effect.gen(function* () {
        const failing = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET], [], [], {
          accountOwners: { lastAccount: A, machines: { [RELAY]: A, [RELAY_2]: A } },
          beforeRegistrationRemove: (environmentId) =>
            environmentId === RELAY ? Effect.fail(storageFailure) : Effect.void,
        });
        const afterFailure = yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.setAccount(B);
          // Settling B again in the same session does not retry it.
          yield* registry.setAccount(B);
          return yield* Ref.get(failing.storedOwners);
        }).pipe(Effect.provide(failing.layer), Effect.scoped);
        expect(afterFailure).toEqual({ lastAccount: A, machines: { [RELAY]: A } });
        expect(hasRoutes(yield* Ref.get(failing.storedTargets), RELAY_2)).toBe(false);

        // The next start, storage working again.
        const restarted = yield* makeHarness(yield* Ref.get(failing.storedTargets), [], [], {
          accountOwners: afterFailure,
        });
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.setAccount(B);
          expect(hasRoutes(yield* Ref.get(restarted.storedTargets), RELAY)).toBe(false);
          expect(yield* Ref.get(restarted.storedOwners)).toEqual({ lastAccount: B, machines: {} });
        }).pipe(Effect.provide(restarted.layer), Effect.scoped);
      }),
  );

  it.effect("a removal planned for B never runs once the account is A again", () =>
    Effect.gen(function* () {
      const removalStarted = yield* Deferred.make<void>();
      const releaseRemoval = yield* Deferred.make<void>();
      const harness = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A, [RELAY_2]: A } },
        beforeRegistrationRemove: (environmentId) =>
          environmentId === RELAY
            ? Deferred.succeed(removalStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRemoval)),
              )
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const toB = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* Deferred.await(removalStarted);
        // Back to A while B's first removal is still being written.
        const toA = yield* registry.setAccount(A).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseRemoval, undefined);
        yield* Fiber.join(toB);
        yield* Fiber.join(toA);

        const targets = yield* Ref.get(harness.storedTargets);
        // The first was already going; the second is never touched.
        expect(hasRoutes(targets, RELAY)).toBe(false);
        expect(hasRoutes(targets, RELAY_2)).toBe(true);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [RELAY_2]: A },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
  it.effect("a machine the new account saves while the cleanup runs is not removed by it", () =>
    Effect.gen(function* () {
      const firstRemoving = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const harness = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A, [RELAY_2]: A } },
        beforeRegistrationRemove: (environmentId) =>
          environmentId === RELAY
            ? Deferred.succeed(firstRemoving, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const switching = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* Deferred.await(firstRemoving);
        // B saves the second machine while the first is still being removed.
        const save = yield* registry
          .register(new RelayConnectionRegistration({ target: SECOND_RELAY_TARGET }), {
            forAccount: B,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(save);
        yield* Fiber.join(switching);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(false);
        expect(hasRoutes(targets, RELAY_2)).toBe(true);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [RELAY_2]: B },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
