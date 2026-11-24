import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
  RelayConnectionRegistration,
} from "./catalog.ts";
import type { AccountOwners } from "./accountOwners.ts";
import { BearerConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  BEARER_CREDENTIAL,
  BEARER_PROFILE,
  BEARER_TARGET,
  CACHED_SNAPSHOT,
  RELAY_TARGET,
  TARGET,
  hasRoutes,
  makeHarness,
} from "./registry.testHarness.ts";

// Synthetic accounts only: nothing here reaches a real Connect account or machine.
// Regression tests for the GPT-6.2 Sol review of 1434 (November 24, 2026).
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const BEARER = BEARER_TARGET.environmentId;
const LOCAL = TARGET.environmentId;

const bearerRegistration = () =>
  new BearerConnectionRegistration({
    target: BEARER_TARGET,
    profile: BEARER_PROFILE,
    credential: BEARER_CREDENTIAL,
  });

const settle = Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => Effect.yieldNow, { discard: true });

describe("EnvironmentRegistry account switch review fixes (1434)", () => {
  it.effect("relay cleanup clears a relay-only machine's cache before it leaves the catalog", () =>
    Effect.gen(function* () {
      const owners: AccountOwners = { lastAccount: A, machines: { [RELAY]: A } };
      // The app stops while clearing the cache of A's relay-only machine.
      const crashed = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: owners,
        beforeCacheClear: (environmentId) =>
          environmentId === RELAY ? Effect.die(new Error("fixture: the app stopped")) : Effect.void,
      });
      yield* Ref.update(crashed.shellCache, (cache) => new Map(cache).set(RELAY, CACHED_SNAPSHOT));
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments().pipe(Effect.exit);
      }).pipe(Effect.provide(crashed.layer), Effect.scoped);
      // Still saved: the next start can still see it and finish the job.
      const targetsAfterCrash = yield* Ref.get(crashed.storedTargets);
      expect(hasRoutes(targetsAfterCrash, RELAY)).toBe(true);

      // The next start, signed in as B, removes it and its cached chats.
      const restarted = yield* makeHarness(targetsAfterCrash, [], [], {
        accountOwners: yield* Ref.get(crashed.storedOwners),
      });
      yield* Ref.update(restarted.shellCache, (cache) =>
        new Map(cache).set(RELAY, CACHED_SNAPSHOT),
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(restarted.storedTargets), RELAY)).toBe(false);
        expect((yield* Ref.get(restarted.shellCache)).has(RELAY)).toBe(false);
      }).pipe(Effect.provide(restarted.layer), Effect.scoped);
    }),
  );

  it.effect("a machine paired again while signed out does not inherit its removed owner", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        { accountOwners: { lastAccount: A, machines: { [BEARER]: A } } },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(A);
        // Sign out of A, forget the machine by hand, then pair it again.
        yield* registry.setAccount(null);
        yield* registry.remove(BEARER);
        yield* registry.register(bearerRegistration(), { forAccount: null });
        // Signing in as B keeps the fresh, signed-out pairing (AC-01).
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(true);
        expect((yield* Ref.get(harness.storedOwners))?.machines[BEARER]).toBe("");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("startup cleanup waits for the window's own machine before planning", () =>
    Effect.gen(function* () {
      // A route saved under A that reaches the local server's environment id.
      const localRoute = new BearerConnectionTarget({
        environmentId: LOCAL,
        label: "Local server by address",
        connectionId: "local-by-address",
      });
      const harness = yield* makeHarness([localRoute, RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [LOCAL]: A, [RELAY]: A } },
        awaitPlatformPrimary: true,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const cleanup = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* settle;
        // The local descriptor has not answered: nothing is touched yet.
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* SubscriptionRef.get(registry.accountScope)).toBe(B);
        // A report without the primary (its first read failed) keeps waiting.
        yield* registry.reconcilePlatform([]);
        yield* settle;
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);

        yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: TARGET })]);
        yield* Fiber.join(cleanup);
        // The window's own machine keeps its cache; A's other machine goes.
        expect(yield* Ref.get(harness.cacheClears)).not.toContain(LOCAL);
        expect((yield* Ref.get(harness.shellCache)).has(LOCAL)).toBe(true);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("an automatic pairing that answers after the switch's drop is not saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        { accountOwners: { lastAccount: A, machines: { [BEARER]: A } } },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // The fleet pairing passed its skip check under B, then waited on the
        // pairing code while the switch dropped A's machine.
        yield* registry.setAccount(B);
        expect(yield* Ref.get(harness.forgottenMachines)).toEqual([BEARER]);
        yield* registry.register(bearerRegistration(), { forAccount: B, automatic: true });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(false);
        // A pairing by hand is the user's choice and is kept.
        yield* registry.register(bearerRegistration(), { forAccount: B });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("an automatic pairing that lands before the switch's drop finishes the drop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          accountOwners: { lastAccount: A, machines: { [BEARER]: A } },
          awaitPlatformPrimary: true,
        },
      );
      yield* Ref.update(harness.shellCache, (cache) => new Map(cache).set(BEARER, CACHED_SNAPSHOT));
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // B is published; the switch's drop has not reached the machine yet.
        const cleanup = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* settle;
        yield* registry.register(bearerRegistration(), { forAccount: B, automatic: true });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(BEARER)).toBe(false);
        yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: TARGET })]);
        yield* Fiber.join(cleanup);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("relay cleanup still removes a relay-only machine and its cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], { accountOwners: null });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* registry.removeRelayEnvironments();
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toContain(RELAY);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
