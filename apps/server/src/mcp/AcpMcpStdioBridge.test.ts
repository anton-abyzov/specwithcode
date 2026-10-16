// The harness asserts raw JSON-RPC wire strings, mirroring the bridge's
// schema-free passthrough.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { AcpMcpBridgeError, callAcpMcpTool, runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const bridge = runAcpMcpStdioBridge({
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    fetchImplementation: async (_url, init) => {
      const request = new Request("http://127.0.0.1:1/mcp", init);
      requests.push({ headers: request.headers, body: String(init?.body ?? "") });
      return responder(request);
    },
  });
  return { input, written, requests, bridge };
}

describe("AcpMcpStdioBridge", () => {
  it.effect("preserves the original transport failure as the typed error cause", () =>
    Effect.gen(function* () {
      const source = new Error("fetch failed");
      const failure = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: () => Promise.reject(source),
      }).pipe(Effect.asVoid, Effect.flip);

      expect(failure).toBeInstanceOf(AcpMcpBridgeError);
      expect(failure.cause).toBe(source);
    }),
  );

  it.effect("calls one tool through a fresh authenticated MCP session", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
      const result = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const body: unknown = JSON.parse(String(init?.body ?? "{}"));
          requests.push({ body, headers });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { structuredContent: { providers: ["codex"] } },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      expect(result).toEqual({ structuredContent: { providers: ["codex"] } });
      expect(requests).toHaveLength(3);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests[2]?.body).toMatchObject({
        method: "tools/call",
        params: { name: "orchestrator_capabilities", arguments: {} },
      });
    }),
  );

  it.effect("forwards requests and replays the session id and protocol version", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness((request) => {
        const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
        void request;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
      expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }),
  );

  it.effect("acknowledges notifications silently and synthesizes errors for failed requests", () =>
    Effect.gen(function* () {
      let call = 0;
      const { input, written, bridge } = makeHarness(() => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 202 })
          : new Response("upstream broke", { status: 500 });
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({
        id: 3,
        error: { code: -32603 },
      });
    }),
  );

  it.effect("emits parse errors for malformed JSON-RPC input", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => new Response(null, { status: 202 }),
      );
      const fiber = yield* Effect.forkChild(bridge);

      input.end("{not-json}\n");
      yield* Fiber.join(fiber);

      expect(requests).toHaveLength(0);
      expect(JSON.parse(written[0]!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }),
  );

  it.effect("forwards SSE messages before the HTTP response closes", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      let firstWrite: (() => void) | undefined;
      const firstWritten = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              firstWrite?.();
            },
          },
          fetchImplementation: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  resolveResponseController(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      const responseController = yield* Effect.promise(() => responseControllerReady);
      responseController.enqueue(
        new TextEncoder().encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ),
      );
      yield* Effect.promise(() => firstWritten);
      expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

      responseController.enqueue(
        new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );
      responseController.close();
      input.end();
      yield* Fiber.join(fiber);
      expect(written).toHaveLength(2);
    }),
  );

  it.effect("forwards client responses while an SSE request is still open", () =>
    Effect.gen(function* () {
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let serverRequestWritten: (() => void) | undefined;
      const serverRequestReachedClient = new Promise<void>((resolve) => {
        serverRequestWritten = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly id?: unknown;
              readonly method?: unknown;
              readonly result?: unknown;
            };
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    responseController = controller;
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
            responseController?.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            responseController?.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => serverRequestReachedClient);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
    }),
  );

  it.effect("forwards cancellation while a tool SSE response is still open", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      const methods: Array<string> = [];
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: { write: (chunk) => written.push(chunk) },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly method?: string;
            };
            methods.push(body.method ?? "");
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: resolveResponseController,
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            const controller = await responseControllerReady;
            controller.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            controller.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => responseControllerReady);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
    }),
  );
  it.effect("retries once with refreshed credentials after a 401 and never loops", () =>
    Effect.gen(function* () {
      const seen: Array<string | null> = [];
      let current = { endpoint: "http://127.0.0.1:1/mcp", authorization: "Bearer fresh" };
      const run = (lines: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          const input = new NodeStream.PassThrough();
          const written: Array<string> = [];
          const fiber = yield* Effect.forkChild(
            runAcpMcpStdioBridge({
              endpoint: "http://127.0.0.1:1/mcp",
              authorization: "Bearer stale",
              readCredentials: async () => current,
              input,
              output: { write: (chunk: string) => void written.push(chunk) },
              fetchImplementation: async (_url, init) => {
                const authorization = new Headers(init?.headers).get("authorization");
                seen.push(authorization);
                if (authorization !== "Bearer fresh") return new Response(null, { status: 401 });
                const body = JSON.parse(String(init?.body)) as { readonly id?: unknown };
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
                  headers: { "content-type": "application/json" },
                });
              },
            }),
          );
          for (const line of lines) input.write(`${JSON.stringify(line)}\n`);
          input.end();
          yield* Fiber.join(fiber);
          return written.map((line) => JSON.parse(line) as Record<string, unknown>);
        });

      const recovered = yield* run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
      expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
      expect(recovered).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);

      // The credential file holds nothing better: one attempt, one error.
      seen.length = 0;
      current = { endpoint: "http://127.0.0.1:1/mcp", authorization: "Bearer stale" };
      const rejected = yield* run([{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
      expect(seen).toEqual(["Bearer stale"]);
      expect(rejected[0]).toMatchObject({
        id: 2,
        error: { message: expect.stringContaining("HTTP 401") },
      });

      // Refreshed credentials that are rejected too: exactly one retry.
      seen.length = 0;
      current = { endpoint: "http://127.0.0.1:1/mcp", authorization: "Bearer also-revoked" };
      const stillRejected = yield* run([{ jsonrpc: "2.0", id: 3, method: "tools/list" }]);
      expect(seen).toEqual(["Bearer stale", "Bearer also-revoked"]);
      expect(stillRejected[0]).toMatchObject({ id: 3, error: { code: -32603 } });
    }),
  );

  it.effect("replays a request after a transport failure only if it never reached a server", () =>
    Effect.gen(function* () {
      const transportFailure = (code: string) =>
        new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
      const run = (code: string) =>
        Effect.gen(function* () {
          const seen: Array<string> = [];
          const input = new NodeStream.PassThrough();
          const written: Array<string> = [];
          const fiber = yield* Effect.forkChild(
            runAcpMcpStdioBridge({
              endpoint: "http://127.0.0.1:1/mcp",
              authorization: "Bearer stale",
              readCredentials: async () => ({
                endpoint: "http://127.0.0.1:2/mcp",
                authorization: "Bearer stale",
              }),
              input,
              output: { write: (chunk: string) => void written.push(chunk) },
              fetchImplementation: async (url, init) => {
                seen.push(String(url));
                if (String(url) === "http://127.0.0.1:1/mcp") throw transportFailure(code);
                const body = JSON.parse(String(init?.body)) as { readonly id?: unknown };
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
                  headers: { "content-type": "application/json" },
                });
              },
            }),
          );
          input.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_click" } })}\n`,
          );
          input.end();
          yield* Fiber.join(fiber);
          return { seen, written: written.map((line) => JSON.parse(line) as unknown) };
        });

      // Refused: the old server is gone, so the moved one may run the call.
      const refused = yield* run("ECONNREFUSED");
      expect(refused.seen).toEqual(["http://127.0.0.1:1/mcp", "http://127.0.0.1:2/mcp"]);
      expect(refused.written).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);

      // Reset: the call may already have run, so it is not repeated.
      const reset = yield* run("ECONNRESET");
      expect(reset.seen).toEqual(["http://127.0.0.1:1/mcp"]);
      expect(reset.written[0]).toMatchObject({ id: 1, error: { code: -32603 } });

      const toolCallAttempts: Array<string> = [];
      const toolFailure = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer stale",
        readCredentials: async () => ({
          endpoint: "http://127.0.0.1:2/mcp",
          authorization: "Bearer stale",
        }),
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (url) => {
          toolCallAttempts.push(String(url));
          throw transportFailure("ECONNRESET");
        },
      }).pipe(Effect.flip);
      expect(toolFailure).toBeInstanceOf(AcpMcpBridgeError);
      expect(toolCallAttempts).toEqual(["http://127.0.0.1:1/mcp"]);
    }),
  );

  it.effect("re-initializes a session the server lost once, then gives up", () =>
    Effect.gen(function* () {
      const methods: Array<string> = [];
      let liveSession = "session-1";
      let loseEverySession = false;
      const { input, written, bridge } = makeHarness(async (request) => {
        const body = (await request.json()) as {
          readonly id?: unknown;
          readonly method?: string;
          readonly params?: unknown;
        };
        methods.push(`${body.method}@${request.headers.get("mcp-session-id") ?? "-"}`);
        if (body.method === "initialize") {
          if (body.id !== 1) {
            expect(body.params).toEqual({
              protocolVersion: "2025-06-18",
              clientInfo: { name: "a" },
            });
            liveSession = loseEverySession ? "session-lost-again" : "session-2";
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18" },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": liveSession } },
          );
        }
        if (request.headers.get("mcp-session-id") !== liveSession || loseEverySession) {
          return new Response(null, { status: 404 });
        }
        if (body.id === undefined) return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          headers: { "content-type": "application/json" },
        });
      });
      const fiber = yield* Effect.forkChild(bridge);
      const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
      const nextOutput = (count: number) =>
        Effect.promise(async () => {
          while (written.length < count) await new Promise((resolve) => setImmediate(resolve));
        });

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "a" } },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield* nextOutput(1);
      // The server restarts and forgets session-1.
      liveSession = "session-gone";
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      yield* nextOutput(2);
      expect(JSON.parse(written[1]!)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

      // A server that keeps losing the session gets one re-initialize per request.
      loseEverySession = true;
      methods.length = 0;
      send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      input.end();
      yield* Fiber.join(fiber);

      // The agent never sees the bridge's own initialize response.
      expect(written.map((line) => (JSON.parse(line) as { id?: unknown }).id)).toEqual([1, 2, 3]);
      expect(JSON.parse(written[2]!)).toMatchObject({ id: 3, error: { code: -32603 } });
      expect(methods).toEqual([
        "tools/list@session-2",
        "initialize@-",
        "notifications/initialized@session-lost-again",
      ]);
    }),
  );

  it.effect("restarts a terminal tool call once with refreshed credentials", () =>
    Effect.gen(function* () {
      const seen: Array<string | null> = [];
      const result = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer stale",
        readCredentials: async () => ({
          endpoint: "http://127.0.0.1:2/mcp",
          authorization: "Bearer fresh",
        }),
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (url, init) => {
          const authorization = new Headers(init?.headers).get("authorization");
          seen.push(`${url} ${authorization}`);
          if (authorization !== "Bearer fresh") return new Response(null, { status: 401 });
          const body = JSON.parse(String(init?.body)) as { id?: unknown; method?: unknown };
          if (body.id === undefined) return new Response(null, { status: 202 });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { ok: 1 },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": "s" } },
          );
        },
      });
      expect(result).toEqual({ ok: 1 });
      expect(seen).toEqual([
        "http://127.0.0.1:1/mcp Bearer stale",
        "http://127.0.0.1:2/mcp Bearer fresh",
        "http://127.0.0.1:2/mcp Bearer fresh",
        "http://127.0.0.1:2/mcp Bearer fresh",
      ]);

      seen.length = 0;
      const failure = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer stale",
        readCredentials: async () => ({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer revoked",
        }),
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (url, init) => {
          seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
          return new Response(null, { status: 401 });
        },
      }).pipe(Effect.flip);
      expect(failure.message).toContain("HTTP 401");
      expect(seen).toHaveLength(2);
    }),
  );
});
