import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayConnectPromos,
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
} from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

// The real provider, limits, allocations and Connect accounts on one SQLite
// D1, with only Cloudflare stubbed.

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
    managedEndpointBaseDomain: "studio.test",
    managedEndpointNamespace: "dev_alice",
    ...overrides,
  });

interface CloudflareState {
  failTunnelCreate: boolean;
}

const tunnelClient = (state: CloudflareState) => {
  const tunnels = new Map<string, { readonly id: string; readonly name: string }>();
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) =>
      Effect.succeed({
        id: tunnelId,
        name: "managed-tunnel",
        status: "down",
        connsInactiveAt: "2026-06-01T00:00:00.000Z",
      }),
    list: (request) =>
      Effect.sync(() => {
        const tunnel = request.name === undefined ? undefined : tunnels.get(request.name);
        return { result: tunnel === undefined ? [] : [tunnel] };
      }),
    create: (request) =>
      state.failTunnelCreate
        ? Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "create",
              cause: new Error("cloudflare down"),
            }),
          )
        : Effect.sync(() => {
            const tunnel = { id: `tunnel-${request.name}`, name: request.name };
            tunnels.set(request.name, tunnel);
            return tunnel;
          }),
    putConfiguration: () => Effect.void,
    getToken: () => Effect.succeed("connector-token"),
    delete: () => Effect.void,
  });
};

const dnsClient = () => {
  const records = new Map<string, { readonly id: string }>();
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.sync(() => {
        const record = records.get(hostname);
        return record === undefined ? [] : [record];
      }),
    createRecord: (request) =>
      Effect.sync(() => {
        const record = { id: `dns-${request.name}` };
        records.set(request.name, record);
        return record;
      }),
    updateRecord: () => Effect.void,
    deleteRecord: () => Effect.void,
  });
};

const layer = (
  overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {},
  state: CloudflareState = { failTunnelCreate: false },
) =>
  ManagedEndpointProvider.layer.pipe(
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient(state))),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient())),
    Layer.provideMerge(
      Layer.mergeAll(
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
        ConnectAccounts.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        layerSqliteRelayDb(),
        RelayConfiguration.layer(config(overrides)),
        NodeServices.layer,
      ),
    ),
  );

/** What EnvironmentLinker does for a managed link: provision, write the link, then grant. */
const linkManaged = (userId: string, environmentId: string) =>
  Effect.gen(function* () {
    const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const db = yield* RelayDb.RelayDb;
    const accounts = yield* ConnectAccounts.ConnectAccounts;
    yield* provider.provision({
      userId,
      environmentId,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
    });
    yield* db
      .insert(relayEnvironmentLinks)
      .values({
        userId,
        environmentId,
        environmentPublicKey: `key-${environmentId}`,
        endpointHttpBaseUrl: "https://managed.example.test",
        endpointWsBaseUrl: "wss://managed.example.test",
        endpointProviderKind: "cloudflare_tunnel",
        managedTunnelsEnabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return yield* accounts.ensureAccount({ userId });
  });

const ageAllocation = (userId: string, environmentId: string) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .update(relayManagedEndpointAllocations)
      .set({ updatedAt: "1900-01-01T00:00:00.000Z" })
      .where(
        and(
          eq(relayManagedEndpointAllocations.userId, userId),
          eq(relayManagedEndpointAllocations.environmentId, environmentId),
        ),
      );
  });

const summary = Effect.gen(function* () {
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  return yield* accounts.foundersSummary();
});

const setPromo = (values: Partial<typeof relayConnectPromos.$inferInsert>) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .update(relayConnectPromos)
      .set(values)
      .where(eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID));
  });

describe("Connect founders end to end", () => {
  it.effect("a founder links 10 machines and the 11th is refused", () =>
    Effect.gen(function* () {
      for (let index = 1; index <= 10; index++) {
        const account = yield* linkManaged("founder", `env-${index}`);
        expect(account.founderNumber).toBe(1);
      }
      const error = yield* Effect.flip(linkManaged("founder", "env-11"));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        reason: "account_limit",
        maxTunnels: 10,
        activeTunnels: 10,
      });
      expect(yield* summary).toMatchObject({ seatsGranted: 1 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a free account's 4th machine is refused once seats are gone", () =>
    Effect.gen(function* () {
      yield* setPromo({ grantsOpen: false });
      for (let index = 1; index <= 3; index++) {
        const account = yield* linkManaged("free-user", `env-${index}`);
        expect(account.founderNumber).toBeNull();
      }
      const error = yield* Effect.flip(linkManaged("free-user", "env-4"));
      expect(error).toMatchObject({
        reason: "account_limit",
        maxTunnels: 3,
        activeTunnels: 3,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a link refused at the global cap takes no founder seat", () =>
    Effect.gen(function* () {
      yield* linkManaged("user-1", "env-1");
      yield* linkManaged("user-2", "env-1");
      for (const userId of ["user-3", "user-4", "user-5"]) {
        const error = yield* Effect.flip(linkManaged(userId, "env-1"));
        expect(error).toMatchObject({ reason: "service_capacity" });
      }
      expect(yield* summary).toMatchObject({ seatsGranted: 2, seatsLeft: 998 });
    }).pipe(Effect.provide(layer({ globalManagedTunnelCap: 2 }))),
  );

  it.effect("a link failing in Cloudflare takes no seat and frees its slot later", () => {
    const state = { failTunnelCreate: true };
    return Effect.gen(function* () {
      const failed = yield* Effect.flip(linkManaged("user-1", "env-1"));
      expect(failed._tag).toBe("ManagedEndpointProvisioningFailed");
      expect(yield* summary).toMatchObject({ seatsGranted: 0 });

      // Cloudflare recovers after seats are gone. The failed allocation still
      // counts while it may be in flight, so the account's 3rd slot is taken.
      state.failTunnelCreate = false;
      yield* setPromo({ grantsOpen: false });
      yield* linkManaged("user-1", "env-2");
      yield* linkManaged("user-1", "env-3");
      const refused = yield* Effect.flip(linkManaged("user-1", "env-4"));
      expect(refused).toMatchObject({ reason: "account_limit", activeTunnels: 3 });

      // Out of the in-flight window, it no longer holds the slot.
      yield* ageAllocation("user-1", "env-1");
      yield* linkManaged("user-1", "env-4");
    }).pipe(Effect.provide(layer({}, state)));
  });
});
