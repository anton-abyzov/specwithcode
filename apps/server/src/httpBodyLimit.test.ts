// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - API routes on a real socket.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AuthHttp from "./auth/http.ts";
import { API_MAX_BODY_BYTES, layerApiBodyLimit } from "./httpBodyLimit.ts";

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-body-limit-test-" });

/** A raw route with no limit of its own, served by the same router. */
const layerRawRoute = HttpRouter.add(
  "POST",
  "/raw-echo-length",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.arrayBuffer;
    return HttpServerResponse.text(String(body.byteLength));
  }).pipe(Effect.orDie),
);

const layerServer = HttpRouter.serve(
  Layer.mergeAll(
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(layerApiBodyLimit),
    ),
    layerRawRoute,
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(
    EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
    ),
  ),
  Layer.provide(layerConfig),
  Layer.provide(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

// Kept alive, as browsers do: on a closing connection the reset that follows an
// early answer can reach the client before the answer does.
const keepAlive = new NodeHttp.Agent({ keepAlive: true });

/** One POST on a real socket; `declared` false sends the body chunked, with no length. */
const send = (origin: string, path: string, contentType: string, body: Buffer, declared: boolean) =>
  new Promise<{ status: number; text: string }>((resolve) => {
    const request = NodeHttp.request(
      `${origin}${path}`,
      {
        method: "POST",
        agent: keepAlive,
        headers: {
          "content-type": contentType,
          ...(declared
            ? { "content-length": String(body.byteLength) }
            : { "transfer-encoding": "chunked" }),
        },
      },
      (response) => {
        // The answer can come while the client is still writing, and the
        // socket then closes under it: whatever arrived is the answer.
        const chunks: Array<Buffer> = [];
        const done = () =>
          resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() });
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", done);
        response.once("close", done);
      },
    );
    // A refusal can close the socket under a client that is still writing.
    request.on("error", () => void setTimeout(() => resolve({ status: 0, text: "" }), 500));
    if (declared) request.end(body);
    else {
      for (let at = 0; at < body.byteLength; at += 64 * 1024) {
        request.write(body.subarray(at, at + 64 * 1024));
      }
      request.end();
    }
  });

const routes = [
  ["/oauth/mcp/token", "application/x-www-form-urlencoded"],
  ["/oauth/token", "application/x-www-form-urlencoded"],
  ["/oauth/mcp/register", "application/json"],
  ["/api/auth/browser-session", "application/json"],
] as const;

it.effect("API routes refuse a 2 MiB body, declared or chunked", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layerServer);
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const big = Buffer.alloc(2 * API_MAX_BODY_BYTES, 0x61);
    for (const [path, type] of routes) {
      const declared = yield* Effect.promise(() => send(origin, path, type, big, true));
      expect(declared.status, `${path} declared`).toBe(413);
      const chunked = yield* Effect.promise(() => send(origin, path, type, big, false));
      expect([413, 0], `${path} chunked`).toContain(chunked.status);
    }
  }).pipe(Effect.scoped),
);

it.effect("small API bodies still reach their handler, and raw routes keep their own limits", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layerServer);
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const grant = Buffer.from(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-code",
        redirect_uri: "http://localhost/callback",
        client_id: "not-a-client",
        code_verifier: "a".repeat(43),
      }).toString(),
    );
    // The handler reads it and refuses the grant, not the size.
    const token = yield* Effect.promise(() =>
      send(origin, "/oauth/mcp/token", "application/x-www-form-urlencoded", grant, true),
    );
    expect(token.status).toBe(400);
    expect(token.text).toMatch(/"error":"invalid_(grant|client)"/);
    const big = Buffer.alloc(2 * API_MAX_BODY_BYTES, 0x61);
    for (const declared of [true, false]) {
      const raw = yield* Effect.promise(() =>
        send(origin, "/raw-echo-length", "application/octet-stream", big, declared),
      );
      expect(raw).toEqual({ status: 200, text: String(big.byteLength) });
    }
  }).pipe(Effect.scoped),
);
