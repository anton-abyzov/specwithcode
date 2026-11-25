import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

// A machine moves from account A to B and back to A. Each account's tunnel
// and DNS record are keyed by the account and environment, so A's return
// finds its own allocation and reuses its tunnel and record.

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

const notFound = (dnsRecordId: string) =>
  new ManagedEndpointProvider.ManagedEndpointDnsClientError({
    operation: "update-record",
    dnsRecordId,
    cause: { status: 404 },
  });

const makeWorld = () => {
  /** DNS record id to hostname and target. */
  const records = new Map<string, { name: string; content: string }>();
  /** Tunnel id to name. */
  const tunnels = new Map<string, string>();
  const ingress = new Map<string, string>();
  let next = 1;
  const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) =>
      Effect.succeed({ id: tunnelId, name: tunnels.get(tunnelId) ?? "", status: "inactive" }),
    list: (query) =>
      Effect.succeed({
        result: [...tunnels]
          .filter(([, name]) => name === query?.name)
          .map(([id, name]) => ({ id, name })),
      }),
    create: (request) =>
      Effect.sync(() => {
        const id = `tunnel-${next++}`;
        tunnels.set(id, request.name);
        return { id, name: request.name };
      }),
    putConfiguration: (tunnelId, configuration) =>
      Effect.sync(() => void ingress.set(tunnelId, JSON.stringify(configuration.ingress))),
    getToken: () => Effect.succeed("connector-token"),
    delete: (tunnelId) => Effect.sync(() => void tunnels.delete(tunnelId)),
  });
  const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.succeed(
        [...records].filter(([, record]) => record.name === hostname).map(([id]) => ({ id })),
      ),
    createRecord: (request) =>
      Effect.sync(() => {
        const id = `dns-${next++}`;
        records.set(id, { name: request.name, content: request.content });
        return { id };
      }),
    updateRecord: (dnsRecordId, request) =>
      records.has(dnsRecordId)
        ? Effect.sync(
            () => void records.set(dnsRecordId, { name: request.name, content: request.content }),
          )
        : Effect.fail(notFound(dnsRecordId)),
    deleteRecord: (dnsRecordId) => Effect.sync(() => void records.delete(dnsRecordId)),
  });
  const layer = ManagedEndpointProvider.layer.pipe(
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
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
  return { records, tunnels, ingress, layer };
};

const environmentId = "env-1";
const origin = { localHttpHost: "127.0.0.1", localHttpPort: 8319 };

describe("an A to B to A machine move", () => {
  it.effect("reuses A's tunnel and DNS record when the machine returns to A", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const firstA = yield* provider.provision({ userId: "user-a", environmentId, origin });
      const firstAllocation = yield* allocations.get({ userId: "user-a", environmentId });
      const b = yield* provider.provision({ userId: "user-b", environmentId, origin });
      const againA = yield* provider.provision({ userId: "user-a", environmentId, origin });
      const againAllocation = yield* allocations.get({ userId: "user-a", environmentId });

      const hostA = new URL(firstA.endpoint.httpBaseUrl).hostname;
      const hostB = new URL(b.endpoint.httpBaseUrl).hostname;
      expect(hostA).not.toBe(hostB);
      expect(againA.endpoint).toEqual(firstA.endpoint);
      expect(againA.runtime.tunnelId).toBe(firstA.runtime.tunnelId);
      expect(againAllocation?.dnsRecordId).toBe(firstAllocation?.dnsRecordId);
      // One tunnel and one CNAME per account, each pointing at its own tunnel.
      expect(world.tunnels.size).toBe(2);
      expect(
        [...world.records.values()].sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        [
          { name: hostA, content: `${firstA.runtime.tunnelId}.cfargotunnel.com` },
          { name: hostB, content: `${b.runtime.tunnelId}.cfargotunnel.com` },
        ].sort((left, right) => left.name.localeCompare(right.name)),
      );
    }).pipe(Effect.provide(world.layer));
  });
});
