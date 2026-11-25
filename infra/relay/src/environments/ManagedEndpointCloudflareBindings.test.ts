import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointCloudflareBindings from "./ManagedEndpointCloudflareBindings.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import type { ManagedTunnelClient } from "./ManagedTunnelBinding.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

// The Worker's Cloudflare bindings over a stub tunnel API. A provision's
// ingress write may be retried; each try must read ownership again first.

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

/** What Cloudflare's client treats as worth retrying (a 5xx, a dropped connection). */
const transientFailure = { "@distilled.cloud/error/retryable": {} };

const layerFor = (tunnel: Record<string, unknown>) =>
  ManagedEndpointCloudflareBindings.layerCloudflareBindings(
    tunnel as unknown as ManagedTunnelClient,
    {
      listDnsRecords: () => Effect.succeed({ result: [] }),
      createDnsRecord: () => Effect.succeed({ id: "dns-1" }),
      updateDnsRecord: () => Effect.void,
      deleteDnsRecord: () => Effect.void,
    } as unknown as Cloudflare.DNS.ReadWriteDnsClient,
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

/** A tunnel API whose first ingress write fails in transit; a retry would succeed. */
const flakyTunnel = () => {
  const puts: Array<string> = [];
  const tunnel = {
    get: (tunnelId: string) => Effect.succeed({ id: tunnelId, name: "t", status: "healthy" }),
    list: () => Effect.succeed({ result: [] }),
    create: (request: { readonly name: string }) =>
      Effect.succeed({ id: "tunnel-1", name: request.name }),
    putConfiguration: (_tunnelId: string, body: { readonly ingress: Array<{ service: string }> }) =>
      Effect.suspend(() => {
        puts.push(body.ingress[0]?.service ?? "");
        return puts.length === 1 ? Effect.fail(transientFailure) : Effect.void;
      }),
    getToken: () => Effect.succeed("connector-token"),
    delete: () => Effect.void,
    disconnect: () => Effect.void,
  };
  return { puts, tunnel };
};

describe("a provision's ingress write on the Worker's bindings", () => {
  it.live("reads ownership again before a retried write, and stops when it changed", () => {
    const { puts, tunnel } = flakyTunnel();
    let ownershipReads = 0;
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const refused = yield* provider
        .provision({
          userId: "user-1",
          environmentId: "env-1",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 9999 },
          // Another key's link commits while the first write is in flight.
          ownsOrigin: Effect.sync(() => (ownershipReads += 1) === 1),
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ stage: "configure-tunnel", reason: "key-conflict" });
      expect(ownershipReads).toBe(2);
      expect(puts).toHaveLength(1);
    }).pipe(Effect.provide(layerFor(tunnel)));
  });

  it.live("retries the write while ownership holds", () => {
    const { puts, tunnel } = flakyTunnel();
    let ownershipReads = 0;
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user-1",
        environmentId: "env-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
        ownsOrigin: Effect.sync(() => ((ownershipReads += 1), true)),
      });
      expect(ownershipReads).toBe(2);
      expect(puts).toEqual(["http://127.0.0.1:8319", "http://127.0.0.1:8319"]);
    }).pipe(Effect.provide(layerFor(tunnel)));
  });
});
