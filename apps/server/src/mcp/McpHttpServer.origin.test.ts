// @effect-diagnostics nodeBuiltinImport:off - sends an absolute-form request target, which HttpClient cannot.
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const providerToken = "originProbeTokenWithoutDots";
const providerScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-origin-test"),
  requestNamespace: "provider-session-origin",
  thread: {
    threadId: ThreadId.make("thread-origin-test"),
    providerSessionId: "provider-session-origin",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const ProbeToolkit = Toolkit.make(
  Tool.make("origin_probe", {
    description: "Answers.",
    parameters: Schema.Struct({ note: Schema.optional(Schema.String) }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

/** Serves `/mcp` and one plain API route behind the server's browser CORS layer. */
const serve = Effect.gen(function* () {
  const mcp = McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    McpToolAccess.toLayer(ProbeToolkit, {
      origin_probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
    }),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerMcpTransport),
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) => Effect.succeed(token === providerToken ? providerScope : undefined),
      }),
    ),
    Layer.provide(McpToolAccessTestkit.recordingLiveThreadsLayer([])),
  );
  const api = HttpRouter.add("POST", "/api/probe", HttpServerResponse.text("ok"));
  const routes = Layer.mergeAll(mcp, api).pipe(
    Layer.provide(ServerHttp.layerBrowserApiCors),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-origin-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
});

const initialize = HttpBody.text(
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
  "application/json",
);

const call = (
  method: "POST" | "OPTIONS",
  path: string,
  options: { origin?: string | undefined; token?: string | undefined },
) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.make(method)(path, {
        headers: {
          accept: "application/json, text/event-stream",
          ...(options.origin === undefined
            ? {}
            : { origin: options.origin, "access-control-request-method": "POST" }),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        ...(method === "POST" ? { body: initialize } : {}),
      }),
    ),
  );

it.effect("refuses /mcp from any browser origin before credentials, with no CORS answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve;
      for (const origin of ["https://untrusted.invalid", "null", "http://127.0.0.1:8319"]) {
        for (const [method, token] of [
          ["POST", providerToken],
          ["POST", undefined],
          ["OPTIONS", undefined],
        ] as const) {
          // The router ignores a trailing slash and the query, so the check does too.
          for (const path of ["/mcp", "/mcp/", "/mcp?x=1", "/mcp//"]) {
            const response = yield* call(method, path, { origin, token });
            expect(response.status, `${method} ${path} ${origin} ${token ?? "no token"}`).toBe(403);
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
          }
        }
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("still serves an agent's bearer request, and other routes keep their CORS", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve;
      expect((yield* call("POST", "/mcp", { token: providerToken })).status).toBe(200);
      // Without a credential and without an Origin, it is the usual sign-in answer.
      expect((yield* call("POST", "/mcp", {})).status).toBe(401);
      const preflight = yield* call("OPTIONS", "/api/probe", { origin: "https://app.example" });
      expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("gives an absolute-form /mcp preflight no CORS answer either", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve;
      const server = yield* HttpServer.HttpServer;
      const address = { port: Number(new URL(HttpServer.formatAddress(server.address)).port) };
      for (const target of [
        `http://127.0.0.1:${address.port}/mcp`,
        `http://127.0.0.1:${address.port}/mcp/`,
      ]) {
        const response = yield* Effect.promise(
          () =>
            new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
              const request = NodeHttp.request({
                host: "127.0.0.1",
                port: address.port,
                method: "OPTIONS",
                path: target,
                headers: {
                  origin: "https://untrusted.invalid",
                  "access-control-request-method": "POST",
                },
              });
              request.on("response", (message) => {
                message.resume();
                resolve(message);
              });
              request.on("error", reject);
              request.end();
            }),
        );
        expect(response.statusCode, target).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
