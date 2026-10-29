// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@specweave-studio/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@specweave-studio/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinker from "./EnvironmentLinker.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
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
  cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
  cloudMintPublicKey: relayKeyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const isEnvironmentLinkProofInvalid = Schema.is(EnvironmentLinker.EnvironmentLinkProofInvalid);

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const makeRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const relayTokens = yield* RelayTokens.RelayTokens;
  const challenge = yield* relayTokens.issueLinkChallenge({
    userId: "user_123",
    request: {
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
    },
    jti: "challenge-jti",
    issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
  });
  const payload = {
    iss: "studio-env:env-link-test",
    aud: "https://relay.example.test",
    sub: "env-link-test",
    jti: "link-proof-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge,
    environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
    descriptor: {
      environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Link Test Environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey: environmentKeyPair.publicKey.trim(),
    endpoint: {
      httpBaseUrl: "https://env.example.test/",
      wsBaseUrl: "wss://env.example.test/",
      providerKind: "manual",
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  } satisfies RelayEnvironmentLinkProofPayload;
  return {
    request: {
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
    } satisfies RelayEnvironmentLinkRequest,
    payload,
  };
});

function layerTest(input?: {
  readonly upsert?: EnvironmentLinks.EnvironmentLinks["Service"]["upsert"];
  readonly consume?: DpopProofs.DpopProofReplay["Service"]["consume"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
  readonly provision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["provision"];
  readonly ensureAccount?: ConnectAccounts.ConnectAccounts["Service"]["ensureAccount"];
}) {
  return EnvironmentLinker.layer.pipe(
    Layer.provideMerge(RelayTokens.layer),
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        Layer.succeed(ConnectAccounts.ConnectAccounts, {
          ensureAccount:
            input?.ensureAccount ??
            ((account) =>
              Effect.succeed({
                userId: account.userId,
                promoId: null,
                founderNumber: null,
                createdAt: "2026-10-28T00:00:00.000Z",
              })),
          foundersSummary: () => Effect.die("unused"),
        }),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume: () => Effect.die("unexpected DPoP proof verification"),
          consume: input?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: Effect.void,
        }),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          upsert: input?.upsert ?? (() => Effect.void),
          listDeliveryUsersForEnvironment: () => Effect.succeed([]),
          listForUser: () => Effect.succeed([]),
          getForUser: () => Effect.succeed(null),
          findActiveManagedForEnvironment: () => Effect.succeed([]),
          setHoldWebhooksWhileOffline: () => Effect.void,
          revokeForUser: () => Effect.succeed(false),
        }),
        Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
          create: () => Effect.succeed("studioenv_credential_secret"),
          authenticate: () => Effect.succeedNone,
          revokeForEnvironmentPublicKey: () => Effect.succeed(false),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          reconcileOrigin: () => Effect.succeed("ready"),
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: input?.deprovision ?? (() => Effect.succeed(true)),
          release: () => Effect.succeed(true),
          provision:
            input?.provision ??
            (() =>
              Effect.succeed({
                endpoint: {
                  httpBaseUrl: "https://managed.example.test/",
                  wsBaseUrl: "wss://managed.example.test/ws",
                  providerKind: "cloudflare_tunnel",
                },
                runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
              })),
        }),
      ),
    ),
  );
}

describe("EnvironmentLinker", () => {
  it.effect("uses verified JWT claims when linking an environment", () => {
    let persistedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const { request, payload } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentId).toBe(payload.environmentId);
      expect(result.environmentCredential).toBe("studioenv_credential_secret");
      expect(persistedEnvironmentId).toBe(payload.environmentId);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEnvironmentId = input.proof.environmentId;
            }),
        }),
      ),
    );
  });

  it.effect("links a publish-only environment with a non-secure nominal endpoint", () => {
    let persistedEndpoint: string | null = null;
    let deprovisionedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 5 });
      const relayTokens = yield* RelayTokens.RelayTokens;
      const challenge = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: false,
        },
        jti: "publish-only-challenge-jti",
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
      });
      const payload = {
        iss: "studio-env:env-link-test",
        aud: "https://relay.example.test",
        sub: "env-link-test",
        jti: "publish-only-proof-jti",
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        challenge,
        environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
        descriptor: {
          environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
          label: "Link Test Environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        environmentPublicKey: environmentKeyPair.publicKey.trim(),
        endpoint: {
          httpBaseUrl: "http://127.0.0.1:8319/",
          wsBaseUrl: "ws://127.0.0.1:8319/",
          providerKind: "manual",
        },
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
        scopes: ["agent_activity_notifications"],
      } satisfies RelayEnvironmentLinkProofPayload;
      const request = {
        proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: false,
      } satisfies RelayEnvironmentLinkRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentCredential).toBe("studioenv_credential_secret");
      expect(result.endpointRuntime).toBeNull();
      expect(persistedEndpoint).toBe("http://127.0.0.1:8319/");
      // Downgrading from a managed link must release the previously provisioned
      // tunnel; nothing else cleans it up before a full unlink.
      expect(deprovisionedEnvironmentId).toBe("env-link-test");
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEndpoint = input.endpoint.httpBaseUrl;
            }),
          deprovision: (input) =>
            Effect.sync(() => {
              deprovisionedEnvironmentId = input.environmentId;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects a tampered compact proof before persistence", () => {
    let persisted = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const tampered = { ...request, proof: segments.join(".") };
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request: tampered }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "invalid_signature_or_scope",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
      expect(persisted).toBe(false);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects replayed JWT ids", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "replayed_nonce",
            stage: "consume_proof_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layerTest({ consume: () => Effect.succeed(false) }))),
  );
  it.effect("creates the Connect account only after a managed link succeeded", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({
        userId: "user_123",
        request: { ...request, managedTunnelsEnabled: true },
      });
      expect(result.endpoint.httpBaseUrl).toBe("https://managed.example.test/");
      expect(calls).toEqual(["provision:user_123", "upsert:user_123", "ensure-account:user_123"]);
    }).pipe(
      Effect.provide(
        layerTest({
          ensureAccount: (account) =>
            Effect.sync(() => {
              calls.push(`ensure-account:${account.userId}`);
              return {
                userId: account.userId,
                promoId: ConnectAccounts.FOUNDERS_PROMO_ID,
                founderNumber: 1,
                createdAt: "2026-10-28T00:00:00.000Z",
              };
            }),
          upsert: (upsertInput) =>
            Effect.sync(() => {
              calls.push(`upsert:${upsertInput.userId}`);
            }),
          provision: (provisionInput) =>
            Effect.sync(() => {
              calls.push(`provision:${provisionInput.userId}`);
              return {
                endpoint: {
                  httpBaseUrl: "https://managed.example.test/",
                  wsBaseUrl: "wss://managed.example.test/ws",
                  providerKind: "cloudflare_tunnel",
                },
                runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
              };
            }),
        }),
      ),
    );
  });

  it.effect("does not create a Connect account for a publish-only link", () => {
    let ensured = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      yield* linker.link({ userId: "user_123", request });
      expect(ensured).toBe(false);
    }).pipe(
      Effect.provide(
        layerTest({
          ensureAccount: () =>
            Effect.sync(() => {
              ensured = true;
              return {
                userId: "user_123",
                promoId: null,
                founderNumber: null,
                createdAt: "2026-10-28T00:00:00.000Z",
              };
            }),
        }),
      ),
    );
  });

  it.effect("takes no founder seat when provisioning refuses the machine", () => {
    let ensured = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const error = yield* linker
        .link({ userId: "user_123", request: { ...request, managedTunnelsEnabled: true } })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ManagedTunnelLimitExceeded");
      expect(ensured).toBe(false);
    }).pipe(
      Effect.provide(
        layerTest({
          ensureAccount: () =>
            Effect.sync(() => {
              ensured = true;
              return {
                userId: "user_123",
                promoId: null,
                founderNumber: null,
                createdAt: "2026-10-28T00:00:00.000Z",
              };
            }),
          provision: (provisionInput) =>
            Effect.fail(
              new ManagedTunnelLimits.ManagedTunnelLimitExceeded({
                userId: provisionInput.userId,
                environmentId: provisionInput.environmentId,
                reason: "service_capacity",
                maxTunnels: 10,
                activeTunnels: 0,
                globalCap: 180,
                globalActiveTunnels: 180,
              }),
            ),
        }),
      ),
    );
  });
});
