import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayConnectPromos,
  relayEnvironmentLinks,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const now = "2026-10-28T00:00:00.000Z";

const config = (overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {}) =>
  RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: null,
    apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "studio-code-relay",
    cloudMintPrivateKey: Redacted.make("private-key"),
    cloudMintPublicKey: "public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    ...overrides,
  });

const layer = (overrides?: Partial<RelayConfiguration.RelayConfiguration["Service"]>) =>
  Layer.mergeAll(ManagedTunnelLimits.layer, ConnectAccounts.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerSqliteRelayDb(), RelayConfiguration.layer(config(overrides))),
    ),
  );

const resolve = (userId: string) =>
  Effect.gen(function* () {
    const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
    return yield* limits.resolve({ userId });
  });

/** ensureAccount runs after a managed link succeeded, so give the user one. */
const ensure = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .insert(relayEnvironmentLinks)
      .values({
        userId,
        environmentId: "env-1",
        environmentPublicKey: "key",
        endpointHttpBaseUrl: "https://example.test",
        endpointWsBaseUrl: "wss://example.test",
        endpointProviderKind: "managed",
        managedTunnelsEnabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const accounts = yield* ConnectAccounts.ConnectAccounts;
    return yield* accounts.ensureAccount({ userId });
  });

const setPromo = (values: Partial<typeof relayConnectPromos.$inferInsert>) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .update(relayConnectPromos)
      .set(values)
      .where(eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID));
  });

const setOverride = (userId: string, maxTunnels: number, unlimited = false) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .insert(relayManagedTunnelLimits)
      .values({ userId, maxTunnels, unlimited, createdAt: now, updatedAt: now });
  });

describe("ManagedTunnelLimits", () => {
  it.effect("gives an account without a seat or override the free limit of 3", () =>
    Effect.gen(function* () {
      expect(ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT).toBe(3);
      yield* setPromo({ grantsOpen: false });
      expect(yield* resolve("user-1")).toEqual({ maxTunnels: 3, source: "free" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("uses the configured free limit", () =>
    Effect.gen(function* () {
      yield* setPromo({ seatCap: 0 });
      expect(yield* resolve("user-1")).toEqual({ maxTunnels: 4, source: "free" });
    }).pipe(Effect.provide(layer({ connectFreeTunnelLimit: 4 }))),
  );

  it.effect("gives an account without a seat the founder limit while it would get one", () =>
    Effect.gen(function* () {
      // The seat is granted after the first link succeeds, so the limit for
      // that link already reflects it.
      expect(yield* resolve("new-user")).toEqual({ maxTunnels: 10, source: "founder" });
      yield* setPromo({ seatCap: 1 });
      yield* ensure("first");
      expect(yield* resolve("first")).toEqual({ maxTunnels: 10, source: "founder" });
      expect(yield* resolve("new-user")).toEqual({ maxTunnels: 3, source: "free" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("gives founders the promo's founder limit", () =>
    Effect.gen(function* () {
      yield* ensure("founder");
      expect(yield* resolve("founder")).toEqual({ maxTunnels: 10, source: "founder" });

      const db = yield* RelayDb.RelayDb;
      yield* db
        .update(relayConnectPromos)
        .set({ founderTunnelLimit: 12, grantsOpen: false })
        .where(eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID));
      // Closing grants keeps existing founders on the founder limit.
      expect(yield* resolve("founder")).toEqual({ maxTunnels: 12, source: "founder" });
      yield* ensure("late");
      expect(yield* resolve("late")).toEqual({ maxTunnels: 3, source: "free" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("lets a manual override win over the founder and free limits", () =>
    Effect.gen(function* () {
      yield* ensure("founder");
      yield* setOverride("founder", 1);
      yield* setOverride("someone", 25);
      expect(yield* resolve("founder")).toEqual({ maxTunnels: 1, source: "override" });
      expect(yield* resolve("someone")).toEqual({ maxTunnels: 25, source: "override" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("resolves an unlimited override to no account cap for that user only", () =>
    Effect.gen(function* () {
      yield* ensure("founder");
      yield* setOverride("owner", 3, true);
      yield* setOverride("founder", 2, true);
      expect(yield* resolve("owner")).toEqual({ maxTunnels: null, source: "override" });
      expect(yield* resolve("founder")).toEqual({ maxTunnels: null, source: "override" });
      expect(ManagedTunnelLimits.toManagedTunnelPolicy(yield* resolve("owner"))).toEqual({
        kind: "unlimited",
      });
      yield* setPromo({ grantsOpen: false });
      expect(yield* resolve("other")).toEqual({ maxTunnels: 3, source: "free" });
      expect(ManagedTunnelLimits.toManagedTunnelPolicy(yield* resolve("other"))).toEqual({
        kind: "limited",
        maxTunnels: 3,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails closed on an invalid finite override", () =>
    Effect.gen(function* () {
      yield* setOverride("broken", -1);
      const error = yield* Effect.flip(resolve("broken"));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "load-limit",
        userId: "broken",
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("retains database failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Effect.fail(cause) }) }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const error = yield* Effect.flip(resolve("user-1"));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "load-limit",
        userId: "user-1",
      });
      expect(error).toHaveProperty("cause", cause);
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(RelayDb.RelayDb, fakeDb),
              RelayConfiguration.layer(config()),
            ),
          ),
        ),
      ),
    );
  });
});
