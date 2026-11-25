import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
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
// Regression tests for round 2 of the GPT-6.2 Sol review of 1434 (November 25, 2026).
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;
const BEARER = BEARER_TARGET.environmentId;
const LOCAL = TARGET.environmentId;

const primary = () => new PrimaryConnectionRegistration({ target: TARGET });

/** A saved route under A that reaches the local server's environment id. */
const LOCAL_BY_ADDRESS = new BearerConnectionTarget({
  environmentId: LOCAL,
  label: "Local server by address",
  connectionId: "local-by-address",
});
const LOCAL_BY_RELAY = new RelayConnectionTarget({ environmentId: LOCAL, label: "Local by Connect" });

/** A fleet pairing's answer for A's relay-only machine. */
const fleetPairingOfRelayMachine = () => {
  const target = new BearerConnectionTarget({
    environmentId: RELAY,
    label: RELAY_TARGET.label,
    connectionId: "relay-machine-direct",
  });
  return new BearerConnectionRegistration({
    target,
    profile: new BearerConnectionProfile({
      ...BEARER_PROFILE,
      connectionId: target.connectionId,
      environmentId: RELAY,
      label: RELAY_TARGET.label,
    }),
    credential: BEARER_CREDENTIAL,
  });
};

/** Runs the scheduler until `check` holds, or gives up; the caller asserts after. */
const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 500; round += 1) {
      if (yield* check) return;
      yield* Effect.yieldNow;
    }
  });
const settle = Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => Effect.yieldNow, { discard: true });

describe("EnvironmentRegistry account switch review fixes, round 2 (1434)", () => {
  it.effect("relay cleanup waits for the platform and never touches the window's own machine", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([LOCAL_BY_RELAY, RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [LOCAL]: A, [RELAY]: A } },
        awaitPlatformPrimary: true,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const cleanup = yield* registry.removeRelayEnvironments().pipe(Effect.forkChild);
        yield* settle;
        // The local descriptor has not answered: nothing is touched yet.
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        yield* registry.reconcilePlatform([primary()]);
        yield* Fiber.join(cleanup);
        expect(yield* Ref.get(harness.cacheClears)).not.toContain(LOCAL);
        expect((yield* Ref.get(harness.shellCache)).has(LOCAL)).toBe(true);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a switch's relay cleanup leaves a skip marker, so a late fleet pairing is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // B's fleet pairing for A's relay-only machine is out; the switch's
        // relay cleanup removes the machine first.
        yield* registry.removeRelayEnvironments({ forgetRemoved: true });
        expect(yield* Ref.get(harness.forgottenMachines)).toEqual([RELAY]);
        yield* registry.setAccount(B);
        yield* registry.register(fleetPairingOfRelayMachine(), { forAccount: B, automatic: true });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a sign-out's relay cleanup leaves no skip marker (D-02)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
        expect(yield* Ref.get(harness.forgottenMachines)).toEqual([]);
        // Signing back in as A, the fleet may pair it again.
        yield* registry.setAccount(A);
        yield* registry.register(fleetPairingOfRelayMachine(), { forAccount: A, automatic: true });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a failing primary descriptor still lets cleanup run, and the recorded own machine stays", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LOCAL_BY_ADDRESS, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          accountOwners: {
            lastAccount: A,
            machines: { [LOCAL]: A, [BEARER]: A },
            localMachine: LOCAL,
          },
          awaitPlatformPrimary: true,
        },
      );
      yield* Ref.update(harness.shellCache, (cache) => new Map(cache).set(BEARER, CACHED_SNAPSHOT));
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* registry.removeRelayEnvironments().pipe(Effect.forkChild);
        yield* settle;
        // The descriptor read failed (it has its own timeout): the report has no primary.
        yield* registry.reconcilePlatform([]);
        yield* eventually(
          Ref.get(harness.storedTargets).pipe(Effect.map((targets) => !hasRoutes(targets, BEARER))),
        );
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(BEARER)).toBe(false);
        // The window's own machine, recorded by an earlier start, is never touched.
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), LOCAL)).toBe(true);
        expect(yield* Ref.get(harness.cacheClears)).not.toContain(LOCAL);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("the reported primary is recorded as the window's own machine", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        accountOwners: { lastAccount: A, machines: {} },
        awaitPlatformPrimary: true,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.reconcilePlatform([primary()]);
        yield* registry.setAccount(A);
        expect((yield* Ref.get(harness.storedOwners))?.localMachine).toBe(LOCAL);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  for (const sequence of [
    [A, B],
    [null, A, B],
  ] as const) {
    it.effect(
      `first launch after upgrade: ${sequence.map((a) => a ?? "signed out").join(", then ")} before the primary registers drops A's machines`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(
            [BEARER_TARGET],
            [BEARER_PROFILE],
            [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
            { accountOwners: null, awaitPlatformPrimary: true },
          );
          yield* Effect.gen(function* () {
            const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
            const fibers = [];
            for (const account of sequence) {
              fibers.push(yield* registry.setAccount(account).pipe(Effect.forkChild));
              yield* settle;
            }
            yield* registry.reconcilePlatform([primary()]);
            for (const fiber of fibers) yield* Fiber.join(fiber);
            // The same result as with the platform ready throughout.
            expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(false);
            expect((yield* Ref.get(harness.storedOwners))?.lastAccount).toBe(B);
          }).pipe(Effect.provide(harness.layer), Effect.scoped);
        }),
    );
  }

  it.effect("first launch after upgrade: signed out, then B keeps unknown machines (D-03)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        { accountOwners: null, awaitPlatformPrimary: true },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const first = yield* registry.setAccount(null).pipe(Effect.forkChild);
        yield* settle;
        const second = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* settle;
        yield* registry.reconcilePlatform([primary()]);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER)).toBe(true);
        expect((yield* Ref.get(harness.storedOwners))?.machines[BEARER]).toBe("?");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
