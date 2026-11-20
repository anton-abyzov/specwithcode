import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as Persistence from "../platform/persistence.ts";
import type { AccountOwners } from "./accountOwners.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import { RelayConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { RELAY_TARGET, TARGET, hasRoutes, makeHarness } from "./registry.testHarness.ts";

// Synthetic accounts and machines only (1434): B saves a machine A still owns
// because its removal at the switch failed. The switch's removal is finished
// first, then B's save adds the machine as new.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const MACHINE = TARGET.environmentId;
// A second route to A's direct machine.
const MACHINE_RELAY = new RelayConnectionTarget({ environmentId: MACHINE, label: "Test relay" });
const refused = (operation: "save-account-owners" | "remove-connection" | "register-connection") =>
  new Persistence.ConnectionPersistenceError({ operation, message: "Fixture: storage refused" });

/** Fails the first catalog removal of each machine, so A still owns it after the switch. */
const failFirstRemoval = (failed: Ref.Ref<ReadonlySet<string>>) => (environmentId: string) =>
  Ref.modify(failed, (ids) => [ids.has(environmentId), new Set(ids).add(environmentId)]).pipe(
    Effect.flatMap((seen) => (seen ? Effect.void : Effect.fail(refused("remove-connection")))),
  );

describe("EnvironmentRegistry when B saves a machine A still owns (1434)", () => {
  it.effect("B's machine holds only B's route, never A's other routes", () =>
    Effect.gen(function* () {
      const failed = yield* Ref.make<ReadonlySet<string>>(new Set());
      const harness = yield* makeHarness([TARGET, MACHINE_RELAY], [], [], {
        accountOwners: { lastAccount: A, machines: { [MACHINE]: A } },
        beforeRegistrationRemove: failFirstRemoval(failed),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), MACHINE)).toBe(true);

        yield* registry.register(new RelayConnectionRegistration({ target: MACHINE_RELAY }), {
          forAccount: B,
        });

        const routes = (yield* Ref.get(harness.storedTargets)).filter(
          (target) => target.environmentId === MACHINE,
        );
        expect(routes.map((target) => target._tag)).toEqual(["RelayConnectionTarget"]);
        expect(yield* Ref.get(harness.ownedDataClears)).toContain(MACHINE);
        expect((yield* Ref.get(harness.storedOwners))?.machines[MACHINE]).toBe(B);
        // Recorded as the switch does, so automatic pairing leaves it.
        expect(yield* Ref.get(harness.forgottenMachines)).toContain(MACHINE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  for (const [name, refuse] of [
    ["the owner note is refused", "note"],
    ["the catalog refuses the save", "catalog"],
  ] as const) {
    it.effect(`when ${name}, A's machine is gone as the switch intended and B has nothing`, () =>
      Effect.gen(function* () {
        const failed = yield* Ref.make<ReadonlySet<string>>(new Set());
        const harness = yield* makeHarness([RELAY_TARGET], [], [], {
          accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
          beforeRegistrationRemove: failFirstRemoval(failed),
          beforeOwnersWrite: (owners: AccountOwners) =>
            refuse === "note" && owners.saving?.[RELAY]?.owner === B
              ? Effect.fail(refused("save-account-owners"))
              : Effect.void,
          beforeRegistrationRegister: () =>
            refuse === "catalog" ? Effect.fail(refused("register-connection")) : Effect.void,
        });
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.setAccount(B);
          const saved = yield* registry
            .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
              forAccount: B,
            })
            .pipe(Effect.exit);

          expect(saved._tag).toBe("Failure");
          expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
          // Nothing of A's is left for B, and A's machine is not recorded as B's.
          expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).not.toBe(B);
          expect((yield* Ref.get(harness.storedOwners))?.saving).toBeUndefined();
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
    );
  }

  it.effect("a Connect sign-out during B's save leaves no entry, not A's routes put back", () =>
    Effect.gen(function* () {
      const failed = yield* Ref.make<ReadonlySet<string>>(new Set());
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
        beforeRegistrationRemove: failFirstRemoval(failed),
        beforeRegistrationRegister: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        const save = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: B })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        const signOut = yield* registry.removeRelayEnvironments().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(save);
        yield* Fiber.join(signOut);

        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
        // A's leftover owner line names no saved machine; the next plan prunes it.
        expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).not.toBe(B);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("an owner recorded for a machine that is no longer saved does not stop a save", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
        expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).toBe(B);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save cut short mid-session waits for the next start to settle", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: B, machines: {} },
        // The catalog write stops with a defect: no typed failure cancels the note.
        beforeRegistrationRegister: () => Effect.die("Fixture: the write stopped"),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: B })
          .pipe(Effect.exit);
        // A later plan in this session, against entries that may lag the
        // catalog, leaves the note for the next start.
        yield* registry.setAccount(A);
        expect((yield* Ref.get(harness.storedOwners))?.saving?.[RELAY]?.owner).toBe(B);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save interrupted during its catalog write still records its owner", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: {} },
        beforeRegistrationRegister: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        const save = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: A })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        const interrupting = yield* Fiber.interrupt(save).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);

        // Owned by A, so B's switch removes it.
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [RELAY]: A },
        });
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
