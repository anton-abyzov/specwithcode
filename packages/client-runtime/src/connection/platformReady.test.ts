import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "./catalog.ts";
import { followPlatformSource } from "./platformReady.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { RELAY_TARGET, hasRoutes, makeHarness } from "./registry.testHarness.ts";

// Synthetic accounts only: nothing here reaches a real Connect account or machine.
const A = "user_fixture_a";
const B = "user_fixture_b";
const RELAY = RELAY_TARGET.environmentId;

const settle = Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => Effect.yieldNow, { discard: true });

describe("account cleanup and the platform source (1434, AC-04)", () => {
  it.effect("a platform with no own machine (an ended source) lets cleanup run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
        awaitPlatformPrimary: true,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* followPlatformSource(Stream.empty, registry);
        yield* registry.setAccount(B);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("cleanup waits for the platform's first report, with or without a primary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        accountOwners: { lastAccount: A, machines: { [RELAY]: A } },
        awaitPlatformPrimary: true,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const reports = yield* Queue.unbounded<ReadonlyArray<PlatformConnectionRegistration>>();
        yield* followPlatformSource(Stream.fromQueue(reports), registry).pipe(Effect.forkScoped);
        const cleanup = yield* registry.setAccount(B).pipe(Effect.forkChild);
        yield* settle;
        // The descriptor is slow: no report yet, nothing touched.
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(true);
        // A failed read (it has its own timeout) still reports, without the primary.
        yield* Queue.offer(reports, []);
        yield* Fiber.join(cleanup);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), RELAY)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
