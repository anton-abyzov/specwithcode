// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  RelayAccessTokenType,
  RelayApi,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
  RelayJwtSubjectTokenType,
  type RelayDeviceRegistrationRequest,
} from "@specweave-studio/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as ClerkSessions from "../auth/ClerkSessions.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as ClientKeyRevocations from "../environments/ClientKeyRevocations.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as RelayHttpApi from "./Api.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const USER = "user_1";
const RELAY = "https://relay.example.test";
const AUDIENCE = "studio-code-relay";

const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: RELAY,
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
  clerkJwtAudience: AUDIENCE,
  cloudMintPrivateKey: Redacted.make(cloudKeyPair.privateKey),
  cloudMintPublicKey: cloudKeyPair.publicKey,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: undefined,
});

/** Clerk session JWTs in these tests read `clerk:<user>:<sid>`. */
const clerkToken = (sid: string, userId = USER) => `clerk:${userId}:${sid}`;

const registration = (deviceId: string): RelayDeviceRegistrationRequest => ({
  deviceId,
  label: "Anton's iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: "1.4.0",
  model: "iPhone 16 Pro",
  pushToken: `push-${deviceId}`,
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
});

/**
 * The relay's token, mobile, DPoP client, client and server groups over a
 * real SQLite database. DPoP proofs are simplified: the `dpop` header carries
 * the key thumbprint it proves.
 */
const makeRelay = Effect.gen(function* () {
  const sessionCreatedAt = new Map<string, number>();
  const revokedSessions: Array<string> = [];
  const notified: Array<
    ClientKeyRevocations.ClientKeyRevocations["Service"] extends {
      readonly notify: (input: infer I) => unknown;
    }
      ? I
      : never
  > = [];
  const connects: Array<{ readonly deviceId?: string; readonly key: string }> = [];
  const faults = { findBlocking: false };

  // The real service, with removal checks that can be made to fail.
  const layerRemovals = Layer.effect(
    PhoneRemovals.PhoneRemovals,
    Effect.gen(function* () {
      const real = yield* PhoneRemovals.make;
      return PhoneRemovals.PhoneRemovals.of({
        ...real,
        findBlocking: (input) =>
          faults.findBlocking
            ? Effect.fail(
                new PhoneRemovals.PhoneRemovalPersistenceError({
                  userId: input.userId,
                  stage: "find-blocking",
                  cause: "database down",
                }),
              )
            : real.findBlocking(input),
      });
    }),
  );

  const layerServices = Layer.mergeAll(
    layerRemovals,
    Devices.layer,
    RelayTokens.layer,
    Layer.succeed(DpopProofs.DpopProofReplay, {
      verifyAndConsume: (input) =>
        input.proof && (!input.expectedThumbprint || input.proof === input.expectedThumbprint)
          ? Effect.succeed(input.proof)
          : Effect.fail(new DpopProofs.DpopProofRejected({ code: "key_mismatch" })),
      consume: () => Effect.succeed(true),
      pruneExpired: Effect.void,
    }),
    Layer.succeed(ClerkSessions.ClerkSessions, {
      getCreatedAt: (sid) =>
        sid === "sess_broken"
          ? Effect.fail(new ClerkSessions.ClerkSessionLookupFailed({ cause: "down" }))
          : Effect.succeed(sessionCreatedAt.get(sid) ?? null),
      revoke: (sid) => Effect.sync(() => void revokedSessions.push(sid)),
    }),
    Layer.succeed(ClientKeyRevocations.ClientKeyRevocations, {
      notify: (input) => Effect.sync(() => void notified.push(input)),
    }),
    Layer.mock(EnvironmentConnector.EnvironmentConnector, {
      connect: (input) =>
        Effect.sync(() => {
          connects.push({
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            key: input.clientProofKeyThumbprint,
          });
          return {
            environmentId: input.environmentId as never,
            endpoint: {
              httpBaseUrl: "https://env-1.example.test/",
              wsBaseUrl: "wss://env-1.example.test/ws",
              providerKind: "cloudflare_tunnel" as const,
            },
            credential: "pairing-credential",
            expiresAt: "2026-11-01T00:00:00.000Z",
          };
        }),
    }),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {
      findActiveManagedForEnvironment: (input) =>
        Effect.succeed(
          input.environmentId === "env-mac" && input.environmentPublicKey === "mac-key"
            ? [
                {
                  userId: USER,
                  environmentId: "env-mac" as never,
                  label: "Mac",
                  endpoint: {
                    httpBaseUrl: "https://env-mac.example.test/",
                    wsBaseUrl: "wss://env-mac.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  linkedAt: "2026-10-31T00:00:00.000Z",
                  environmentPublicKey: "mac-key",
                  holdWebhooksWhileOffline: false,
                },
              ]
            : [],
        ),
    }),
    Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
    Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
    Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {}),
    Layer.mock(ManagedTunnelLimits.ManagedTunnelLimits, {}),
    Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
    Layer.mock(HookInbox.HookInbox, {}),
    Layer.mock(AccountDeletion.AccountRecords, {}),
    Layer.mock(AccountDeletion.ClerkUsers, {}),
    Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {}),
    Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
    Layer.mock(HeldHooks.HeldHooks, {}),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerSqliteRelayDb(),
        NodeCryptoLayer.layer,
        Layer.succeed(RelayConfiguration.RelayConfiguration, settings),
      ),
    ),
  );
  const context = yield* Layer.build(layerServices);

  // Registration writes the device row as the real service does.
  const layerRegistrations = Layer.effect(
    MobileRegistrations.MobileRegistrations,
    Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      return MobileRegistrations.MobileRegistrations.of({
        registerDevice: (input) =>
          devices
            .register({
              userId: input.userId,
              registration: input.payload,
              proofKeyThumbprint: input.proofKeyThumbprint,
              clerkSessionId: input.clerkSessionId,
            })
            .pipe(Effect.as({ ok: true as const })),
        registerLiveActivity: () => Effect.succeed({ ok: true as const }),
        unregisterDevice: (input) =>
          devices.unregister(input).pipe(Effect.as({ ok: true as const })),
        getAgentActivitySnapshot: () => Effect.die("unused"),
      });
    }),
  );
  const layerContext = Layer.succeedContext(context);
  const api = HttpApi.make("RelayApi").add(
    RelayApi.groups.token,
    RelayApi.groups.mobile,
    RelayApi.groups.dpopClient,
    RelayApi.groups.client,
    RelayApi.groups.server,
  );
  const layerGroups = Layer.mergeAll(
    RelayHttpApi.layerTokenApi,
    RelayHttpApi.layerMobileApi.pipe(Layer.provide(layerRegistrations)),
    RelayHttpApi.layerDpopClientApi,
    RelayHttpApi.layerClientApi,
    RelayHttpApi.layerServerApi,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RelayHttpApi.layerClientAuth,
        RelayHttpApi.layerDpopClientAuth,
        Layer.succeed(RelayEnvironmentAuth, {
          environmentBearer: (effect) =>
            effect.pipe(
              Effect.provideService(RelayEnvironmentPrincipal, {
                environmentId: "env-mac",
                environmentPublicKey: "mac-key",
              }),
            ),
        }),
      ),
    ),
    Layer.provide(layerContext),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(layerGroups),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (app) => Effect.promise(() => app.dispose()),
  );

  const send = (request: Request) =>
    Effect.promise(async () => {
      const response = await app.handler(request, context);
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      };
    });

  const exchange = (input: {
    readonly sid: string;
    readonly key: string;
    readonly deviceId?: string;
    readonly clientId?: "studio-mobile" | "studio-web";
  }) =>
    send(
      new Request(`${RELAY}/v1/client/dpop-token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: input.key },
        body: new URLSearchParams({
          grant_type: RelayDpopTokenExchangeGrantType,
          subject_token: clerkToken(input.sid),
          subject_token_type: RelayJwtSubjectTokenType,
          requested_token_type: RelayAccessTokenType,
          resource: RELAY,
          scope:
            input.clientId === "studio-web"
              ? "environment:connect environment:status"
              : "environment:connect environment:status mobile:registration",
          client_id: input.clientId ?? "studio-mobile",
          ...(input.deviceId ? { device_id: input.deviceId } : {}),
        }),
      }),
    );

  const accessToken = (input: {
    readonly sid: string;
    readonly key: string;
    readonly deviceId?: string;
    readonly clientId?: "studio-mobile" | "studio-web";
  }) =>
    exchange(input).pipe(
      Effect.map((response) => {
        expect(response.status).toBe(200);
        return String(response.body.access_token);
      }),
    );

  const dpopRequest = (
    method: string,
    path: string,
    input: { readonly token: string; readonly key: string; readonly body?: unknown },
  ) =>
    send(
      new Request(`${RELAY}${path}`, {
        method,
        headers: {
          authorization: `DPoP ${input.token}`,
          dpop: input.key,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }),
    );

  const register = (input: {
    readonly token: string;
    readonly key: string;
    readonly deviceId: string;
  }) => dpopRequest("POST", "/v1/mobile/devices", { ...input, body: registration(input.deviceId) });

  const connect = (input: {
    readonly token: string;
    readonly key: string;
    readonly deviceId?: string;
  }) =>
    dpopRequest("POST", "/v1/environments/env-1/connect", {
      ...input,
      body: {
        clientProofKeyThumbprint: input.key,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      },
    });

  const clientRequest = (method: string, path: string, sid: string) =>
    send(
      new Request(`${RELAY}${path}`, {
        method,
        headers: { authorization: `Bearer ${clerkToken(sid)}` },
      }),
    );

  const serverRequest = (method: string, path: string, body?: unknown) =>
    send(
      new Request(`${RELAY}${path}`, {
        method,
        headers: {
          authorization: "Bearer environment-credential",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const removalStatus = (key?: string) =>
    send(
      new Request(`${RELAY}/v1/client/removal-status`, {
        method: "POST",
        headers: key ? { dpop: key } : {},
      }),
    );

  /** A registration from a build that recorded no key or session on it. */
  const seedLegacyDevice = (deviceId: string) =>
    Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.register({ userId: USER, registration: registration(deviceId) });
    }).pipe(Effect.provide(context));

  return {
    faults,
    removalStatus,
    seedLegacyDevice,
    sessionCreatedAt,
    revokedSessions,
    notified,
    connects,
    exchange,
    accessToken,
    register,
    connect,
    clientRequest,
    serverRequest,
  };
});

const withClerk = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.sync(() =>
    vi.mocked(verifyToken).mockImplementation(async (token: string) => {
      const [scheme, sub, sid] = token.split(":");
      if (scheme !== "clerk") throw new Error("not a Clerk token");
      return { sub, sid, aud: AUDIENCE } as never;
    }),
  ).pipe(
    Effect.andThen(effect),
    Effect.ensuring(Effect.sync(() => vi.mocked(verifyToken).mockReset())),
    Effect.scoped,
  );

const removedError = {
  _tag: "RelayAuthInvalidError",
  code: "auth_invalid",
  reason: "device_removed",
};

describe("phone removal over HTTP", () => {
  it.live("refuses a removed phone until it signs in again interactively", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        // The handlers run on the real clock, so these tests do too.
        const now = yield* Clock.currentTimeMillis;
        const phone = { sid: "sess_phone", key: "key-phone", deviceId: "phone-1" };
        relay.sessionCreatedAt.set("sess_phone", now - 60 * 60_000);
        const token = yield* relay.accessToken(phone);
        expect((yield* relay.register({ ...phone, token })).status).toBe(200);
        expect((yield* relay.connect({ ...phone, token })).status).toBe(200);

        const listed = yield* relay.clientRequest("GET", "/v1/client/phones", "sess_phone");
        expect(listed).toMatchObject({
          status: 200,
          body: {
            phones: [
              {
                deviceId: "phone-1",
                label: "Anton's iPhone",
                platform: "ios",
                model: "iPhone 16 Pro",
                appVersion: "1.4.0",
                current: true,
              },
            ],
          },
        });
        // Seen from another session, it is not the caller's phone.
        expect(
          (yield* relay.clientRequest("GET", "/v1/client/phones", "sess_web")).body,
        ).toMatchObject({ phones: [{ deviceId: "phone-1", current: false }] });

        // Removed from the web app.
        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
        ).toEqual({ status: 200, body: { removed: true, current: false } });
        expect(relay.revokedSessions).toEqual(["sess_phone"]);
        expect(relay.notified).toEqual([
          { userId: USER, proofKeyThumbprints: ["key-phone"], exceptEnvironmentId: undefined },
        ]);
        expect((yield* relay.clientRequest("GET", "/v1/client/phones", "sess_web")).body).toEqual({
          phones: [],
        });

        // Already-issued tokens stop working for registration and connect.
        expect(yield* relay.register({ ...phone, token })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(yield* relay.connect({ ...phone, token })).toMatchObject({
          status: 401,
          body: removedError,
        });
        // Silent re-bootstrap with the same Clerk session stays refused,
        // whatever creation time Clerk reports for it.
        expect(yield* relay.exchange(phone)).toMatchObject({ status: 401, body: removedError });
        relay.sessionCreatedAt.set("sess_phone", now + 60_000);
        expect(yield* relay.exchange(phone)).toMatchObject({ status: 401, body: removedError });
        // A session that existed before the removal is not a fresh sign-in.
        relay.sessionCreatedAt.set("sess_old", now - 60_000 * 30);
        expect(yield* relay.exchange({ ...phone, sid: "sess_old" })).toMatchObject({
          status: 401,
          body: removedError,
        });
        // An unknown session or a failed Clerk lookup fails closed.
        expect(yield* relay.exchange({ ...phone, sid: "sess_unknown" })).toMatchObject({
          status: 401,
          body: removedError,
        });
        relay.sessionCreatedAt.set("sess_broken", now + 60_000);
        expect(yield* relay.exchange({ ...phone, sid: "sess_broken" })).toMatchObject({
          status: 401,
          body: removedError,
        });
        // The same phone under a new key is still known by its device id.
        expect(yield* relay.exchange({ ...phone, key: "key-other" })).toMatchObject({
          status: 401,
          body: removedError,
        });

        // A fresh interactive sign-in creates a session after the removal.
        relay.sessionCreatedAt.set("sess_fresh", now + 60_000);
        const fresh = { ...phone, sid: "sess_fresh" };
        const freshToken = yield* relay.accessToken(fresh);
        expect((yield* relay.register({ ...fresh, token: freshToken })).status).toBe(200);
        expect((yield* relay.connect({ ...fresh, token: freshToken })).status).toBe(200);
        // The old session's tokens are no longer refused by the removal
        // itself; Clerk ended that session, so no new ones can be minted.
        expect(
          (yield* relay.clientRequest("GET", "/v1/client/phones", "sess_fresh")).body,
        ).toMatchObject({ phones: [{ deviceId: "phone-1", current: true }] });
      }),
    ),
  );

  it.live("signs the caller out when it removes its own phone", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const phone = { sid: "sess_phone", key: "key-phone", deviceId: "phone-1" };
        const token = yield* relay.accessToken(phone);
        yield* relay.register({ ...phone, token });

        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_phone"),
        ).toEqual({ status: 200, body: { removed: true, current: true } });
        // Its Clerk session is refused from then on, even before Clerk ends it.
        expect(yield* relay.clientRequest("GET", "/v1/client/phones", "sess_phone")).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/missing", "sess_web"),
        ).toEqual({ status: 200, body: { removed: false, current: false } });
      }),
    ),
  );

  it.live("lets a Mac remove a phone it knows only by its DPoP key", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        // A phone that connected but never registered for notifications.
        const phone = { sid: "sess_phone", key: "key-phone" };
        const token = yield* relay.accessToken(phone);
        expect((yield* relay.connect({ ...phone, token })).status).toBe(200);

        expect(
          yield* relay.serverRequest("GET", "/v1/environments/env-mac/client-keys/removed"),
        ).toEqual({ status: 200, body: { proofKeyThumbprints: [] } });
        expect(
          yield* relay.serverRequest("POST", "/v1/environments/env-mac/client-keys/remove", {
            proofKeyThumbprint: "key-phone",
          }),
        ).toEqual({ status: 200, body: { removed: true } });
        // Other environments are told; the Mac already revoked it locally.
        expect(relay.notified).toEqual([
          { userId: USER, proofKeyThumbprints: ["key-phone"], exceptEnvironmentId: "env-mac" },
        ]);
        expect(
          yield* relay.serverRequest("GET", "/v1/environments/env-mac/client-keys/removed"),
        ).toEqual({ status: 200, body: { proofKeyThumbprints: ["key-phone"] } });

        expect(yield* relay.connect({ ...phone, token })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(yield* relay.exchange(phone)).toMatchObject({ status: 401, body: removedError });

        // Another environment cannot act for this one.
        expect(
          (yield* relay.serverRequest("POST", "/v1/environments/env-other/client-keys/remove", {
            proofKeyThumbprint: "key-phone",
          })).status,
        ).toBe(401);
      }),
    ),
  );

  it.live(
    "removes a registration with no key using the key and session its exchange recorded",
    () =>
      withClerk(
        Effect.gen(function* () {
          const relay = yield* makeRelay;
          const now = yield* Clock.currentTimeMillis;
          relay.sessionCreatedAt.set("sess_phone", now - 60 * 60_000);
          // Registered by a build that stored no key or session on the row.
          yield* relay.seedLegacyDevice("phone-1");
          const phone = { sid: "sess_phone", key: "key-phone", deviceId: "phone-1" };
          expect(
            (yield* relay.connect({ ...phone, token: yield* relay.accessToken(phone) })).status,
          ).toBe(200);

          expect(
            yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
          ).toEqual({ status: 200, body: { removed: true, current: false } });
          expect(relay.revokedSessions).toEqual(["sess_phone"]);
          expect(relay.notified).toEqual([
            { userId: USER, proofKeyThumbprints: ["key-phone"], exceptEnvironmentId: undefined },
          ]);

          // An older build sends no device id; its key alone is refused.
          expect(yield* relay.exchange({ sid: "sess_phone", key: "key-phone" })).toMatchObject({
            status: 401,
            body: removedError,
          });
          // Its Clerk session is refused on bearer calls.
          expect(
            yield* relay.clientRequest("GET", "/v1/client/phones", "sess_phone"),
          ).toMatchObject({
            status: 401,
            body: removedError,
          });
          // The key holder can learn why it was signed out.
          expect(yield* relay.removalStatus("key-phone")).toEqual({
            status: 200,
            body: { removed: true },
          });

          // A fresh interactive sign-in still brings it back, old build or not.
          relay.sessionCreatedAt.set("sess_fresh", now + 60_000);
          const freshToken = yield* relay.accessToken({ sid: "sess_fresh", key: "key-phone" });
          expect((yield* relay.connect({ key: "key-phone", token: freshToken })).status).toBe(200);
          expect(
            (yield* relay.clientRequest("GET", "/v1/client/phones", "sess_fresh")).status,
          ).toBe(200);
          expect(yield* relay.removalStatus("key-phone")).toEqual({
            status: 200,
            body: { removed: false },
          });
        }),
      ),
  );

  it.live("completes a removal with the key and session the phone shows next", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const now = yield* Clock.currentTimeMillis;
        relay.sessionCreatedAt.set("sess_phone", now - 60 * 60_000);
        // An older build: no device id on its exchange, none on its registration row.
        const phone = { sid: "sess_phone", key: "key-phone" };
        const token = yield* relay.accessToken(phone);
        yield* relay.seedLegacyDevice("phone-1");

        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
        ).toEqual({ status: 200, body: { removed: true, current: false } });
        // Nothing tied the row to a key or session yet.
        expect(relay.revokedSessions).toEqual([]);
        expect(relay.notified).toEqual([
          { userId: USER, proofKeyThumbprints: [], exceptEnvironmentId: undefined },
        ]);

        // Its next DPoP call names the device: the removal takes its key and session.
        expect(yield* relay.register({ ...phone, token, deviceId: "phone-1" })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(relay.revokedSessions).toEqual(["sess_phone"]);
        expect(relay.notified.at(-1)).toEqual({
          userId: USER,
          proofKeyThumbprints: ["key-phone"],
        });
        // Now the key alone is refused, and the backfill ran once.
        expect(yield* relay.connect({ ...phone, token })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(relay.revokedSessions).toEqual(["sess_phone"]);
        expect(relay.notified).toHaveLength(2);
      }),
    ),
  );

  it.live("lets a phone that signed in again after its removal register", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const now = yield* Clock.currentTimeMillis;
        // Removed by device id alone: the row recorded no key or session.
        yield* relay.seedLegacyDevice("phone-1");
        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
        ).toMatchObject({ status: 200, body: { removed: true } });

        // A fresh sign-in from a build that sends no device id on its exchange.
        relay.sessionCreatedAt.set("sess_fresh", now + 60_000);
        const fresh = { sid: "sess_fresh", key: "key-phone", deviceId: "phone-1" };
        const token = yield* relay.accessToken({ sid: fresh.sid, key: fresh.key });
        expect((yield* relay.register({ ...fresh, token })).status).toBe(200);
        // Not signed out again, and the removal is gone.
        expect(relay.revokedSessions).toEqual([]);
        expect((yield* relay.register({ ...fresh, token })).status).toBe(200);
        expect((yield* relay.connect({ ...fresh, token })).status).toBe(200);
        expect(
          (yield* relay.clientRequest("GET", "/v1/client/phones", "sess_fresh")).body,
        ).toMatchObject({ phones: [{ deviceId: "phone-1", current: true }] });
      }),
    ),
  );

  it.live("ends only a session known to predate the removal on a refused registration", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const now = yield* Clock.currentTimeMillis;
        yield* relay.seedLegacyDevice("phone-1");
        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
        ).toMatchObject({ status: 200, body: { removed: true } });

        // Clerk cannot say when this session began: refused, not ended.
        const unknown = { sid: "sess_unknown", key: "key-unknown", deviceId: "phone-1" };
        const unknownToken = yield* relay.accessToken({ sid: unknown.sid, key: unknown.key });
        expect(yield* relay.register({ ...unknown, token: unknownToken })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(relay.revokedSessions).toEqual([]);

        // An old build's session from before the removal: refused and ended.
        relay.sessionCreatedAt.set("sess_old", now - 60 * 60_000);
        const old = { sid: "sess_old", key: "key-old", deviceId: "phone-1" };
        const oldToken = yield* relay.accessToken({ sid: old.sid, key: old.key });
        expect(yield* relay.register({ ...old, token: oldToken })).toMatchObject({
          status: 401,
          body: removedError,
        });
        expect(relay.revokedSessions).toEqual(["sess_old"]);
      }),
    ),
  );

  it.live("completes a removal from a refused token exchange, never with an unproven session", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const now = yield* Clock.currentTimeMillis;
        yield* relay.seedLegacyDevice("phone-1");
        expect(
          yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web"),
        ).toMatchObject({ status: 200, body: { removed: true } });

        // Clerk cannot say when this session began: it might be a fresh
        // sign-in, so it is refused but not ended.
        expect(
          yield* relay.exchange({ sid: "sess_unknown", key: "key-phone", deviceId: "phone-1" }),
        ).toMatchObject({ status: 401, body: removedError });
        expect(relay.revokedSessions).toEqual([]);
        expect(relay.notified.at(-1)).toEqual({ userId: USER, proofKeyThumbprints: ["key-phone"] });

        // A session from before the removal is the phone's old one: ended.
        relay.sessionCreatedAt.set("sess_old", now - 60 * 60_000);
        expect(
          yield* relay.exchange({ sid: "sess_old", key: "key-phone", deviceId: "phone-1" }),
        ).toMatchObject({ status: 401, body: removedError });
        expect(relay.revokedSessions).toEqual(["sess_old"]);
        expect(yield* relay.clientRequest("GET", "/v1/client/phones", "sess_old")).toMatchObject({
          status: 401,
          body: removedError,
        });
      }),
    ),
  );

  it.live("leaves another browser's key to the Mac alone", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const browser = { sid: "sess_web", key: "key-web", clientId: "studio-web" as const };
        const token = yield* relay.accessToken(browser);

        expect(
          yield* relay.serverRequest("POST", "/v1/environments/env-mac/client-keys/remove", {
            proofKeyThumbprint: "key-web",
          }),
        ).toEqual({ status: 200, body: { removed: false } });
        // A key the relay never saw a phone use is not removed either.
        expect(
          yield* relay.serverRequest("POST", "/v1/environments/env-mac/client-keys/remove", {
            proofKeyThumbprint: "key-unknown",
          }),
        ).toEqual({ status: 200, body: { removed: false } });
        expect(relay.revokedSessions).toEqual([]);
        expect(relay.notified).toEqual([
          { userId: USER, proofKeyThumbprints: [], exceptEnvironmentId: "env-mac" },
          { userId: USER, proofKeyThumbprints: [], exceptEnvironmentId: "env-mac" },
        ]);
        expect(
          yield* relay.serverRequest("GET", "/v1/environments/env-mac/client-keys/removed"),
        ).toEqual({ status: 200, body: { proofKeyThumbprints: [] } });
        expect((yield* relay.connect({ ...browser, token })).status).toBe(200);
        expect((yield* relay.exchange(browser)).status).toBe(200);
      }),
    ),
  );

  it.live("answers removal status for the proof's key only", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        const phone = { sid: "sess_phone", key: "key-phone", deviceId: "phone-1" };
        const token = yield* relay.accessToken(phone);
        yield* relay.register({ ...phone, token });

        expect(yield* relay.removalStatus("key-phone")).toEqual({
          status: 200,
          body: { removed: false },
        });
        yield* relay.clientRequest("DELETE", "/v1/client/phones/phone-1", "sess_web");
        expect(yield* relay.removalStatus("key-phone")).toEqual({
          status: 200,
          body: { removed: true },
        });
        expect(yield* relay.removalStatus("key-other")).toEqual({
          status: 200,
          body: { removed: false },
        });
        // No proof, no answer.
        expect((yield* relay.removalStatus()).status).toBe(400);
      }),
    ),
  );

  it.live("answers a failed removal check on a bearer call with an internal error", () =>
    withClerk(
      Effect.gen(function* () {
        const relay = yield* makeRelay;
        relay.faults.findBlocking = true;
        expect(yield* relay.clientRequest("GET", "/v1/client/phones", "sess_web")).toMatchObject({
          status: 500,
          body: {
            _tag: "RelayInternalError",
            code: "internal_error",
            reason: "persistence_failed",
          },
        });
      }),
    ),
  );
});
