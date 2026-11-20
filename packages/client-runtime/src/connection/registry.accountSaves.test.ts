import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import { make as makeOnboarding } from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  RELAY_TARGET,
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

  it.effect("the owner is written before the machine, so a save cut short is never unowned", () =>
    Effect.gen(function* () {
      const ownerAtWrite = yield* Ref.make<string | undefined>(undefined);
      // Filled once the harness exists: its owner record, read when the catalog write starts.
      let readOwners: Effect.Effect<{ readonly machines: Record<string, string> } | null> =
        Effect.succeed(null);
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: B, machines: {} },
        beforeRegistrationRegister: () =>
          Effect.suspend(() => readOwners).pipe(
            Effect.flatMap((stored) => Ref.set(ownerAtWrite, stored?.machines[RELAY])),
          ),
      });
      readOwners = Ref.get(harness.storedOwners);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }), {
          forAccount: B,
        });

        expect(yield* Ref.get(ownerAtWrite)).toBe(B);
        expect((yield* Ref.get(harness.storedOwners))?.machines[RELAY]).toBe(B);
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
