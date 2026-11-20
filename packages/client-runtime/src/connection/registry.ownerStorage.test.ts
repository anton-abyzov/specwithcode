import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as Persistence from "../platform/persistence.ts";
import type { AccountOwners } from "./accountOwners.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { RELAY_TARGET, TARGET, hasRoutes, makeHarness } from "./registry.testHarness.ts";

// Synthetic accounts and machines only (1434): when the window's owner storage refuses writes.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const MACHINE = TARGET.environmentId;
const refused = new Persistence.ConnectionPersistenceError({
  operation: "save-account-owners",
  message: "Fixture: local storage refused the owner record",
});

describe("EnvironmentRegistry when owner storage refuses writes (1434)", () => {
  it.effect("B's save whose owner could not be stored is not removed by B's own cleanup", () =>
    Effect.gen(function* () {
      const firstRemoving = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const harness = yield* makeHarness([RELAY_TARGET, TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A, [MACHINE]: A } },
        beforeRegistrationRemove: (environmentId) =>
          // Machines are removed in id order: this one goes first.
          environmentId === MACHINE
            ? Deferred.succeed(firstRemoving, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
            : Effect.void,
        // The finish of B's save is refused; its note was stored.
        beforeOwnersWrite: (owners: AccountOwners) =>
          owners.machines[RELAY] === B ? Effect.fail(refused) : Effect.void,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const switching = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* Deferred.await(firstRemoving);
        // B saves the second machine again while the first is being removed.
        const save = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: B })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(save);
        yield* Fiber.join(switching);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, MACHINE)).toBe(false);
        expect(hasRoutes(targets, RELAY)).toBe(true);
        // A's cached data went when B took the machine; the cleanup did not remove B's save.
        expect((yield* Ref.get(harness.cacheClears)).includes(RELAY)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("with no owner record yet and storage refusing it, a save does not go ahead", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        accountOwners: null,
        beforeOwnersWrite: () => Effect.fail(refused),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        const saved = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: A })
          .pipe(Effect.exit);

        expect(saved._tag).toBe("Failure");
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save before the account settles leaves an earlier session's note alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: {
          lastAccount: A,
          machines: { [RELAY]: A },
          // B's save of another route set never reached the catalog.
          saving: { [RELAY]: { owner: B, fingerprint: "routes-that-never-landed" } },
        },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        expect((yield* Ref.get(harness.storedOwners))?.saving?.[RELAY]?.owner).toBe(B);

        // The note never reached the catalog for certain: A keeps it, and it leaves with A.
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
