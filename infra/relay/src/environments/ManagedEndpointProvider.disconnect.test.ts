import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointCloudflareBindings from "./ManagedEndpointCloudflareBindings.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import type { ManagedTunnelClient } from "./ManagedTunnelBinding.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

// The real provider and allocations on SQLite D1, with a Cloudflare stub whose
// tunnel keeps a live connector until it is disconnected.

const config = RelayConfiguration.RelayConfiguration.of({
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
});

const liveTunnel = () => {
  const state = { connected: true, deleted: false, disconnects: 0 };
  const client = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) => Effect.succeed({ id: tunnelId, name: "managed-tunnel", status: "healthy" }),
    list: () => Effect.succeed({ result: [] }),
    create: (request) => Effect.succeed({ id: "tunnel-1", name: request.name }),
    putConfiguration: () => Effect.void,
    getToken: () => Effect.succeed("connector-token"),
    delete: (tunnelId) =>
      state.connected
        ? Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "delete",
              tunnelId,
              cause: new Error("Cannot delete tunnel because it has active connections"),
            }),
          )
        : Effect.sync(() => void (state.deleted = true)),
    disconnect: () =>
      Effect.sync(() => {
        state.disconnects += 1;
        state.connected = false;
      }),
  });
  return { state, client };
};

const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
  listRecords: () => Effect.succeed([]),
  createRecord: () => Effect.succeed({ id: "dns-1" }),
  updateRecord: () => Effect.void,
  deleteRecord: () => Effect.void,
});

const layerFor = (client: ManagedEndpointProvider.ManagedEndpointTunnelClient["Service"]) =>
  ManagedEndpointProvider.layer.pipe(
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(client)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient)),
    Layer.provideMerge(
      Layer.mergeAll(
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
        ConnectAccounts.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(layerSqliteRelayDb(), RelayConfiguration.layer(config), NodeServices.layer),
    ),
  );

const key = { userId: "user-1", environmentId: "env-1" };

const allocationCount = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const rows = yield* db.select().from(relayManagedEndpointAllocations);
  return rows.length;
});

const provisionLiveHost = Effect.gen(function* () {
  const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  yield* provider.provision({
    ...key,
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
  });
  return provider;
});

describe("removing a tunnel whose host is still connected", () => {
  it.effect("an ordinary unlink leaves the tunnel for later", () => {
    const { state, client } = liveTunnel();
    return Effect.gen(function* () {
      const provider = yield* provisionLiveHost;
      expect(yield* provider.deprovision(key)).toBe(false);
      expect(state).toMatchObject({ disconnects: 0, deleted: false });
      expect(yield* allocationCount).toBe(1);
    }).pipe(Effect.provide(layerFor(client)));
  });

  it.effect("an account deletion drops the connectors, deletes the tunnel and frees it", () => {
    const { state, client } = liveTunnel();
    return Effect.gen(function* () {
      const provider = yield* provisionLiveHost;
      expect(yield* provider.deprovision({ ...key, forceDisconnect: true })).toBe(true);
      expect(state).toMatchObject({ disconnects: 1, deleted: true });
      expect(yield* allocationCount).toBe(0);
    }).pipe(Effect.provide(layerFor(client)));
  });

  it.effect("the Worker's Cloudflare bindings carry the disconnect through", () => {
    const { state, client } = liveTunnel();
    // The Worker's tunnel binding, as the Cloudflare SDK shape, over the stub.
    const binding = { ...client } as unknown as ManagedTunnelClient;
    const dns = {
      listDnsRecords: () => Effect.succeed({ result: [] }),
      createDnsRecord: () => Effect.succeed({ id: "dns-1" }),
      updateDnsRecord: () => Effect.void,
      deleteDnsRecord: () => Effect.void,
    } as unknown as Cloudflare.DNS.ReadWriteDnsClient;
    const workerLayer = ManagedEndpointCloudflareBindings.layerCloudflareBindings(
      binding,
      dns,
      {} as Alchemy.BaseRuntimeContext,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
          ConnectAccounts.layer,
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(layerSqliteRelayDb(), RelayConfiguration.layer(config), NodeServices.layer),
      ),
    );
    return Effect.gen(function* () {
      const provider = yield* provisionLiveHost;
      expect(yield* provider.deprovision({ ...key, forceDisconnect: true })).toBe(true);
      expect(state).toMatchObject({ disconnects: 1, deleted: true });
    }).pipe(Effect.provide(workerLayer));
  });
});
