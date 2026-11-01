// @effect-diagnostics-next-line nodeBuiltinImport:off - real Ed25519 keys for the relay's mint key.
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@specweave-studio/contracts";
import {
  RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
  RELAY_MINT_REQUEST_TYP,
  signRelayJwt,
} from "@specweave-studio/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as ConnectPhoneRevocation from "./ConnectPhoneRevocation.ts";

const environmentId = EnvironmentId.make("env-revoke-test");
const relayUrl = "https://relay.spec-weave.com";
const linkedUserId = "user_owner";

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519");
const mintPrivateKey = mintKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const mintPublicKey = mintKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

const alreadyExists = (name: string) =>
  new ServerSecretStore.SecretStorePersistError({
    resource: name,
    cause: PlatformError.systemError({
      _tag: "AlreadyExists",
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: `${name}.bin`,
    }),
  });

function makeMemorySecretStore(initial: ReadonlyArray<readonly [string, string]>) {
  const values = new Map<string, Uint8Array>(
    initial.map(([name, value]) => [name, new TextEncoder().encode(value)] as const),
  );
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) =>
      values.has(name)
        ? Effect.fail(alreadyExists(name))
        : Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  return { store, values };
}

const linkedSecrets = [
  [CLOUD_MINT_PUBLIC_KEY, mintPublicKey],
  [RELAY_ISSUER_SECRET, relayUrl],
  [RELAY_URL_SECRET, relayUrl],
  [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
  [CLOUD_LINKED_USER_ID, linkedUserId],
] as const;

interface Harness {
  readonly secrets?: ReadonlyArray<readonly [string, string]>;
  readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
}

const makeHarness = (input: Harness = {}) => {
  const { store } = makeMemorySecretStore(input.secrets ?? linkedSecrets);
  const revokedKeys: Array<ReadonlyArray<string>> = [];
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = ConnectPhoneRevocation.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        revokeSessionsByProofKeyThumbprints: (proofKeyThumbprints) =>
          Effect.sync(() => {
            revokedKeys.push(proofKeyThumbprints);
            return proofKeyThumbprints.length;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request);
            const response = input.respond?.(request) ?? Response.json({}, { status: 500 });
            return HttpClientResponse.fromWeb(request, response);
          }),
        ),
      ),
    ),
  );
  return { layer, revokedKeys, requests };
};

// Proofs are dated by the Effect clock, which the service checks them against.
const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((millis) => Math.floor(millis / 1_000)));

const signRevokeOrder = (
  overrides: (now: number) => Record<string, unknown> = () => ({}),
  typ?: string,
) =>
  Effect.gen(function* () {
    const now = yield* nowSeconds;
    return yield* signRelayJwt({
      privateKey: mintPrivateKey,
      typ: typ ?? RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
      payload: {
        iss: relayUrl,
        aud: `studio-env:${environmentId}`,
        sub: linkedUserId,
        jti: NodeCrypto.randomUUID(),
        iat: now,
        exp: now + 120,
        environmentId,
        proofKeyThumbprints: ["phone-key-1", "phone-key-2"],
        nonce: NodeCrypto.randomUUID(),
        scope: ["environment:revoke-client"],
        ...overrides(now),
      },
    });
  });

describe("ConnectPhoneRevocation.revokeClientKeys", () => {
  it.effect("ends every session bound to the ordered keys", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      const proof = yield* signRevokeOrder();
      expect(yield* revocation.revokeClientKeys({ proof })).toEqual({ revoked: 2 });
      expect(harness.revokedKeys).toEqual([["phone-key-1", "phone-key-2"]]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a replayed order", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      const proof = yield* signRevokeOrder();
      yield* revocation.revokeClientKeys({ proof });
      const replay = yield* Effect.flip(revocation.revokeClientKeys({ proof }));
      expect(replay._tag).toBe("CloudLinkProofReplayedError");
      expect(harness.revokedKeys).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "another account", overrides: () => ({ sub: "user_other" }) },
    { name: "another environment", overrides: () => ({ environmentId: "env-other" }) },
    { name: "another audience", overrides: () => ({ aud: "studio-env:env-other" }) },
    { name: "a wider scope", overrides: () => ({ scope: ["environment:revoke-client", "x"] }) },
    { name: "a different scope", overrides: () => ({ scope: ["environment:connect"] }) },
    { name: "an unbounded lifetime", overrides: (now: number) => ({ exp: now + 3_600 }) },
    { name: "no keys", overrides: () => ({ proofKeyThumbprints: [] }) },
  ])("refuses an order for $name", ({ overrides }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      const proof = yield* signRevokeOrder(overrides);
      const error = yield* Effect.flip(revocation.revokeClientKeys({ proof }));
      expect(error._tag).toBe("CloudLinkProofRejectedError");
      expect(error.message).toBe("Invalid cloud revoke request.");
      expect(harness.revokedKeys).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a proof of another kind or signed by another key", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      const mintTyped = yield* signRevokeOrder(undefined, RELAY_MINT_REQUEST_TYP);
      const now = yield* nowSeconds;
      const otherKey = NodeCrypto.generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const forged = yield* signRelayJwt({
        privateKey: otherKey,
        typ: RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
        payload: {
          iss: relayUrl,
          aud: `studio-env:${environmentId}`,
          sub: linkedUserId,
          jti: "jti",
          iat: now,
          exp: now + 60,
          environmentId,
          proofKeyThumbprints: ["phone-key-1"],
          nonce: "nonce",
          scope: ["environment:revoke-client"],
        },
      });
      for (const proof of [mintTyped, forged]) {
        const error = yield* Effect.flip(revocation.revokeClientKeys({ proof }));
        expect(error._tag).toBe("CloudLinkProofRejectedError");
      }
      expect(harness.revokedKeys).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails as internal when this environment was never linked", () => {
    const harness = makeHarness({ secrets: [] });
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      const error = yield* Effect.flip(revocation.revokeClientKeys({ proof: "proof" }));
      expect(error._tag).toBe("ServerAuthCloudMintPublicKeyMissingError");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("ConnectPhoneRevocation relay calls", () => {
  it.effect("removes a revoked phone's key from the account", () => {
    const harness = makeHarness({ respond: () => Response.json({ removed: true }) });
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      expect(yield* revocation.removeAtRelay("phone-key-1")).toBe(true);
      const [request] = harness.requests;
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe(`${relayUrl}/v1/environments/${environmentId}/client-keys/remove`);
      expect(request?.headers.authorization).toBe("Bearer environment-credential");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers false quietly when the relay finds no phone with the key", () => {
    const harness = makeHarness({ respond: () => Response.json({ removed: false }) });
    const levels: Array<string> = [];
    const logger = Logger.make(({ logLevel }) => void levels.push(logLevel));
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      expect(yield* revocation.removeAtRelay("web-key")).toBe(false);
      expect(harness.requests).toHaveLength(1);
      // A browser's key is not a failure: nothing is logged as a warning or error.
      expect(levels.filter((level) => level === "Warn" || level === "Error")).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.merge(harness.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("never fails a revoke when the relay refuses or is unlinked", () => {
    const failing = makeHarness({ respond: () => new Response("down", { status: 503 }) });
    const unlinked = makeHarness({ secrets: [] });
    return Effect.gen(function* () {
      const fromFailing = yield* ConnectPhoneRevocation.ConnectPhoneRevocation.pipe(
        Effect.flatMap((revocation) => revocation.removeAtRelay("phone-key-1")),
        Effect.provide(failing.layer),
      );
      const fromUnlinked = yield* ConnectPhoneRevocation.ConnectPhoneRevocation.pipe(
        Effect.flatMap((revocation) => revocation.removeAtRelay("phone-key-1")),
        Effect.provide(unlinked.layer),
      );
      expect([fromFailing, fromUnlinked]).toEqual([false, false]);
      expect(unlinked.requests).toEqual([]);
    });
  });

  it.effect("ends the sessions of keys removed while this computer was offline", () => {
    const harness = makeHarness({
      respond: () => Response.json({ proofKeyThumbprints: ["phone-key-3"] }),
    });
    return Effect.gen(function* () {
      const revocation = yield* ConnectPhoneRevocation.ConnectPhoneRevocation;
      expect(yield* revocation.syncRemovedClientKeys()).toBe(1);
      expect(harness.revokedKeys).toEqual([["phone-key-3"]]);
      expect(harness.requests.map((request) => [request.method, request.url])).toEqual([
        ["GET", `${relayUrl}/v1/environments/${environmentId}/client-keys/removed`],
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks at startup and again every catch-up interval", () => {
    const harness = makeHarness({
      respond: () => Response.json({ proofKeyThumbprints: ["phone-key-3"] }),
    });
    const checks = () =>
      harness.requests.filter((request) => request.url.endsWith("/client-keys/removed")).length;
    return Effect.gen(function* () {
      yield* Layer.build(ConnectPhoneRevocation.layerStartupSync);
      yield* TestClock.adjust("1 second");
      expect(checks()).toBe(1);
      yield* TestClock.adjust("9 minutes");
      expect(checks()).toBe(1);
      yield* TestClock.adjust(ConnectPhoneRevocation.REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL);
      expect(checks()).toBe(2);
      yield* TestClock.adjust(ConnectPhoneRevocation.REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL);
      expect(checks()).toBe(3);
      expect(harness.revokedKeys).toEqual([["phone-key-3"], ["phone-key-3"], ["phone-key-3"]]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("keeps checking after a check fails", () => {
    let calls = 0;
    const harness = makeHarness({
      respond: () =>
        (calls += 1) <= 4
          ? new Response("down", { status: 503 })
          : Response.json({ proofKeyThumbprints: ["phone-key-4"] }),
    });
    return Effect.gen(function* () {
      yield* Layer.build(ConnectPhoneRevocation.layerStartupSync);
      // The first check and its three retries fail; it gives up quietly.
      yield* TestClock.adjust("1 minute");
      expect(calls).toBe(4);
      expect(harness.revokedKeys).toEqual([]);
      yield* TestClock.adjust(ConnectPhoneRevocation.REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL);
      expect(harness.revokedKeys).toEqual([["phone-key-4"]]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("revokes nothing when no phone was removed or the environment is unlinked", () => {
    const empty = makeHarness({ respond: () => Response.json({ proofKeyThumbprints: [] }) });
    const unlinked = makeHarness({ secrets: [] });
    return Effect.gen(function* () {
      for (const harness of [empty, unlinked]) {
        const revoked = yield* ConnectPhoneRevocation.ConnectPhoneRevocation.pipe(
          Effect.flatMap((revocation) => revocation.syncRemovedClientKeys()),
          Effect.provide(harness.layer),
        );
        expect(revoked).toBe(0);
        expect(harness.revokedKeys).toEqual([]);
      }
      expect(unlinked.requests).toEqual([]);
    });
  });
});
