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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const providerToken = "spanProbeTokenWithoutDots";
const privateNote = "private prompt text for the span probe";
const providerScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-span-test"),
  requestNamespace: "provider-session-span",
  thread: {
    threadId: ThreadId.make("thread-span-test"),
    providerSessionId: "provider-session-span",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

/** Records every span, and the order spans start and end in, by span ID. */
const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const order: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      order.push(`start ${span.spanId}`);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        order.push(`end ${span.spanId}`);
      };
      return span;
    },
  });
  return { tracer, spans, order };
};

const ProbeToolkit = Toolkit.make(
  Tool.make("span_probe", {
    description: "Takes a note and reports success.",
    parameters: Schema.Struct({ note: Schema.String }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const authSpanName = "McpHttpServer.authenticateRequest";

it.effect("ends the authentication span before the tool runs and keeps arguments off spans", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const traced = recordSpans();
      // Whether an authentication span was still open when the tool body ran.
      const openAuthSpansDuringTool: Array<number> = [];
      const shellsRead: Array<ThreadId> = [];
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          span_probe: McpToolAccess.reads(() =>
            Effect.sync(() => {
              const ended = new Set(
                traced.order.filter((entry) => entry.startsWith("end ")).map((e) => e.slice(4)),
              );
              openAuthSpansDuringTool.push(
                traced.spans.filter((span) => span.name === authSpanName && !ended.has(span.spanId))
                  .length,
              );
              return { ok: true };
            }).pipe(Effect.withSpan("span_probe.work")),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(token === providerToken ? providerScope : undefined),
          }),
        ),
        // As in production, the advisor-caller guard reads the caller's thread.
        Layer.provide(McpToolAccessTestkit.recordingLiveThreadsLayer(shellsRead)),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
        Effect.withTracer(traced.tracer),
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${providerToken}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const called = yield* httpClient.post("/mcp", {
        headers: {
          ...headers,
          "mcp-session-id": initialize.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "span_probe", arguments: { note: privateNote } },
          }),
          "application/json",
        ),
      });
      expect(called.status).toBe(200);
      expect(yield* called.text).toContain('\\"ok\\":true');

      // Authentication ran in its own span, and it had ended before the tool body ran.
      expect(openAuthSpansDuringTool).toEqual([0]);
      expect(shellsRead).toEqual([providerScope.thread.threadId]);
      const toolSpan = traced.spans.find((span) => span.name === "mcp.tool.span_probe");
      expect(Object.fromEntries(toolSpan?.attributes ?? [])).toEqual({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": "span_probe",
      });
      const authSpan = traced.spans.find(
        (span) => span.name === authSpanName && span.traceId === toolSpan?.traceId,
      );
      expect(authSpan).toBeDefined();
      // The handler's own spans still nest under the tool span.
      const workSpan = traced.spans.find((span) => span.name === "span_probe.work");
      expect(workSpan?.parent.pipe(Option.map((parent) => parent.spanId))).toEqual(
        Option.some(toolSpan?.spanId),
      );
      expect(traced.order.slice(0, traced.order.indexOf(`start ${toolSpan?.spanId}`))).toContain(
        `end ${authSpan?.spanId}`,
      );
      // No span anywhere carries the tool's arguments.
      for (const span of traced.spans) {
        expect(`${span.name} ${JSON.stringify([...span.attributes.values()])}`).not.toContain(
          privateNote,
        );
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
