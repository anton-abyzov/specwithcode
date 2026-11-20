import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as Persistence from "../platform/persistence.ts";
import type { AccountOwners } from "./accountOwners.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { routesFingerprint } from "./registryOwnerSaves.ts";
import { RELAY_TARGET, hasRoutes, makeHarness } from "./registry.testHarness.ts";

// Synthetic accounts and machines only (1434): B saves a machine A still owns.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const refused = (operation: "save-account-owners" | "remove-connection" | "register-connection") =>
  new Persistence.ConnectionPersistenceError({ operation, message: "Fixture: storage refused" });

/** A's machine whose removal at the switch to B keeps failing, so A still owns it. */
const takeoverHarness = (options: {
  readonly refuseNote?: boolean;
  readonly refuseCatalog?: boolean;
}) =>
  makeHarness([RELAY_TARGET], [], [], {
    accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
    beforeRegistrationRemove: () => Effect.fail(refused("remove-connection")),
    beforeOwnersWrite: (owners: AccountOwners) =>
      options.refuseNote === true && owners.saving?.[RELAY]?.owner === B
        ? Effect.fail(refused("save-account-owners"))
        : Effect.void,
    beforeRegistrationRegister: () =>
      options.refuseCatalog === true ? Effect.fail(refused("register-connection")) : Effect.void,
  });

describe("EnvironmentRegistry when B's save of A's machine fails (1434)", () => {
  for (const [name, options] of [
    ["the takeover note is refused", { refuseNote: true }],
    ["the catalog refuses the save", { refuseCatalog: true }],
  ] as const) {
    it.effect(`when ${name}, A keeps the machine and its drafts`, () =>
      Effect.gen(function* () {
        const harness = yield* takeoverHarness(options);
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.setAccount(B);
          const clearsAfterSwitch = (yield* Ref.get(harness.ownedDataClears)).length;

          const saved = yield* registry
            .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
              forAccount: B,
            })
            .pipe(Effect.exit);

          expect(saved._tag).toBe("Failure");
          expect((yield* Ref.get(harness.ownedDataClears)).length).toBe(clearsAfterSwitch);
          const owners = yield* Ref.get(harness.storedOwners);
          expect(owners?.machines[RELAY]).toBe(A);
          expect(owners?.saving).toBeUndefined();
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
    );
  }

  it.effect("a takeover that landed before the app stopped clears A's data when it settles", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: {
          lastAccount: A,
          machines: { [RELAY]: A },
          saving: {
            [RELAY]: { owner: B, fingerprint: routesFingerprint([RELAY_TARGET]), takes: true },
          },
        },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);

        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([RELAY]);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [RELAY]: B },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a takeover that never landed settles as A's and leaves with A", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: {
          lastAccount: A,
          machines: { [RELAY]: A },
          saving: { [RELAY]: { owner: B, fingerprint: "routes-that-never-landed", takes: true } },
        },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // A signs back in first: the machine and its drafts are still A's.
        yield* registry.setAccount(A);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [RELAY]: A },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
