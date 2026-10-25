import { sha256 } from "../nodeCrypto.ts";
import { FLEET_INVITE_SCOPES, issueFleetManagementSession } from "../studioFleetInvite.ts";
import * as DeviceSignInHttp from "../auth/deviceSignInHttp.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  EnvironmentId,
  type AuthCreatePairingCredentialInput,
  EnvironmentHttpApi,
} from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { mintWorkerGrant, workerClientName } from "../fleet/workerGrantMint.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthHttp from "../auth/http.ts";

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .add(EnvironmentHttpApi.groups.deviceSignIn) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-oauth-test-" });
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
// Each router gets its own database; the capture hands that router's EnvironmentAuth to its test.
const makeLayerRoutes = (
  capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void,
  beforeIssue?: () => Effect.Effect<void>,
) => {
  const authLayer = beforeIssue
    ? Layer.effect(
        EnvironmentAuth.EnvironmentAuth,
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          return EnvironmentAuth.EnvironmentAuth.of({
            ...auth,
            issueMcpClientSession: (input) =>
              beforeIssue().pipe(Effect.andThen(auth.issueMcpClientSession(input))),
          });
        }),
      ).pipe(Layer.provideMerge(layerEnvironmentAuth))
    : layerEnvironmentAuth;
  return Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(DeviceSignInHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provideMerge(authLayer),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "https://box.example.ts.net";
const REDIRECT = "http://localhost/callback";
const verifier = "a".repeat(43) + "-verifier-for-tests";
/** base64url(SHA-256(verifier)), the S256 challenge for `verifier`. */
const challenge = Buffer.from(sha256([verifier])).toString("base64url");

/** Requests as they arrive behind an https proxy: plain http with the public Host. */
const at = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { host: "box.example.ts.net", "x-forwarded-proto": "https", ...init?.headers },
  });
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

type Handler = (request: Request) => Effect.Effect<Response>;

const withRoutes = <A, E>(
  use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  beforeIssue?: () => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let routerAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const layerRoutes = makeLayerRoutes((auth) => {
      routerAuth = auth;
    }, beforeIssue);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          // The router builds its layer on first request; a metadata read warms it.
          yield* handler(at("/.well-known/oauth-authorization-server"));
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

const postJson = (path: string, body: unknown, cookie?: string) =>
  at(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: encodeJson(body),
  });

/** What the approval page posts: the agent's request plus the user's choice. */
const decide = (
  handler: Handler,
  authorization: Record<string, string>,
  decision: Record<string, string>,
  cookie?: string,
) =>
  handler(postJson("/oauth/mcp/decision", { authorization, decision }, cookie)).pipe(
    Effect.flatMap((response) =>
      json<{ redirectTo?: string; message?: string }>(response).pipe(
        Effect.map((payload) => ({ status: response.status, ...payload })),
      ),
    ),
  );

const register = (handler: Handler, redirect = REDIRECT, name = "Claude Code") =>
  handler(
    at("/oauth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson({
        client_name: name,
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );

const registeredClientId = (handler: Handler) =>
  register(handler).pipe(
    Effect.flatMap((response) => json<{ client_id: string }>(response)),
    Effect.map((body) => body.client_id),
  );

const authorizeParams = (clientId: string, redirect = "http://localhost:51234/callback") => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "state-1",
  resource: `${ORIGIN}/mcp`,
});

const mcpRequest = (token: string) =>
  HttpServerRequest.fromWeb(at("/mcp", { headers: { authorization: `Bearer ${token}` } }));
const exchange = (handler: Handler, clientId: string, redirect: string) => {
  const params = authorizeParams(clientId);
  return handler(
    at(
      "/oauth/mcp/token",
      form({
        grant_type: "authorization_code",
        code: new URL(redirect).searchParams.get("code")!,
        redirect_uri: params.redirect_uri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    ),
  );
};

it.live("R-E-01 pending OAuth approval must not survive revoke and restore", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const coordinator = {
        kind: "coordinator" as const,
        environmentId: EnvironmentId.make("peer-old-approval"),
      };
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential({
        coordinatorEnvironmentId: coordinator.environmentId,
      });
      const approved = yield* decide(handler, authorizeParams(clientId), {
        _tag: "pairing-code",
        access: "auto",
        code: pairing.credential,
      });
      expect(approved.status).toBe(200);
      yield* auth.setPrincipalRevoked(coordinator, true);
      yield* auth.setPrincipalRevoked(coordinator, false);
      const response = yield* exchange(handler, clientId, approved.redirectTo!);
      // A pre-revocation approval must be spent; owner restore requires fresh approval.
      expect(response.status).toBe(400);
    }),
  ),
);

it.live("control: sessions exchanged while principal is revoked cannot authenticate", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const coordinator = {
        kind: "coordinator" as const,
        environmentId: EnvironmentId.make("peer-banned"),
      };
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential({
        coordinatorEnvironmentId: coordinator.environmentId,
      });
      const approved = yield* decide(handler, authorizeParams(clientId), {
        _tag: "pairing-code",
        access: "auto",
        code: pairing.credential,
      });
      yield* auth.setPrincipalRevoked(coordinator, true);
      const response = yield* exchange(handler, clientId, approved.redirectTo!);
      const token = yield* json<{ access_token: string }>(response);
      expect(response.status).toBe(400);
      expect(token.access_token).toBeUndefined();
    }),
  ),
);

it.live("R-E-02 delegated device approval must retain principal and revocation", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const coordinator = {
        kind: "coordinator" as const,
        environmentId: EnvironmentId.make("delegated-approver"),
      };
      const managementCode = yield* auth.issuePairingCredential({
        coordinatorEnvironmentId: coordinator.environmentId,
        scopes: AuthAdministrativeScopes,
      });
      const manager = yield* auth.exchangeBootstrapCredentialForAccessToken(
        managementCode.credential,
        undefined,
        { deviceType: "desktop" },
      );
      const start = yield* handler(postJson("/api/auth/device-sign-in/start", {}));
      expect(start.status).toBe(200);
      const waiting = yield* json<{ requestId: string; pollToken: string; code: string }>(start);
      const approve = yield* handler(
        at("/api/auth/device-sign-in/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${manager.access_token}`,
          },
          body: encodeJson({ code: waiting.code, confirm: true }),
        }),
      );
      expect(approve.status).toBe(403);
      const polled = yield* handler(
        postJson("/api/auth/device-sign-in/poll", {
          requestId: waiting.requestId,
          pollToken: waiting.pollToken,
        }),
      );
      expect(yield* json<unknown>(polled)).not.toHaveProperty("credential");
    }),
  ),
);

it.live(
  "R-E-03 fleet invitation session must bind to its coordinator before delegated code mint",
  () =>
    withRoutes((handler, auth) =>
      Effect.gen(function* () {
        // Exactly the production issueFleetInvitation issuance arguments, without real Tailscale.
        const invited = yield* issueFleetManagementSession(EnvironmentId.make("invited-peer")).pipe(
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
        );
        const codeResponse = yield* handler(
          at("/api/auth/pairing-token", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${invited.token}`,
            },
            body: encodeJson({
              label: "SpecWithCode workers · invited-peer",
              scopes: ["orchestration:read", "orchestration:operate"],
            }),
          }),
        );
        expect(codeResponse.status).toBe(200);
        const pairing = yield* json<{ credential: string }>(codeResponse);
        const reg = yield* register(handler, REDIRECT, "SpecWithCode workers · invited-peer");
        const { client_id } = yield* json<{ client_id: string }>(reg);
        const approved = yield* decide(handler, authorizeParams(client_id), {
          _tag: "pairing-code",
          access: "auto",
          code: pairing.credential,
        });
        // Normal fleet mint must remain usable after fresh approval.
        expect(approved.status).toBe(200);
      }),
    ),
);

it.live("R-E-03 fleet invitation manager must not impersonate an arbitrary coordinator", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const invited = yield* issueFleetManagementSession(EnvironmentId.make("invited-peer")).pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
      );
      const forged = yield* handler(
        at("/api/auth/pairing-token", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${invited.token}` },
          body: encodeJson({
            coordinatorEnvironmentId: "victim-coordinator",
            label: "innocent",
            scopes: ["orchestration:read", "orchestration:operate"],
          }),
        }),
      );
      expect(forged.status).toBe(401);
      expect(JSON.stringify(yield* json<unknown>(forged))).not.toContain("victim-coordinator");
    }),
  ),
);

it.live("control: bound management propagates its principal and refuses switching", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const id = EnvironmentId.make("manager-control");
      const pair = yield* auth.issuePairingCredential({
        coordinatorEnvironmentId: id,
        scopes: AuthAdministrativeScopes,
      });
      const manager = yield* auth.exchangeBootstrapCredentialForAccessToken(
        pair.credential,
        undefined,
        { deviceType: "desktop" },
      );
      const mint = (body: object) =>
        handler(
          at("/api/auth/pairing-token", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${manager.access_token}`,
            },
            body: encodeJson(body),
          }),
        );
      const forged = yield* mint({ coordinatorEnvironmentId: "other-private-id" });
      expect(forged.status).toBe(401);
      expect(JSON.stringify(yield* json<unknown>(forged))).not.toContain("other-private-id");
      const response = yield* mint({ label: "Unrelated display metadata" });
      expect(response.status).toBe(200);
      const code = yield* json<{ credential: string }>(response);
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        code.credential,
        undefined,
        { deviceType: "desktop" },
      );
      expect(
        (yield* auth.authenticateHttpRequest(mcpRequest(token.access_token))).principal,
      ).toEqual({ kind: "coordinator", environmentId: id });
    }),
  ),
);

it.live("R-E-03 invitation management survives coordinator revocation", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const invited = yield* issueFleetManagementSession(EnvironmentId.make("invited-peer")).pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
      );
      const coordinator = {
        kind: "coordinator" as const,
        environmentId: EnvironmentId.make("invited-peer"),
      };
      yield* auth.setPrincipalRevoked(coordinator, true);
      const verified = yield* Effect.exit(auth.authenticateHttpRequest(mcpRequest(invited.token)));
      expect(verified._tag).toBe("Failure");
    }),
  ),
);

it.live("R-E-02 delegated device approval must not create an unscoped OAuth client", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const coordinator = {
        kind: "coordinator" as const,
        environmentId: EnvironmentId.make("delegated-oauth-parent"),
      };
      const bound = yield* auth.issuePairingCredential({
        coordinatorEnvironmentId: coordinator.environmentId,
        scopes: AuthAdministrativeScopes,
      });
      const manager = yield* auth.exchangeBootstrapCredentialForAccessToken(
        bound.credential,
        undefined,
        { deviceType: "desktop" },
      );
      const start = yield* handler(postJson("/api/auth/device-sign-in/start", {}));
      const waiting = yield* json<{ requestId: string; pollToken: string; code: string }>(start);
      const approve = yield* handler(
        at("/api/auth/device-sign-in/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${manager.access_token}`,
          },
          body: encodeJson({ code: waiting.code, confirm: true }),
        }),
      );
      expect(approve.status).toBe(403);
      const polled = yield* handler(
        postJson("/api/auth/device-sign-in/poll", {
          requestId: waiting.requestId,
          pollToken: waiting.pollToken,
        }),
      );
      const deviceCode = yield* json<{ credential?: string }>(polled);
      expect(deviceCode.credential).toBeUndefined();
      const id = yield* registeredClientId(handler);
      const approved = yield* decide(handler, authorizeParams(id), {
        _tag: "pairing-code",
        access: "auto",
        code: deviceCode.credential ?? "unapproved",
      });
      expect(approved.status).toBe(400);
    }),
  ),
);

// Pause after the code is consumed, before the INSERT. Restore must not refresh that approval.
it.live("R-E-01 in-flight OAuth exchange cannot insert after revoke and restore", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let paused = false;
    yield* withRoutes(
      (handler, auth) =>
        Effect.gen(function* () {
          const coordinator = {
            kind: "coordinator" as const,
            environmentId: EnvironmentId.make("paused-exchange"),
          };
          const id = yield* registeredClientId(handler);
          const approve = () =>
            Effect.gen(function* () {
              const pairing = yield* auth.issuePairingCredential({
                coordinatorEnvironmentId: coordinator.environmentId,
              });
              return yield* decide(handler, authorizeParams(id), {
                _tag: "pairing-code",
                access: "auto",
                code: pairing.credential,
              });
            });
          const old = yield* approve();
          const exchanging = yield* Effect.forkChild(exchange(handler, id, old.redirectTo!));
          yield* Deferred.await(entered);
          yield* auth.setPrincipalRevoked(coordinator, true);
          yield* auth.setPrincipalRevoked(coordinator, false);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(exchanging)).status).toBe(400);
          const fresh = yield* approve();
          const response = yield* exchange(handler, id, fresh.redirectTo!);
          expect(response.status).toBe(200);
          const token = yield* json<{ access_token: string }>(response);
          expect(
            (yield* auth.authenticateMcpClient(mcpRequest(token.access_token))).principal,
          ).toEqual(coordinator);
        }),
      () =>
        Effect.gen(function* () {
          if (paused) return;
          paused = true;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
    );
  }),
);

it.live("R-E-03 real worker mint inherits the owner-approved invitation principal", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const coordinatorId = EnvironmentId.make("real-mint-primary");
      const management = yield* issueFleetManagementSession(coordinatorId).pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
      );
      const descriptor = {
        environmentId: EnvironmentId.make("worker-machine"),
        label: "Worker machine",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: {},
      };
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const fetcher: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/.well-known/studio/environment")
          return Promise.resolve(Response.json(descriptor));
        return run(
          handler(
            at(new URL(request.url).pathname, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              ...(init?.body ? { body: init.body } : {}),
            }),
          ),
        );
      };
      const pendingResponse = yield* handler(
        at("/api/auth/pairing-token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${management.token}`,
          },
          body: encodeJson({ label: "Pending child" }),
        }),
      );
      const pending = yield* json<{ credential: string }>(pendingResponse);
      const minted = yield* Effect.promise(() =>
        mintWorkerGrant({
          fetcher,
          target: {
            id: "fixture",
            label: "Untrusted display label",
            url: ORIGIN,
            environmentId: descriptor.environmentId,
            managementToken: management.token,
            scopes: FLEET_INVITE_SCOPES,
          },
          access: "auto",
          clientName: workerClientName(coordinatorId),
        }),
      );
      expect((yield* auth.authenticateMcpClient(mcpRequest(minted.accessToken))).principal).toEqual(
        { kind: "coordinator", environmentId: coordinatorId },
      );
      yield* auth.setPrincipalRevoked({ kind: "coordinator", environmentId: coordinatorId }, true);
      expect(
        (yield* Effect.exit(auth.authenticateMcpClient(mcpRequest(minted.accessToken))))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(auth.authenticateHttpRequest(mcpRequest(management.token))))._tag,
      ).toBe("Failure");
      yield* auth.setPrincipalRevoked({ kind: "coordinator", environmentId: coordinatorId }, false);
      expect(
        (yield* Effect.exit(
          auth.exchangeBootstrapCredentialForAccessToken(pending.credential, undefined, {
            deviceType: "desktop",
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(auth.authenticateMcpClient(mcpRequest(minted.accessToken))))._tag,
      ).toBe("Failure");
    }),
  ),
);
