/**
 * The worker side of fleet over SpecWithCode Connect, against the real auth
 * service: a v2 invitation's one-time credential buys only a management token
 * bound to the redeeming machine's DPoP key, that token works only with a
 * proof, an unbound management token is refused over the Connect address, a
 * Studio Connect (Clerk) session never reaches the endpoints that hand out
 * access, and guessing is rate limited.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthEnvironmentBootstrapTokenType,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ChildProcessSpawner } from "effect/process";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as CredentialFailureLimiter from "./auth/CredentialFailureLimiter.ts";
import { makeTestDpopKey, type TestDpopKey } from "./auth/dpopProof.testkit.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8 } from "./auth/utils.ts";
import * as Config from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as FleetTargets from "./fleet/FleetTargets.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as FleetHttp from "./studioFleetHttp.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the coordinator's fleet file lives in a real temp folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { fleetRequest, makeFleetLink } from "./fleet/fleetTransport.ts";
import { join } from "./nodePath.ts";
import { connectFleet, readFleetConfig } from "./studioFleet.ts";
import { addFleetMachine } from "./studioFleetJoin.ts";
import {
  FLEET_INVITE_SCOPES,
  FLEET_INVITE_SESSION_LABEL,
  FLEET_REDEEM_WINDOW,
  fleetRedeemSubject,
  issueFleetInvitation,
} from "./studioFleetInvite.ts";

class TestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.studioFleet) {}

const WORKER = "env-worker";
const COORDINATOR = EnvironmentId.make("env-coordinator");
/** This worker as the tailnet reaches it through Tailscale Serve. */
const TAILNET = "https://worker.tail1234.ts.net";
/** This worker as SpecWithCode Connect reaches it through its Cloudflare tunnel. */
const CONNECT_HOST = "prod-0123456789abcdef.spec-weave.com";
const CONNECT = `https://${CONNECT_HOST}`;

const layerConfig = Config.layerTest(process.cwd(), { prefix: "studio-fleet-redeem-" });
const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(WORKER)),
    }),
  ),
  Layer.provide(layerConfig),
);
const noTailscale = Layer.merge(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          cause: new Error("not installed"),
        }),
      ),
    ),
  ),
  Layer.succeed(HostProcessPlatform, "linux"),
);
const fetchLayer = Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch);
const serverEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make(WORKER)),
  getDescriptor: Effect.succeed({ environmentId: WORKER, label: "Worker" } as never),
});

const makeLayerRoutes = (capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(
        FleetHttp.layer.pipe(
          Layer.provide(serverEnvironment),
          Layer.provide(noTailscale),
          Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(fetchLayer))),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              FleetTargets.layer.pipe(Layer.provide(fetchLayer)),
            ),
          ),
          Layer.provide(
            FleetWorkerGrants.layer.pipe(
              Layer.provide(FleetTargets.layer.pipe(Layer.provide(fetchLayer))),
              Layer.provide(serverEnvironment),
            ),
          ),
        ),
      ),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    // Each router counts failures on its own, so one test's guesses never block another's.
    Layer.provide(CredentialFailureLimiter.layer),
    Layer.provideMerge(layerAuth),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

type Handler = (request: Request) => Effect.Effect<Response>;
type Via = "local" | "tailnet" | "connect";

/** A request as it arrives here: from loopback, behind Tailscale Serve, or through the tunnel. */
const at = (path: string, via: Via, init: RequestInit & { ip?: string } = {}) => {
  const { ip, ...rest } = init;
  return new Request(`http://127.0.0.1:8319${path}`, {
    ...rest,
    headers: {
      ...(via === "local"
        ? { host: "localhost:8319" }
        : via === "tailnet"
          ? { host: "worker.tail1234.ts.net", "x-forwarded-proto": "https" }
          : {
              host: CONNECT_HOST,
              "x-forwarded-proto": "https",
              "cf-connecting-ip": ip ?? "203.0.113.10",
            }),
      ...rest.headers,
    },
  });
};
const publicUrl = (path: string, via: Via) =>
  `${via === "local" ? "http://localhost:8319" : via === "tailnet" ? TAILNET : CONNECT}${path}`;

const withRoutes = <A, E>(
  use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let routerAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const layerRoutes = makeLayerRoutes((auth) => {
      routerAuth = auth;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          // The router builds its layer on first request.
          yield* handler(at("/api/auth/session", "local"));
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);
const claimsOf = (token: string) =>
  JSON.parse(base64UrlDecodeUtf8(token.split(".")[0]!)) as Record<string, unknown>;

/** What `issueFleetInvitation` mints for a v2 line: nothing a caller can choose. */
const redeemCredential = (auth: EnvironmentAuth.EnvironmentAuth["Service"], days = 30) =>
  auth
    .createPairingLink({
      subject: fleetRedeemSubject(days),
      principal: { kind: "coordinator", environmentId: COORDINATOR },
      scopes: [...FLEET_INVITE_SCOPES],
      label: FLEET_INVITE_SESSION_LABEL,
      ttl: FLEET_REDEEM_WINDOW,
    })
    .pipe(Effect.map((issued) => issued.credential));

const REDEEM_PATH = "/api/studio/fleet/invitation/redeem";
const redeem = (
  handler: Handler,
  key: TestDpopKey,
  credential: string,
  options: { via?: Via; coordinatorEnvironmentId?: string; dpop?: string } = {},
) => {
  const via = options.via ?? "connect";
  return handler(
    at(REDEEM_PATH, via, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        dpop: options.dpop ?? key.proof({ method: "POST", url: publicUrl(REDEEM_PATH, via) }),
      },
      body: JSON.stringify({
        credential,
        coordinatorEnvironmentId: options.coordinatorEnvironmentId ?? COORDINATOR,
      }),
    }),
  );
};

const TICKET_PATH = "/api/auth/websocket-ticket";
/** Any call behind the authenticated middleware, with the given authorization. */
const ticket = (handler: Handler, via: Via, headers: Record<string, string>, ip?: string) =>
  handler(at(TICKET_PATH, via, { method: "POST", headers, ...(ip ? { ip } : {}) }));
const proven = (key: TestDpopKey, token: string, method: string, path: string, via: Via) => ({
  authorization: `DPoP ${token}`,
  dpop: key.proof({ method, url: publicUrl(path, via), accessToken: token }),
});

it.live("redeems a v2 line once, for a token bound to the redeeming key", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      const credential = yield* redeemCredential(auth, 30);
      const before = (yield* auth.listSessions()).length;
      const response = yield* redeem(handler, key, credential);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const redeemed = yield* json<{
        managementToken: string;
        sessionId: string;
        expiresAt: string;
      }>(response);
      expect(claimsOf(redeemed.managementToken)).toMatchObject({
        sub: "fleet-invitation",
        method: "dpop-access-token",
        jkt: key.thumbprint,
      });
      const session = (yield* auth.listSessions()).find(
        (entry) => entry.sessionId === redeemed.sessionId,
      );
      expect(session).toMatchObject({
        subject: "fleet-invitation",
        method: "dpop-access-token",
        client: { label: FLEET_INVITE_SESSION_LABEL },
      });
      expect([...session!.scopes].toSorted()).toEqual([...FLEET_INVITE_SCOPES].toSorted());
      // @effect-diagnostics-next-line globalDateInEffect:off -- compares against a wall-clock expiry.
      const days = (Date.parse(redeemed.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
      expect((yield* auth.listSessions()).length).toBe(before + 1);

      // One time only.
      const again = yield* redeem(handler, key, credential);
      expect(again.status).toBe(401);
      expect((yield* auth.listSessions()).length).toBe(before + 1);
    }),
  ),
);

it.live("takes principal and scopes from the line, never from the request", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      const credential = yield* redeemCredential(auth);
      const before = (yield* auth.listSessions()).length;
      const extra = yield* handler(
        at(REDEEM_PATH, "connect", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            dpop: key.proof({ method: "POST", url: publicUrl(REDEEM_PATH, "connect") }),
          },
          body: JSON.stringify({
            credential,
            coordinatorEnvironmentId: COORDINATOR,
            scopes: ["access:write"],
          }),
        }),
      );
      expect(extra.status).toBe(400);

      // A line made for another main machine is spent and refused.
      const mismatch = yield* redeem(handler, key, credential, {
        coordinatorEnvironmentId: "env-other",
      });
      expect(mismatch.status).toBe(400);
      expect((yield* redeem(handler, key, credential)).status).toBe(401);
      expect((yield* auth.listSessions()).length).toBe(before);
    }),
  ),
);

it.live("refuses a redeem without a valid proof, leaving the line unspent", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      const credential = yield* redeemCredential(auth);
      for (const dpop of [
        "not-a-proof",
        key.proof({ method: "GET", url: publicUrl(REDEEM_PATH, "connect") }),
        key.proof({ method: "POST", url: publicUrl(REDEEM_PATH, "tailnet") }),
        key.proof({
          method: "POST",
          url: publicUrl(REDEEM_PATH, "connect"),
          // @effect-diagnostics-next-line globalDateInEffect:off -- a stale DPoP proof needs wall-clock seconds.
          iat: Math.floor(Date.now() / 1000) - 3600,
        }),
      ])
        expect((yield* redeem(handler, key, credential, { dpop })).status).toBe(401);
      expect((yield* redeem(handler, key, credential)).status).toBe(200);
    }),
  ),
);

it.live("accepts a redeemed token only as DPoP with a fresh, fitting proof", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      const other = makeTestDpopKey();
      const { managementToken: token } = yield* json<{ managementToken: string }>(
        yield* redeem(handler, key, yield* redeemCredential(auth)),
      );
      const reason = (response: Response) =>
        json<{ dpopFailureReason?: string }>(response).pipe(
          Effect.map((body) => ({ status: response.status, reason: body.dpopFailureReason })),
        );

      for (const via of ["connect", "tailnet"] as const)
        expect(
          (yield* ticket(handler, via, proven(key, token, "POST", TICKET_PATH, via))).status,
        ).toBe(200);

      expect((yield* ticket(handler, "connect", { authorization: `Bearer ${token}` })).status).toBe(
        401,
      );
      expect((yield* ticket(handler, "tailnet", { authorization: `Bearer ${token}` })).status).toBe(
        401,
      );
      expect(
        yield* reason(
          yield* ticket(handler, "connect", {
            authorization: `DPoP ${token}`,
            dpop: key.proof({
              method: "POST",
              url: publicUrl("/api/auth/clients", "connect"),
              accessToken: token,
            }),
          }),
        ),
      ).toEqual({ status: 401, reason: "request_mismatch" });
      expect(
        yield* reason(
          yield* ticket(handler, "connect", {
            authorization: `DPoP ${token}`,
            dpop: key.proof({
              method: "GET",
              url: publicUrl(TICKET_PATH, "connect"),
              accessToken: token,
            }),
          }),
        ),
      ).toEqual({ status: 401, reason: "request_mismatch" });
      // A proof made for one address fails on the other.
      expect(
        yield* reason(
          yield* ticket(handler, "connect", proven(key, token, "POST", TICKET_PATH, "tailnet")),
        ),
      ).toEqual({ status: 401, reason: "request_mismatch" });

      const once = proven(key, token, "POST", TICKET_PATH, "connect");
      expect((yield* ticket(handler, "connect", once)).status).toBe(200);
      expect(yield* reason(yield* ticket(handler, "connect", once))).toEqual({
        status: 401,
        reason: "replay",
      });

      expect(
        (yield* ticket(handler, "connect", {
          authorization: `DPoP ${token}`,
          dpop: key.proof({
            method: "POST",
            url: publicUrl(TICKET_PATH, "connect"),
            accessToken: token,
            withoutAth: true,
          }),
        })).status,
      ).toBe(401);
      expect(
        yield* reason(
          yield* ticket(handler, "connect", {
            authorization: `DPoP ${token}`,
            dpop: key.proof({
              method: "POST",
              url: publicUrl(TICKET_PATH, "connect"),
              accessToken: `${token}x`,
            }),
          }),
        ),
      ).toEqual({ status: 401, reason: "token_mismatch" });
      expect(
        yield* reason(
          yield* ticket(handler, "connect", proven(other, token, "POST", TICKET_PATH, "connect")),
        ),
      ).toEqual({ status: 401, reason: "key_mismatch" });
    }),
  ),
);

it.live(
  "refuses an unbound management token over Connect and keeps it working on the tailnet",
  () =>
    withRoutes((handler, auth) =>
      Effect.gen(function* () {
        const legacy = yield* auth.issueSession({
          subject: "fleet-invitation",
          principal: { kind: "coordinator", environmentId: COORDINATOR },
          scopes: [...FLEET_INVITE_SCOPES],
          label: FLEET_INVITE_SESSION_LABEL,
        });
        const bearer = { authorization: `Bearer ${legacy.token}` };
        expect((yield* ticket(handler, "tailnet", bearer)).status).toBe(200);
        expect((yield* ticket(handler, "local", bearer)).status).toBe(200);
        expect((yield* ticket(handler, "connect", bearer)).status).toBe(401);
        // Cloudflare's stamp alone marks the tunnel, whatever Host says.
        expect(
          (yield* handler(
            at(TICKET_PATH, "tailnet", {
              method: "POST",
              headers: { ...bearer, "cf-connecting-ip": "203.0.113.20" },
            }),
          )).status,
        ).toBe(401);
      }),
    ),
);

it.live("never lets a Studio Connect session or a management token change access", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      // A Studio Connect (Clerk) session: the mint binds it to the client's key.
      const pairing = yield* auth.createPairingLink({
        subject: "cloud-connect",
        scopes: AuthStandardClientScopes,
        proofKeyThumbprint: key.thumbprint,
      });
      const exchanged = yield* handler(
        at("/oauth/token", "connect", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: key.proof({ method: "POST", url: publicUrl("/oauth/token", "connect") }),
          },
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: pairing.credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }).toString(),
        }),
      );
      expect(exchanged.status).toBe(200);
      const cloud = yield* json<{ access_token: string; token_type: string }>(exchanged);
      expect(cloud.token_type).toBe("DPoP");
      expect(
        (yield* ticket(
          handler,
          "connect",
          proven(key, cloud.access_token, "POST", TICKET_PATH, "connect"),
        )).status,
      ).toBe(200);

      const mutations: ReadonlyArray<readonly [string, unknown]> = [
        ["/api/studio/fleet/workers/allow", { id: "m1", access: "auto" }],
        ["/api/studio/fleet/workers/stop", { id: "m1" }],
        ["/api/studio/fleet/machines", { invitation: "swc-machine-x" }],
        ["/api/studio/fleet/invite", { coordinatorEnvironmentId: "env-attacker" }],
        ["/api/studio/fleet/machines/remove", { id: "m1" }],
        ["/api/studio/fleet/work-grants/update", { coordinatorEnvironmentId: "env-attacker" }],
        ["/api/auth/pairing-token", { coordinatorEnvironmentId: "env-attacker" }],
        [
          "/api/auth/worker-grants/renew",
          {
            accessToken: "a.b",
            coordinatorEnvironmentId: "env-attacker",
            environmentId: WORKER,
          },
        ],
      ];
      const post = (token: string, path: string, body: unknown) =>
        handler(
          at(path, "connect", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...proven(key, token, "POST", path, "connect"),
            },
            body: JSON.stringify(body),
          }),
        );
      for (const [path, body] of mutations)
        expect([path, (yield* post(cloud.access_token, path, body)).status]).toEqual([path, 403]);

      // The Connect pairing credential is not a fleet line either.
      const before = (yield* auth.listSessions()).length;
      const connectLine = yield* auth.createPairingLink({
        subject: "cloud-connect",
        scopes: AuthStandardClientScopes,
        proofKeyThumbprint: key.thumbprint,
      });
      expect((yield* redeem(handler, key, connectLine.credential)).status).toBe(401);
      expect((yield* auth.listSessions()).length).toBe(before);

      // A management token, even bound, is another machine: it never grants work here.
      const { managementToken } = yield* json<{ managementToken: string }>(
        yield* redeem(handler, key, yield* redeemCredential(auth)),
      );
      for (const [path, body] of mutations.slice(0, 1).concat([mutations[3]!]))
        expect([path, (yield* post(managementToken, path, body)).status]).toEqual([path, 403]);
    }),
  ),
);

it.live("spends a redeem credential presented anywhere else without a session", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const key = makeTestDpopKey();
      const before = (yield* auth.listSessions()).length;
      const viaToken = yield* redeemCredential(auth);
      const exchanged = yield* handler(
        at("/oauth/token", "local", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: viaToken,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }).toString(),
        }),
      );
      expect(exchanged.status).toBe(401);
      expect((yield* redeem(handler, key, viaToken)).status).toBe(401);

      const viaBrowser = yield* redeemCredential(auth);
      const browser = yield* handler(
        at("/api/auth/browser-session", "local", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:8319" },
          body: JSON.stringify({ credential: viaBrowser }),
        }),
      );
      expect(browser.status).toBe(401);
      expect(browser.headers.getSetCookie()).toEqual([]);
      expect((yield* redeem(handler, key, viaBrowser)).status).toBe(401);
      expect((yield* auth.listSessions()).length).toBe(before);
    }),
  ),
);

it.live("blocks a client after 30 failed credentials, and only that client", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const legacy = yield* auth.issueSession({
        subject: "local-cli-owner",
        label: "Owner",
      });
      const good = { authorization: `Bearer ${legacy.token}` };
      expect((yield* ticket(handler, "connect", good, "198.51.100.1")).status).toBe(200);
      for (let attempt = 0; attempt < 30; attempt += 1)
        expect(
          (yield* ticket(
            handler,
            "connect",
            { authorization: "Bearer guessed.token" },
            "198.51.100.1",
          )).status,
        ).toBe(401);
      const blocked = yield* ticket(
        handler,
        "connect",
        { authorization: "Bearer guessed.token" },
        "198.51.100.1",
      );
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(yield* json<unknown>(blocked)).toMatchObject({ code: "rate_limited" });
      // A genuine credential from the blocked address still works: a neighbour
      // behind the same egress cannot lock the owner's machines out.
      expect((yield* ticket(handler, "connect", good, "198.51.100.1")).status).toBe(200);
      // The redeem endpoint shares the budget.
      expect(
        (yield* handler(
          at(REDEEM_PATH, "connect", {
            method: "POST",
            ip: "198.51.100.1",
            headers: { "content-type": "application/json", dpop: "x" },
            body: JSON.stringify({ credential: "x", coordinatorEnvironmentId: COORDINATOR }),
          }),
        )).status,
      ).toBe(429);
      expect((yield* ticket(handler, "connect", good, "198.51.100.2")).status).toBe(200);

      // A genuine token that was revoked is stale, not a guess: retrying it never blocks.
      const stale = yield* auth.issueSession({ subject: "local-cli-owner", label: "Old" });
      yield* auth.revokeSession(stale.sessionId);
      for (let attempt = 0; attempt < 31; attempt += 1)
        expect(
          (yield* ticket(
            handler,
            "connect",
            { authorization: `Bearer ${stale.token}` },
            "198.51.100.3",
          )).status,
        ).toBe(401);
      expect((yield* ticket(handler, "connect", good, "198.51.100.3")).status).toBe(200);
    }),
  ),
);

/**
 * Both sides together: this worker invites over Connect only, a coordinator
 * adds the line and then pairs a browser, everything through the tunnel
 * address (Host rewritten as cloudflared does). Not one request carries a
 * plain bearer.
 */
it.live("invite over Connect, add and pair through the tunnel, never a bearer on the wire", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; authorization: string | null }> = [];
      const tunnel = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === TAILNET) throw new TypeError("tailnet down");
        if (url.origin !== CONNECT) throw new TypeError("unknown host");
        const headers = Object.fromEntries(new Headers(init?.headers));
        calls.push({ url: url.href, authorization: headers.authorization ?? null });
        if (url.pathname === "/.well-known/studio/environment")
          return Response.json({
            environmentId: WORKER,
            label: "Worker",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.1.0-test",
            orchestrationProtocolVersion: 2,
            capabilities: { repositoryIdentity: true },
          });
        return Effect.runPromise(
          handler(
            at(`${url.pathname}${url.search}`, "connect", {
              method: init?.method ?? "GET",
              headers,
              ...(init?.body === undefined ? {} : { body: init.body }),
            }),
          ),
        );
      }) as typeof fetch;

      const { invitation } = yield* issueFleetInvitation({
        environmentId: WORKER,
        coordinatorEnvironmentId: COORDINATOR,
        ownLabel: "Worker",
        state: { host: "127.0.0.1", port: 8319 },
        servePort: 443,
        via: "connect",
        readConnectOrigin: Effect.succeed(CONNECT),
        fetch: tunnel,
      }).pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
        Effect.provide(
          Layer.mergeAll(noTailscale, FetchHttpClient.layer.pipe(Layer.provide(fetchLayer))),
        ),
      );
      expect(invitation.sessionId).toBeUndefined();

      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-coordinator-")),
      );
      try {
        const link = makeFleetLink({ fetch: tunnel, baseDir });
        const added = yield* Effect.promise(() =>
          addFleetMachine({
            baseDir,
            code: invitation.code,
            link,
            localEnvironmentId: COORDINATOR,
          }),
        );
        expect(added).toMatchObject({ url: CONNECT, change: "added" });
        const config = yield* Effect.promise(() => readFleetConfig(baseDir));
        // A browser pairing would turn the code into a bearer or a cookie on
        // the internet-facing address: refused before any code is minted.
        const browser = yield* Effect.promise(() =>
          connectFleet(
            config,
            added.id,
            new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
            link,
          ).then(
            () => null,
            (error: unknown) => error,
          ),
        );
        expect(browser).toMatchObject({ kind: "connect-browser-unsupported" });
        expect(calls.some((call) => call.url.endsWith("/api/auth/pairing-token"))).toBe(false);

        // Pairing codes the bound management token mints over Connect carry
        // the coordinator principal; whoever sees one at the TLS terminator
        // cannot turn it into a bearer or a cookie there.
        const machine = config!.machines.find((entry) => entry.id === added.id)!;
        const mintCode = () =>
          Effect.promise(async () => {
            const { response, address } = await fleetRequest(
              link,
              machine,
              "/api/auth/pairing-token",
              {
                method: "POST",
                token: machine.managementToken!,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ label: "probe", scopes: [AuthOrchestrationReadScope] }),
              },
            );
            expect(address.origin).toBe(CONNECT);
            expect(response.status).toBe(200);
            return ((await response.json()) as { credential: string }).credential;
          });
        const exchange = (code: string, via: Via) =>
          handler(
            at("/oauth/token", via, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: code,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
              }).toString(),
            }),
          );
        expect((yield* exchange(yield* mintCode(), "connect")).status).toBe(401);
        const cookie = yield* handler(
          at("/api/auth/browser-session", "connect", {
            method: "POST",
            headers: { "content-type": "application/json", origin: CONNECT },
            body: JSON.stringify({ credential: yield* mintCode() }),
          }),
        );
        expect(cookie.status).toBe(401);
        expect(cookie.headers.getSetCookie()).toEqual([]);

        // Exchanged on the tailnet it is a bearer that works only there.
        const onTailnet = yield* exchange(yield* mintCode(), "tailnet");
        expect(onTailnet.status).toBe(200);
        const bearer = (yield* json<{ access_token: string }>(onTailnet)).access_token;
        const plain = { authorization: `Bearer ${bearer}` };
        expect((yield* ticket(handler, "tailnet", plain)).status).toBe(200);
        expect((yield* ticket(handler, "connect", plain)).status).toBe(401);
        for (const call of calls) expect(call.authorization ?? "").not.toMatch(/^Bearer/i);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
      }
    }),
  ),
);
