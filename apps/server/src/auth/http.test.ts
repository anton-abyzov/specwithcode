import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createRequire } from "node:module";
import {
  AuthSessionId,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
} from "@specweave-studio/contracts";
import { RelayClientTracer } from "@specweave-studio/shared/relayTracing";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class DiskFullTestError extends Schema.TaggedError<DiskFullTestError>()("DiskFullTestError", {
  message: Schema.String,
}) {}
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (
  path: string,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
  origin = "http://127.0.0.1",
) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const cookieTransportCases: ReadonlyArray<{
  origin: string;
  secure: boolean;
  headers: Readonly<Record<string, string>>;
}> = [
  { origin: "http://127.0.0.1", secure: false, headers: {} },
  { origin: "https://studio.example.test", secure: true, headers: {} },
  {
    origin: "http://127.0.0.1",
    secure: true,
    headers: { origin: "https://studio.example.test", "x-forwarded-proto": "http" },
  },
];
it.effect.each(cookieTransportCases)(
  "sets issuance and expiration cookie attributes on $origin (Secure=$secure)",
  ({ origin, secure, headers }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by these routes."),
        remove: () => Effect.void,
      });
      const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(
          () =>
            [
              HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
              HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            ] as const,
        ),
        ([environmentA, environmentB]) =>
          Effect.tryPromise(async () => {
            const devResponse = await environmentA.handler(
              postJson("/api/auth/browser-session", { credential: DEV_TOKEN }, headers, origin),
              requestContext,
            );
            expect(devResponse.status).toBe(200);
            const retiredScopeResponse = await environmentA.handler(
              new Request("http://127.0.0.1/oauth/token", {
                method: "POST",
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: DEV_TOKEN,
                  subject_token_type: AuthEnvironmentBootstrapTokenType,
                  requested_token_type: AuthAccessTokenType,
                  scope: "review:write",
                }),
              }),
              requestContext,
            );
            expect(retiredScopeResponse.status).toBe(400);
            expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

            const devCookies = devResponse.headers.getSetCookie();
            const devCookie = devCookies.find((cookie) => cookie.startsWith("studio_dev_session_"));
            expect(devCookie).toContain("HttpOnly");
            expect(devCookie).toContain(`=${DEV_TOKEN};`);
            expect(/; Secure(?:;|$)/.test(devCookie ?? "")).toBe(secure);
            expect(devCookies).toContainEqual(
              expect.stringMatching(/^studio_session_[^=]*=;.*Max-Age=0/),
            );
            for (const cookie of devCookies) expect(/; Secure(?:;|$)/.test(cookie)).toBe(secure);
            const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
            const environmentBSession = await environmentB.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: devCookieHeader },
              }),
              requestContext,
            );
            expect(environmentBSession.status).toBe(200);
            expect(await environmentBSession.json()).toMatchObject({ authenticated: true });
            expect(environmentBSession.headers.getSetCookie()).toEqual([]);

            const pairingResponse = await environmentA.handler(
              postJson(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read"] },
                // A browser sends its page's Origin on every POST.
                { cookie: devCookieHeader, origin },
                origin,
              ),
              requestContext,
            );
            expect(pairingResponse.status).toBe(200);
            const pairing = (await pairingResponse.json()) as { credential: string };
            const restrictedResponse = await environmentA.handler(
              postJson(
                "/api/auth/browser-session",
                { credential: pairing.credential },
                headers,
                origin,
              ),
              requestContext,
            );
            expect(restrictedResponse.status).toBe(200);
            const restrictedCookies = restrictedResponse.headers.getSetCookie();
            expect(restrictedCookies).toHaveLength(1);
            expect(restrictedCookies[0]).toMatch(/^studio_session_/);
            expect(restrictedCookies[0]).not.toContain("studio_dev_session_");
            expect(/; Secure(?:;|$)/.test(restrictedCookies[0] ?? "")).toBe(secure);
            const forged = await environmentA.handler(
              postJson(
                "/api/auth/browser-session",
                { credential: "invalid-owned-test-grant" },
                {
                  origin: "https://example.invalid",
                  "x-forwarded-proto": "https",
                  forwarded: "proto=https",
                },
                origin,
              ),
              requestContext,
            );
            expect(forged.status).toBe(401);
            expect(forged.headers.getSetCookie()).toEqual([]);
          }),
        ([environmentA, environmentB]) =>
          Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

// M4, 1.0.112: a pairing token minted while the service was held added an
// auth_pairing_links row, which the update helper compares exactly, and failed the install.
it.effect("refuses to mint a pairing token while the service is held for an update", () =>
  Effect.gen(function* () {
    // The hold's expiry is read on the request's clock, which is the real one.
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    const hold = yield* ServiceUpdateHold.makeWithOptions({
      agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
    });
    const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(Layer.succeed(ServiceUpdateHold.ServiceUpdateHold, hold)),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provideMerge(layerEnvironmentAuth),
      Layer.provide(layerConfig),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (environment) =>
        Effect.gen(function* () {
          const call = (request: Request) =>
            Effect.promise(() => environment.handler(request, requestContext));
          const signIn = yield* call(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
          );
          expect(signIn.status).toBe(200);
          const cookie =
            signIn.headers
              .getSetCookie()
              .find((value) => value.startsWith("studio_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          const mint = () =>
            call(
              postJson(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read"], label: "memory-cleanup" },
                { cookie, origin: "http://127.0.0.1" },
              ),
            );
          const links = () =>
            call(
              new Request("http://127.0.0.1/api/auth/pairing-links", { headers: { cookie } }),
            ).pipe(
              Effect.flatMap((response) =>
                Effect.promise(() => response.json() as Promise<ReadonlyArray<unknown>>),
              ),
              Effect.map((rows) => rows.length),
            );
          const before = yield* links();

          yield* hold.acquire({ reason: "test" });
          const refused = yield* mint();
          expect(refused.status).toBe(503);
          expect(yield* Effect.promise(() => refused.json())).toMatchObject({
            code: "update_in_progress",
            retryAfterSeconds: 300,
            message: ServiceUpdateHold.SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
          });
          // Nothing the update helper guards was written.
          expect(yield* links()).toBe(before);

          yield* hold.release("test");
          const minted = yield* mint();
          expect(minted.status).toBe(200);
          expect(yield* links()).toBe(before + 1);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "refreshes verified browser-cookie attributes without auth-row churn and expires a legacy cookie on HTTPS",
  () =>
    Effect.gen(function* () {
      // The direct grant and the real HTTP handler must share a current epoch.
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.nowUnsafe()));
      const crypto = yield* Crypto.Crypto;
      const config = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const current = yield* ServerConfig.ServerConfig;
          return {
            ...current,
            mode: "web" as const,
            host: "0.0.0.0",
            devUrl: undefined,
            devAuthToken: undefined,
          };
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-auth-legacy-cookie-test-" }),
        ),
      );
      const authContext = yield* Layer.build(
        EnvironmentAuth.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provide(config),
        ),
      );
      const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
      const sessions = Context.get(authContext, SessionStore.SessionStore);
      expect(sessions.legacyCookieName).toBe("studio_session");
      const pairing = yield* auth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
        Layer.provide(Layer.succeed(SessionStore.SessionStore, sessions)),
        Layer.provide(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (handler) =>
          Effect.tryPromise(async () => {
            const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
              Context.add(
                ServerSecretStore.ServerSecretStore,
                Context.get(authContext, ServerSecretStore.ServerSecretStore),
              ),
            );
            const issued = await handler.handler(
              postJson(
                "/api/auth/browser-session",
                { credential: pairing.credential },
                undefined,
                "https://studio.example.test",
              ),
              requestContext,
            );
            expect(issued.status).toBe(200);
            const cookie = issued.headers.getSetCookie()[0];
            expect(cookie).toContain("; Secure");
            const value = cookie?.split(";", 1)[0]?.split("=").slice(1).join("=");
            expect(value).toBeTruthy();
            const issuedState = (await issued.json()) as { expiresAt: string };
            const rowsBefore = await Effect.runPromise(auth.listSessions());
            const refreshed = await handler.handler(
              new Request("https://studio.example.test/api/auth/session", {
                headers: { cookie: sessions.cookieName + "=" + value },
              }),
              requestContext,
            );
            expect(refreshed.status).toBe(200);
            expect(await refreshed.json()).toMatchObject({
              authenticated: true,
              expiresAt: issuedState.expiresAt,
            });
            const refreshedCookies = refreshed.headers.getSetCookie();
            expect(refreshedCookies).toHaveLength(1);
            expect(refreshedCookies[0]?.split(";", 1)[0]).toBe(sessions.cookieName + "=" + value);
            expect(refreshedCookies[0]).toContain("; Secure");
            expect(refreshedCookies[0]?.match(/Expires=([^;]+)/)?.[1]).toBe(
              cookie?.match(/Expires=([^;]+)/)?.[1],
            );
            expect(await Effect.runPromise(auth.listSessions())).toEqual(rowsBefore);
            const bearer = await Effect.runPromise(
              auth.issueSession({ scopes: ["orchestration:read"] }),
            );
            const bearerResponse = await handler.handler(
              new Request("https://studio.example.test/api/auth/session", {
                headers: { authorization: "Bearer " + bearer.token },
              }),
              requestContext,
            );
            expect(await bearerResponse.json()).toMatchObject({
              authenticated: true,
              sessionMethod: "bearer-access-token",
            });
            expect(bearerResponse.headers.getSetCookie()).toEqual([]);
            const dpopResponse = await handler.handler(
              new Request("https://studio.example.test/api/auth/session", {
                headers: { authorization: "DPoP " + bearer.token },
              }),
              requestContext,
            );
            expect(await dpopResponse.json()).toMatchObject({ authenticated: false });
            expect(dpopResponse.headers.getSetCookie()).toEqual([]);
            const upgraded = await handler.handler(
              new Request("https://studio.example.test/api/auth/session", {
                headers: { cookie: "studio_session=" + value, "x-forwarded-proto": "http" },
              }),
              requestContext,
            );
            expect(upgraded.status).toBe(200);
            expect(await upgraded.json()).toMatchObject({ authenticated: true });
            const upgradedCookies = upgraded.headers.getSetCookie();
            expect(upgradedCookies).toHaveLength(2);
            expect(upgradedCookies).toContainEqual(
              expect.stringMatching(/^studio_session=;.*Max-Age=0/),
            );
            expect(upgradedCookies).toContainEqual(
              expect.stringMatching(new RegExp("^" + sessions.cookieName + "=[^;]+;")),
            );
            for (const header of upgradedCookies) {
              expect(header).toContain("; Secure");
              expect(header).toContain("; HttpOnly");
              expect(header).toContain("SameSite=Lax");
              expect(header).toContain("Path=/");
            }
            // Optional isolated browser tooling exercises the real route's headers
            // through Chromium's cookie jar. This fixture is not live TLS proof.
            const browserModule = process.env.STUDIO_TEST_PLAYWRIGHT;
            if (browserModule) {
              expect(process.env.PWDEBUG).toBe("0");
              expect(process.env.PLAYWRIGHT_HTML_OPEN).toBe("never");
              const { chromium } = createRequire(import.meta.url)(browserModule);
              const browser = await chromium.launch({ headless: true });
              try {
                const context = await browser.newContext();
                await context.addCookies([
                  {
                    name: "studio_session",
                    value,
                    domain: "studio.example.test",
                    path: "/",
                    httpOnly: true,
                    secure: false,
                    sameSite: "Lax",
                  },
                ]);
                await context.route(
                  "https://studio.example.test/api/auth/session",
                  (route: {
                    fulfill: (response: {
                      status: number;
                      headers: Record<string, string>;
                      body: string;
                    }) => Promise<void>;
                  }) =>
                    route.fulfill({
                      status: 200,
                      headers: {
                        "content-type": "application/json",
                        "set-cookie": upgradedCookies.join("\n"),
                      },
                      body: '{"authenticated":true}',
                    }),
                );
                const page = await context.newPage();
                await page.goto("https://studio.example.test/api/auth/session");
                const cookies: ReadonlyArray<{ name: string; secure: boolean }> =
                  await context.cookies("https://studio.example.test");
                expect(cookies.some((cookie) => cookie.name === "studio_session")).toBe(false);
                expect(
                  cookies.some((cookie) => cookie.name === sessions.cookieName && cookie.secure),
                ).toBe(true);
                await Effect.runPromise(
                  Effect.logInfo(
                    JSON.stringify({
                      evidenceKind: "headless-browser-cookie-jar-fixture",
                      legacyCookieRemoved: true,
                      newCookieSecure: true,
                      headless: true,
                      liveTLSProof: false,
                    }),
                  ),
                );
              } finally {
                await browser.close();
              }
            }
          }),
        (handler) => Effect.promise(() => handler.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a loopback browser signed in after its state directory moves", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    const crypto = yield* Crypto.Crypto;
    const config = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const current = yield* ServerConfig.ServerConfig;
        return {
          ...current,
          mode: "web" as const,
          host: "127.0.0.1",
          devUrl: undefined,
          devAuthToken: undefined,
        };
      }),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-auth-moved-home-" })),
    );
    const authContext = yield* Layer.build(
      EnvironmentAuth.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(config),
      ),
    );
    const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    const sessions = Context.get(authContext, SessionStore.SessionStore);
    expect(sessions.legacyCookieName).toBeUndefined();
    const port = sessions.cookieName.split("_")[2];
    // The name this server gave its cookie before the state directory moved.
    const movedName = `studio_session_${port}_15add52e56b4`;
    expect(movedName).not.toBe(sessions.cookieName);
    const pairing = yield* auth.issuePairingCredential({ scopes: ["orchestration:read"] });
    const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provide(Layer.succeed(SessionStore.SessionStore, sessions)),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) =>
        Effect.tryPromise(async () => {
          const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
            Context.add(
              ServerSecretStore.ServerSecretStore,
              Context.get(authContext, ServerSecretStore.ServerSecretStore),
            ),
          );
          const issued = await handler.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(issued.status).toBe(200);
          const value = issued.headers
            .getSetCookie()[0]
            ?.split(";", 1)[0]
            ?.split("=")
            .slice(1)
            .join("=");
          expect(value).toBeTruthy();

          const moved = await handler.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: movedName + "=" + value },
            }),
            requestContext,
          );
          expect(await moved.json()).toMatchObject({ authenticated: true });
          const movedCookies = moved.headers.getSetCookie();
          expect(movedCookies).toHaveLength(2);
          expect(movedCookies).toContainEqual(
            expect.stringMatching(new RegExp("^" + movedName + "=;.*Max-Age=0")),
          );
          expect(movedCookies).toContainEqual(
            expect.stringMatching(new RegExp("^" + sessions.cookieName + "=" + value + ";")),
          );

          // A cookie with the same prefix from another server is not this one's.
          const [payload] = (value ?? "").split(".");
          const foreign = await handler.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: movedName + "=" + payload + ".c2lnbmVkLWVsc2V3aGVyZQ" },
            }),
            requestContext,
          );
          expect(await foreign.json()).toMatchObject({ authenticated: false });
          expect(foreign.headers.getSetCookie()).toEqual([]);

          // A cookie for another port is never read.
          const otherPort = await handler.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: `studio_session_${Number(port) + 1}_15add52e56b4=` + value },
            }),
            requestContext,
          );
          expect(await otherPort.json()).toMatchObject({ authenticated: false });
        }),
      () => Effect.void,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exports only verified Studio Connect requests", () =>
  Effect.gen(function* () {
    const productSpans: Array<string> = [];
    const localSpans: Array<string> = [];
    const collect = (into: Array<string>) =>
      Tracer.make({
        span: (options) => {
          into.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
    // "DPoP connect" is a Studio Connect session; any other DPoP token is rejected.
    const environmentAuth = {
      authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
        (request.headers.authorization === "DPoP forged"
          ? Effect.fail(
              new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "forged" }),
            )
          : Effect.succeed({
              sessionId: AuthSessionId.make("session-1"),
              subject:
                request.headers.authorization === "DPoP connect"
                  ? "cloud-connect"
                  : "cli-issued-session",
              method: "bearer-access-token" as const,
              scopes: ["orchestration:read" as const],
            })
        ).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest")),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
    const middleware = yield* Layer.build(AuthHttp.layerAuthenticatedAuth).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
      Effect.map(Context.get(EnvironmentAuthenticatedAuth)),
    );
    const handle = (authorization: string) =>
      (
        middleware as unknown as (
          effect: Effect.Effect<void>,
        ) => Effect.Effect<void, Error, HttpServerRequest.HttpServerRequest>
      )(Effect.void.pipe(Effect.withSpan("environment.handler"))).pipe(
        Effect.ignore,
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://environment.example.test/api/orchestration/shell", {
              headers: {
                authorization,
                traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              },
            }),
          ),
        ),
        Effect.provideService(RelayClientTracer, Option.some(collect(productSpans))),
        Effect.withTracer(collect(localSpans)),
      );

    yield* handle("DPoP connect");
    expect(productSpans).toEqual([
      "environment.relay.request",
      "EnvironmentAuth.authenticateHttpRequest",
      "environment.handler",
    ]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    productSpans.length = 0;
    localSpans.length = 0;
    yield* handle("DPoP forged");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    localSpans.length = 0;
    yield* handle("Bearer access-token");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest", "environment.handler"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "warns once without the full cause for failed requests and stays quiet for client timeouts",
  () =>
    Effect.gen(function* () {
      const warnings: Array<{ message: unknown }> = [];
      const logger = Logger.make(({ message, logLevel }) => {
        if (logLevel === "Warn") warnings.push({ message });
      });
      const run = (body: Effect.Effect<void, Error>) =>
        Effect.gen(function* () {
          yield* AuthHttp.annotateEnvironmentRequest("environment.descriptor");
          yield* body;
        }).pipe(
          Effect.scoped,
          Effect.exit,
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://127.0.0.1:8319/.well-known/studio/environment"),
            ),
          ),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );

      // The client timed out and the handler was interrupted: no warning.
      yield* run(Effect.interrupt);
      expect(warnings).toEqual([]);

      yield* run(
        Effect.fail(new DiskFullTestError({ message: `disk full\n${"x".repeat(1_000)}` })),
      );
      expect(warnings).toHaveLength(1);
      const [text, fields] = warnings[0]!.message as [string, Record<string, unknown>];
      expect(text).toBe("environment api request failed");
      expect(fields).toEqual({
        endpoint: "environment.descriptor",
        traceId: expect.any(String),
        errorTag: "DiskFullTestError",
        failureKind: "error",
      });
    }),
);

it.effect("lets a bearer credential revoke itself, never a browser cookie", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    const crypto = yield* Crypto.Crypto;
    const authContext = yield* Layer.build(
      EnvironmentAuth.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    );
    const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    const sessions = Context.get(authContext, SessionStore.SessionStore);
    const management = yield* auth.issueSession({
      scopes: ["orchestration:read", "access:write"],
      label: "Management token",
    });
    const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provide(Layer.succeed(SessionStore.SessionStore, sessions)),
      Layer.provide(layerConfig),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) =>
        Effect.tryPromise(async () => {
          const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
            Context.add(
              ServerSecretStore.ServerSecretStore,
              Context.get(authContext, ServerSecretStore.ServerSecretStore),
            ),
          );
          const bearer = { authorization: `Bearer ${management.token}` };
          const revoked = await handler.handler(
            postJson("/api/auth/session/revoke", {}, bearer),
            requestContext,
          );
          expect(revoked.status).toBe(200);
          expect(await revoked.json()).toEqual({ revoked: true });
          // The token no longer works anywhere, including to revoke itself again.
          const again = await handler.handler(
            postJson("/api/auth/session/revoke", {}, bearer),
            requestContext,
          );
          expect(again.status).toBe(401);
        }),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
