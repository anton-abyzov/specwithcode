/**
 * "Revoke other clients" against a request already under way: a client
 * authenticated just before the revoke must not leave a new pairing code or
 * MCP token behind it. The revoke runs right after the request is
 * authenticated, before its handler mints.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-revoke-in-flight-" });
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);

/** Runs once a request is authenticated, before its handler. */
let afterAuthenticate:
  | ((auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<void>)
  | undefined;

const layerRoutes = (capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void) => {
  const authLayer = Layer.effect(
    EnvironmentAuth.EnvironmentAuth,
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return EnvironmentAuth.EnvironmentAuth.of({
        ...auth,
        authenticateHttpRequest: (request) =>
          auth
            .authenticateHttpRequest(request)
            .pipe(
              Effect.tap(() =>
                afterAuthenticate === undefined ? Effect.void : afterAuthenticate(auth),
              ),
            ),
      });
    }),
  ).pipe(Layer.provideMerge(layerEnvironmentAuth));
  return Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
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

type Handler = (request: Request) => Effect.Effect<Response>;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const post = (path: string, token: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      host: "localhost:8319",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: encodeJson(body),
  });

const withRoutes = <A, E>(
  use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let routerAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const routes = layerRoutes((auth) => {
      routerAuth = auth;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          // The router builds its layer on first request.
          yield* handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { host: "localhost:8319" },
            }),
          );
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => (afterAuthenticate = undefined))),
    Effect.provide(NodeServices.layer),
  );

const mints = [
  { path: "/api/auth/pairing-token", body: { label: "Phone" } },
  { path: "/api/auth/mcp-tokens", body: { label: "Bot", access: "auto" } },
] as const;

for (const mint of mints) {
  it.live(
    `${mint.path}: a revoke-all after the request is authenticated leaves nothing behind`,
    () =>
      withRoutes((handler, auth) =>
        Effect.gen(function* () {
          const owner = yield* auth.issueSession();
          const other = yield* auth.issueSession({ label: "Laptop" });
          afterAuthenticate = (routeAuth) =>
            routeAuth.revokeOtherClientSessions(owner.sessionId).pipe(Effect.asVoid, Effect.orDie);
          const response = yield* handler(post(mint.path, other.token, mint.body));
          afterAuthenticate = undefined;
          expect(response.status).not.toBe(200);

          // Only the owner's session is left, and no code waits to be spent.
          expect((yield* auth.listSessions()).map((session) => session.sessionId)).toEqual([
            owner.sessionId,
          ]);
          expect(yield* auth.listPairingLinks()).toEqual([]);

          // With no revoke under way, the same request mints.
          const fresh = yield* handler(post(mint.path, owner.token, mint.body));
          expect(fresh.status).toBe(200);
        }),
      ),
  );
}
