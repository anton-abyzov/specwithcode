import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a half-open request, which the Effect client will not send.
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const providerToken = "bodyLimitProbeTokenWithoutDots";
const providerScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-body-limit-test"),
  requestNamespace: "provider-session-body-limit",
  thread: {
    threadId: ThreadId.make("thread-body-limit-test"),
    providerSessionId: "provider-session-body-limit",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const ProbeToolkit = Toolkit.make(
  Tool.make("body_probe", {
    description: "Reports the size of the data it was given.",
    parameters: Schema.Struct({ data: Schema.String }),
    success: Schema.Struct({ length: Schema.Number }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const CHUNK_BYTES = 64 * 1024;
const jsonHeaders = {
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${providerToken}`,
};

/** Serves `/mcp` with the probe tool and returns what the tool received. */
const serveProbe = Effect.gen(function* () {
  const received: Array<string> = [];
  const serverLayer = McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    McpToolAccess.toLayer(ProbeToolkit, {
      body_probe: McpToolAccess.reads(({ data }) =>
        Effect.sync(() => {
          received.push(data);
          return { length: data.length };
        }),
      ),
    }),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerMcpTransport),
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) => Effect.succeed(token === providerToken ? providerScope : undefined),
      }),
    ),
  );
  yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  return received;
});

const initializeSession = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const initialize = yield* httpClient.post("/mcp", {
    headers: jsonHeaders,
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
      "application/json",
    ),
  });
  expect(initialize.status).toBe(200);
  return {
    ...jsonHeaders,
    "mcp-session-id": initialize.headers["mcp-session-id"]!,
    "mcp-protocol-version": "2025-06-18",
  };
});

const toolCall = (data: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "body_probe", arguments: { data } },
  });

/** A JSON body of `totalBytes`, produced lazily in 64 KiB chunks. */
const streamedBody = (totalBytes: number, onChunk: () => void = () => {}) => {
  const filler = new Uint8Array(CHUNK_BYTES).fill(0x61);
  const chunkCount = Math.ceil(totalBytes / CHUNK_BYTES);
  // One chunk per pull, so the count shows how far the client really got.
  return Stream.unfold(1, (index) =>
    Effect.sync(() => {
      if (index > chunkCount) return undefined;
      onChunk();
      const chunk =
        index === 1 ? new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"x":"') : filler;
      return [chunk, index + 1] as const;
    }),
  );
};

it.effect("refuses a declared Content-Length over the limit with 413 before the tool runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* serveProbe;
      const headers = yield* initializeSession;
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.uint8Array(
          new Uint8Array(McpHttpServer.MCP_MAX_REQUEST_BYTES + 1),
          "application/json",
        ),
      });
      expect(response.status).toBe(413);
      expect(yield* response.json).toEqual({
        error: "request_too_large",
        message: `An MCP request may carry at most ${String(McpHttpServer.MCP_MAX_REQUEST_BYTES)} bytes.`,
      });
      expect(received).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a streamed body with no Content-Length once it passes the limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* serveProbe;
      const headers = yield* initializeSession;
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient.post("/mcp", {
        headers,
        // No length: the client sends it chunked, and the stream does end.
        body: HttpBody.stream(
          streamedBody(McpHttpServer.MCP_MAX_REQUEST_BYTES + CHUNK_BYTES),
          "application/json",
        ),
      });
      expect(response.status).toBe(413);
      expect((yield* response.json) as unknown).toMatchObject({ error: "request_too_large" });
      expect(received).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("answers a wrong credential with 401 before reading the body", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* serveProbe;
      const address = (yield* HttpServer.HttpServer).address;
      if (!NetAddress.isInetAddress(address)) return yield* Effect.die("expected an IP address");
      const started = Date.now();
      const status = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            const req = NodeHttp.request(
              {
                host: "127.0.0.1",
                port: address.port,
                method: "POST",
                path: "/mcp",
                headers: {
                  authorization: "Bearer notTheRightTokenWithoutDots",
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
              },
            );
            req.on("error", reject);
            // Headers go out now. The body stays open, so a read-first server cannot answer.
            req.flushHeaders();
            req.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}');
            const timer = setTimeout(() => {
              req.destroy();
              reject(new Error("no response while the body was still open"));
            }, 1_000);
            req.on("response", () => clearTimeout(timer));
          }),
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(status).toBe(401);
      expect(received).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("passes a 2 MiB file chunk as base64 to the tool intact", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* serveProbe;
      const headers = yield* initializeSession;
      const httpClient = yield* HttpClient.HttpClient;
      const chunk = NodeCrypto.randomBytes(2 * 1024 * 1024).toString("base64");
      expect(chunk.length).toBeGreaterThan(2_700_000);
      const response = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(toolCall(chunk), "application/json"),
      });
      expect(response.status).toBe(200);
      expect(yield* response.text).toContain(`\\"length\\":${String(chunk.length)}`);
      expect(received).toHaveLength(1);
      expect(received[0] === chunk).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps small calls, streamed calls and session close working as before", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* serveProbe;
      const headers = yield* initializeSession;
      const httpClient = yield* HttpClient.HttpClient;
      const small = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(toolCall("hello"), "application/json"),
      });
      expect(small.status).toBe(200);
      expect(yield* small.text).toContain('\\"length\\":5');
      // A chunked body under the limit reaches the tool through the same read.
      const encoded = new TextEncoder().encode(toolCall("streamed"));
      const streamed = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.stream(
          Stream.make(encoded.subarray(0, 10), encoded.subarray(10)),
          "application/json",
        ),
      });
      expect(streamed.status).toBe(200);
      expect(yield* streamed.text).toContain('\\"length\\":8');
      expect(received).toEqual(["hello", "streamed"]);
      const closed = yield* httpClient.del("/mcp", { headers });
      expect(closed.status).toBe(204);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
