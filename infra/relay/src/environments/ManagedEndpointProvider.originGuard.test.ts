import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@specweave-studio/contracts/relay";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

// Two links race for one environment of one account with different keys. The
// relay checks the key before provisioning, so both can get past that read.
// The one whose key the stored link refuses must not repoint the tunnel: the
// winner's connector would otherwise serve whatever local port the loser named.

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

const ingressWrites: Array<string> = [];
const tunnels = { created: false };
const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
  get: (tunnelId) => Effect.succeed({ id: tunnelId, name: "managed-tunnel", status: "healthy" }),
  list: (query) =>
    Effect.succeed({
      result: tunnels.created ? [{ id: "tunnel-1", name: query?.name ?? "" }] : [],
    }),
  create: (request) =>
    Effect.sync(() => {
      tunnels.created = true;
      return { id: "tunnel-1", name: request.name };
    }),
  putConfiguration: (_tunnelId, configuration) =>
    Effect.sync(() => void ingressWrites.push(configuration.ingress[0]?.service ?? "")),
  getToken: () => Effect.succeed("connector-token"),
  delete: () => Effect.void,
});

const layer = Layer.mergeAll(ManagedEndpointProvider.layer, EnvironmentLinks.layer).pipe(
  Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
  Layer.provide(
    ManagedEndpointProvider.layerDnsClient(
      ManagedEndpointProvider.ManagedEndpointDnsClient.of({
        listRecords: () => Effect.succeed([]),
        createRecord: () => Effect.succeed({ id: "dns-1" }),
        updateRecord: () => Effect.void,
        deleteRecord: () => Effect.void,
      }),
    ),
  ),
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

const request: RelayEnvironmentLinkRequest = {
  proof: "unused",
  notificationsEnabled: false,
  liveActivitiesEnabled: false,
  managedTunnelsEnabled: true,
};

const proof = (environmentPublicKey: string) =>
  ({
    iss: "studio-env:env-1",
    aud: "https://relay.example.test",
    sub: "env-1",
    jti: "jti",
    iat: 0,
    exp: 60,
    challenge: "challenge",
    environmentId: "env-1" as RelayEnvironmentLinkProofPayload["environmentId"],
    descriptor: {
      environmentId: "env-1" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Desk machine",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey,
    endpoint: {
      httpBaseUrl: "https://env.example.test/",
      wsBaseUrl: "wss://env.example.test/",
      providerKind: "cloudflare_tunnel",
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
    scopes: ["managed_tunnels"],
  }) satisfies RelayEnvironmentLinkProofPayload;

const key = { userId: "user-1", environmentId: "env-1" };

/** What the linker passes: the account's active link is absent or has this key. */
const ownsOrigin = (environmentPublicKey: string) =>
  EnvironmentLinks.EnvironmentLinks.use((links) => links.getForUser(key)).pipe(
    Effect.map((link) => link === null || link.environmentPublicKey === environmentPublicKey),
  );

describe("a link that loses the race for an environment", () => {
  it.effect("does not change the tunnel's ingress", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const guard = yield* Effect.context<EnvironmentLinks.EnvironmentLinks>();
      // The winner provisions and commits its link with key-1.
      const winner = proof("key-1");
      const provisioned = yield* provider.provision({
        ...key,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
        ownsOrigin: ownsOrigin("key-1").pipe(Effect.provideContext(guard)),
      });
      yield* links.upsert({ ...key, request, proof: winner, endpoint: provisioned.endpoint });
      // The loser read no link before the winner committed, and now provisions
      // the same tunnel for another local port under key-2.
      const refused = yield* provider
        .provision({
          ...key,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 9999 },
          ownsOrigin: ownsOrigin("key-2").pipe(Effect.provideContext(guard)),
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "configure-tunnel",
        reason: "key-conflict",
      });
      expect(ingressWrites).toEqual(["http://127.0.0.1:8319"]);
    }).pipe(Effect.provide(layer)),
  );
});
