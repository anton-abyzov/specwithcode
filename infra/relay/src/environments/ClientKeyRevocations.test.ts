// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";

import {
  RelayRevokeClientKeysProofPayload,
  RelayRevokeClientKeysRequest,
} from "@specweave-studio/contracts/relay";
import {
  RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
  verifyRelayJwt,
} from "@specweave-studio/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as RelayConfiguration from "../Config.ts";
import * as ClientKeyRevocations from "./ClientKeyRevocations.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.specweave.studio.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "studio-code-relay",
  cloudMintPrivateKey: Redacted.make(cloudKeyPair.privateKey),
  cloudMintPublicKey: cloudKeyPair.publicKey,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: undefined,
});

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RelayRevokeClientKeysRequest));
const decodeProof = Schema.decodeUnknownEffect(RelayRevokeClientKeysProofPayload);

const environment = (environmentId: string, providerKind = "cloudflare_tunnel") => ({
  environmentId: environmentId as never,
  label: environmentId,
  endpoint: {
    httpBaseUrl: `https://${environmentId}.example.test/`,
    wsBaseUrl: `wss://${environmentId}.example.test/ws`,
    providerKind: providerKind as "cloudflare_tunnel",
  },
  linkedAt: "2026-10-31T00:00:00.000Z",
});

const allocation = (
  environmentId: string,
  ready = true,
): ManagedEndpointAllocations.ManagedEndpointAllocation => ({
  userId: "user-1",
  environmentId,
  hostname: `${environmentId}.example.test`,
  tunnelId: "tunnel-id",
  tunnelName: `tunnel-${environmentId}`,
  dnsRecordId: "dns-record-id",
  readyAt: ready ? "2026-10-31T00:00:00.000Z" : null,
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
  updatedAt: "2026-10-31T00:00:00.000Z",
  generation: 1,
  tunnelReleasedAt: null,
});

function layerTest(input: {
  readonly environments: ReadonlyArray<ReturnType<typeof environment>>;
  readonly notReady?: ReadonlyArray<string>;
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return ClientKeyRevocations.layer.pipe(
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provide(
      Layer.mock(EnvironmentLinks.EnvironmentLinks, {
        listForUser: ({ userId }) => {
          expect(userId).toBe("user-1");
          return Effect.succeed(input.environments);
        },
        getForUser: ({ environmentId }) =>
          Effect.succeed({
            ...environment(environmentId),
            environmentPublicKey: "environment-key",
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {
        get: ({ environmentId }) =>
          Effect.succeed(allocation(environmentId, !input.notReady?.includes(environmentId))),
      }),
    ),
    Layer.provide(RelayConfiguration.layer(settings)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.execute))),
  );
}

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";

describe("ClientKeyRevocations", () => {
  it.effect("signs a revoke order for each ready managed environment but the caller", () => {
    const seen: Array<{ readonly url: string; readonly proof: string }> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        seen.push({ url: request.url, proof: decodeRequest(bodyText(request)).proof });
        return HttpClientResponse.fromWeb(request, Response.json({ revoked: 1 }, { status: 200 }));
      });
    return Effect.gen(function* () {
      const revocations = yield* ClientKeyRevocations.ClientKeyRevocations;
      yield* revocations.notify({
        userId: "user-1",
        proofKeyThumbprints: ["key-a", "key-b"],
        exceptEnvironmentId: "env-caller",
      });

      expect(seen.map((entry) => entry.url).sort()).toEqual([
        "https://env-1.example.test/api/studio-connect/revoke-client-keys",
        "https://env-2.example.test/api/studio-connect/revoke-client-keys",
      ]);
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      for (const { url, proof } of seen) {
        const environmentId = new URL(url).hostname.split(".")[0] ?? "";
        const payload = yield* verifyRelayJwt({
          publicKey: cloudKeyPair.publicKey,
          token: proof,
          typ: RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
          issuer: "https://relay.example.test",
          audience: `studio-env:${environmentId}`,
          nowEpochSeconds: now,
        }).pipe(Effect.flatMap(decodeProof));
        expect(payload).toMatchObject({
          sub: "user-1",
          environmentId,
          proofKeyThumbprints: ["key-a", "key-b"],
          scope: ["environment:revoke-client"],
        });
        expect(payload.exp - payload.iat).toBe(120);
        expect(payload.nonce).not.toBe(payload.jti);
      }
    }).pipe(
      Effect.provide(
        layerTest({
          environments: [
            environment("env-1"),
            environment("env-2"),
            environment("env-caller"),
            environment("env-not-ready"),
            environment("env-direct", "direct"),
          ],
          notReady: ["env-not-ready"],
          execute,
        }),
      ),
    );
  });

  it.effect("never fails the caller when an environment is unreachable", () => {
    const attempted: Array<string> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        attempted.push(new URL(request.url).hostname);
        return HttpClientResponse.fromWeb(
          request,
          new Response("bad gateway", { status: request.url.includes("env-1") ? 502 : 200 }),
        );
      });
    return Effect.gen(function* () {
      const revocations = yield* ClientKeyRevocations.ClientKeyRevocations;
      yield* revocations.notify({ userId: "user-1", proofKeyThumbprints: ["key-a"] });
      expect(attempted.sort()).toEqual(["env-1.example.test", "env-2.example.test"]);
      // Nothing to revoke sends nothing.
      attempted.length = 0;
      yield* revocations.notify({ userId: "user-1", proofKeyThumbprints: [] });
      expect(attempted).toEqual([]);
    }).pipe(
      Effect.provide(
        layerTest({ environments: [environment("env-1"), environment("env-2")], execute }),
      ),
    );
  });
});
