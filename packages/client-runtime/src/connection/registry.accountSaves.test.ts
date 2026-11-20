import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import type { AccountOwners } from "./accountOwners.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import { make as makeOnboarding } from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { routesFingerprint } from "./registryOwnerSaves.ts";
import {
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  SSH_TARGET,
  TARGET,
  hasRoutes,
  makeHarness,
} from "./registry.testHarness.ts";

// Synthetic accounts and machines only (1434): nothing reaches Connect or a real host.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const MACHINE = TARGET.environmentId;
const RELAY_2 = SECOND_RELAY_TARGET.environmentId;

describe("EnvironmentRegistry saves and removals across an account switch (1434)", () => {
  it.effect("an SSH machine added under A and answered after the switch to B is not saved", () =>
    Effect.gen(function* () {
      const provisioning = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const harness = yield* makeHarness([], [], [], {
        surface: "desktop",
        accountOwners: { lastAccount: A, machines: {} },
      });
      const gateway = ClientCapabilities.SshEnvironmentGateway.of({
        provision: () =>
          Deferred.succeed(provisioning, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as({
              environmentId: MACHINE,
              label: TARGET.label,
              bootstrap: {
                target: SSH_TARGET,
                httpBaseUrl: "http://127.0.0.1:3201",
                wsBaseUrl: "ws://127.0.0.1:3201",
                pairingToken: "pairing-token",
              },
              bearerToken: "bearer-token",
            }),
          ),
        prepare: () => Effect.die("unused"),
        disconnect: () => Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* makeOnboarding.pipe(
          Effect.provideService(ClientCapabilities.SshEnvironmentGateway, gateway),
          Effect.provideService(
            ClientCapabilities.ClientPresentation,
            ClientCapabilities.ClientPresentation.of({ metadata: { surface: "desktop" } }),
          ),
          Effect.provideService(ConnectionCredentialStore, {} as never),
          Effect.provideService(HttpClient.HttpClient, {} as never),
        );
        yield* registry.setAccount(A);
        const adding = yield* onboarding.registerSsh({ target: SSH_TARGET }).pipe(Effect.forkChild);
        yield* Deferred.await(provisioning);
        yield* registry.setAccount(B);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(adding);

        expect(hasRoutes(yield* Ref.get(harness.storedTargets), MACHINE)).toBe(false);
        expect((yield* Ref.get(harness.storedOwners))?.machines[MACHINE]).toBeUndefined();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save is noted before the catalog write and its owner recorded after it", () =>
    Effect.gen(function* () {
      const atWrite = yield* Ref.make<unknown>(undefined);
      // Filled once the harness exists: its owner record, read when the catalog write starts.
      let readOwners: Effect.Effect<AccountOwners | null> = Effect.succeed(null);
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: B, machines: {} },
        beforeRegistrationRegister: () =>
          Effect.suspend(() => readOwners).pipe(
            Effect.flatMap((stored) => Ref.set(atWrite, stored)),
          ),
      });
      readOwners = Ref.get(harness.storedOwners);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });

        expect(yield* Ref.get(atWrite)).toEqual({
          lastAccount: B,
          machines: {},
          saving: { [RELAY]: { owner: B, fingerprint: routesFingerprint([RELAY_TARGET]) } },
        });
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [RELAY]: B },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a re-save the catalog refuses leaves the machine with the owner it had", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: "" } },
        beforeRegistrationRegister: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "register-connection",
              message: "Fixture: secure storage refused the save",
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        const saved = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: A })
          .pipe(Effect.exit);
        expect(saved._tag).toBe("Failure");
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [RELAY]: "" },
        });
        // Saved while signed out, so it stays through the switch.
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("saves the app stopped in the middle of are settled by what reached the catalog", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET, SECOND_RELAY_TARGET, TARGET], [], [], {
        accountOwners: {
          lastAccount: A,
          machines: { [RELAY]: "", [RELAY_2]: A, [MACHINE]: "" },
          saving: {
            // A's save never reached the catalog: the signed-out machine stays.
            [RELAY]: {
              owner: A,
              fingerprint: routesFingerprint([RELAY_TARGET, SECOND_RELAY_TARGET]),
            },
            // B re-saved A's machine and it landed, though its owner was never
            // recorded: it is B's, and B's drafts on it stay.
            [RELAY_2]: { owner: B, fingerprint: routesFingerprint([SECOND_RELAY_TARGET]) },
            // A's new route landed: the machine leaves with A.
            [MACHINE]: { owner: A, fingerprint: routesFingerprint([TARGET]) },
          },
        },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);

        const targets = yield* Ref.get(harness.storedTargets);
        expect(hasRoutes(targets, RELAY)).toBe(true);
        expect(hasRoutes(targets, RELAY_2)).toBe(true);
        expect(hasRoutes(targets, MACHINE)).toBe(false);
        expect((yield* Ref.get(harness.ownedDataClears)).includes(RELAY_2)).toBe(false);
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: B,
          machines: { [RELAY]: "", [RELAY_2]: B },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save that takes A's machine clears A's cached data before it is written", () =>
    Effect.gen(function* () {
      const failRemoval = yield* Ref.make(true);
      const clearedBeforeWrite = yield* Ref.make<ReadonlyArray<string> | null>(null);
      const clearedBeforeNote = yield* Ref.make<ReadonlyArray<string> | null>(null);
      let readClears: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([]);
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
        // A's machine could not be removed at the switch, so it is still A's.
        beforeRegistrationRemove: () =>
          Ref.getAndSet(failRemoval, false).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new Persistence.ConnectionPersistenceError({
                      operation: "remove-connection",
                      message: "Fixture: storage refused the removal",
                    }),
                  )
                : Effect.void,
            ),
          ),
        beforeRegistrationRegister: () =>
          Effect.suspend(() => readClears).pipe(
            Effect.flatMap((clears) => Ref.set(clearedBeforeWrite, clears)),
          ),
        // The clear also comes before B's note, so no interruption leaves A's data with B.
        beforeOwnersWrite: (owners: AccountOwners) =>
          owners.saving?.[RELAY]?.owner === B
            ? Effect.suspend(() => readClears).pipe(
                Effect.flatMap((clears) => Ref.set(clearedBeforeNote, clears)),
              )
            : Effect.void,
      });
      readClears = Ref.get(harness.ownedDataClears);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        const clearsAfterSwitch = (yield* Ref.get(harness.ownedDataClears)).length;
        // B pairs the same machine on purpose.
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });

        const before = (yield* Ref.get(clearedBeforeWrite)) ?? [];
        expect(before.length).toBeGreaterThan(clearsAfterSwitch);
        expect(before.at(-1)).toBe(RELAY);
        expect((yield* Ref.get(clearedBeforeNote))?.at(-1)).toBe(RELAY);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
        expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).toBe(B);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("editing a machine of unknown owner under the same account keeps its drafts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: B, machines: { [RELAY]: "?" } },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });

        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).toBe(B);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a save whose owner cannot be stored is not saved", () =>
    Effect.gen(function* () {
      const full = yield* Ref.make(false);
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: {} },
        beforeOwnersWrite: () =>
          Ref.get(full).pipe(
            Effect.flatMap((isFull) =>
              isFull
                ? Effect.fail(
                    new Persistence.ConnectionPersistenceError({
                      operation: "save-account-owners",
                      message: "Fixture: local storage is full",
                    }),
                  )
                : Effect.void,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        yield* Ref.set(full, true);
        const saved = yield* registry
          .register(new RelayConnectionRegistration({ target: RELAY_TARGET }), { forAccount: A })
          .pipe(Effect.exit);

        expect(saved._tag).toBe("Failure");
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("cached chats go before the saved entry, so an interrupted removal is still owed", () =>
    Effect.gen(function* () {
      const failure = new Persistence.ConnectionPersistenceError({
        operation: "remove-connection",
        message: "Fixture: the app stopped before the saved entry was removed",
      });
      const harness = yield* makeHarness([TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [MACHINE]: A } },
        beforeRegistrationRemove: () => Effect.fail(failure),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);

        expect(yield* Ref.get(harness.cacheClears)).toEqual([MACHINE]);
        expect((yield* Ref.get(harness.shellCache)).has(MACHINE)).toBe(false);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), MACHINE)).toBe(true);
        // Still A's, and A is still the last account, so the next start removes it.
        expect(yield* Ref.get(harness.storedOwners)).toEqual({
          lastAccount: A,
          machines: { [MACHINE]: A },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
