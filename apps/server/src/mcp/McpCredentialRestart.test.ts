// Drives a real stdio bridge against real MCP HTTP servers over loopback.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-mcp-restart");
const providerInstanceId = ProviderInstanceId.make("grok");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-mcp-restart")),
  getDescriptor: Effect.die("unused"),
});

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the calling thread.",
    success: Schema.Struct({ threadId: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("act", {
    description: "Changes something as the calling thread.",
    success: Schema.Struct({ threadId: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
);

/** The calling thread between turns: it runs on `providerInstanceId`, no turn is live. */
const layerIdleThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  // No turn was stopped.
  getThreadRecords: (id) =>
    Effect.succeed(idleThreadProjection(liveThreadShell(id, { activeRunId: null }))),
  getThreadShell: (id) =>
    Effect.succeed({
      ...liveThreadShell(id, { activeRunId: null }),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "grok-4" },
    }),
});

const layerSecretStore = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-restart-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** One server lifetime: a fresh MCP transport and registry over the shared secret store. */
const startServer = (store: ServerSecretStore.ServerSecretStore["Service"], port: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const layerRegistry = Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.__testing.makeActive({ secretStore: store }),
    ).pipe(Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)));
    const layerServer = HttpRouter.serve(
      McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.map((scope) => ({ threadId: scope.thread?.threadId ?? "none" })),
            ),
          ),
          act: McpToolAccess.actsAsCaller(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.map((scope) => ({ threadId: scope.thread?.threadId ?? "none" })),
            ),
          ),
        }),
      ).pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport), Layer.provide(layerIdleThreads)),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provideMerge(layerRegistry),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port, host: "127.0.0.1" }),
      ),
    );
    const context = yield* Layer.buildWithScope(layerServer, scope);
    const address = Context.get(context, HttpServer.HttpServer).address;
    return {
      registry: Context.get(context, McpSessionRegistry.McpSessionRegistry),
      port: NetAddress.isInetAddress(address) ? address.port : 0,
      stop: Scope.close(scope, Exit.void),
    };
  });

/** A stdio bridge as an ACP agent runs it, with every HTTP attempt counted. */
const startBridge = (
  credentials: { readonly endpoint: string; readonly authorization: string },
  credentialFile: string | undefined,
) =>
  Effect.gen(function* () {
    const input = new NodeStream.PassThrough();
    const output = yield* Queue.unbounded<{
      readonly id?: unknown;
      readonly result?: unknown;
      readonly error?: unknown;
    }>();
    const attempts: Array<string> = [];
    const fiber = yield* runAcpMcpStdioBridge({
      ...credentials,
      ...(credentialFile === undefined ? {} : { credentialFile }),
      input,
      output: {
        write: (chunk: string) => Queue.offerUnsafe(output, JSON.parse(chunk)),
      },
      fetchImplementation: (url, init) => {
        attempts.push(url);
        return fetch(url, init);
      },
    }).pipe(Effect.forkChild);
    const request = (id: number, method: string, params: unknown) =>
      Effect.gen(function* () {
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        while (true) {
          const message = yield* Queue.take(output);
          if (message.id === id) return message;
        }
      });
    const notify = (method: string) =>
      Effect.sync(() => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`));
    const initialize = Effect.gen(function* () {
      const response = yield* request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "restart-probe", version: "1.0.0" },
      });
      expect(response.error).toBeUndefined();
      yield* notify("notifications/initialized");
    });
    let nextId = 100;
    const probe = Effect.suspend(() =>
      request(nextId++, "tools/call", { name: "probe", arguments: {} }),
    );
    const act = Effect.suspend(() =>
      request(nextId++, "tools/call", { name: "act", arguments: {} }),
    );
    return {
      attempts,
      initialize,
      probe,
      act,
      stop: Effect.sync(() => input.end()).pipe(Effect.andThen(Fiber.join(fiber))),
    };
  });

const probedThread = (response: { readonly result?: unknown }) =>
  (response.result as { readonly structuredContent?: { readonly threadId?: string } })
    ?.structuredContent?.threadId;

/** The refusal a tool call returned, if any. */
const refusal = (response: { readonly result?: unknown }) => {
  const result = response.result as
    | { readonly isError?: boolean; readonly content?: ReadonlyArray<{ readonly text?: string }> }
    | undefined;
  if (result?.isError !== true) return undefined;
  return JSON.parse(result.content?.[0]?.text ?? "{}") as {
    readonly code?: string;
    readonly message?: string;
  };
};

it.effect(
  "a coordinator's agent acts between turns, and after a restart again once its next turn attaches",
  () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const first = yield* startServer(store, 0);
      const issued = yield* first.registry.issue({ threadId, providerInstanceId });
      // The provider session that holds the credential is attached.
      McpProviderSession.setMcpProviderSession(issued.config);
      const bridge = yield* startBridge(
        { endpoint: issued.config.endpoint, authorization: issued.config.authorizationHeader },
        issued.config.credentialFile,
      );
      yield* bridge.initialize;
      // Its turn ended; a background agent or workflow it started still works.
      expect(probedThread(yield* bridge.act)).toBe(threadId);

      // The server restarts. No session holds the credential in the new one yet.
      yield* first.stop;
      McpProviderSession.clearMcpProviderSession(threadId);
      const second = yield* startServer(store, first.port);
      const read = yield* bridge.probe;
      expect(read.error).toBeUndefined();
      expect(probedThread(read)).toBe(threadId);
      // A change is refused with what to do, not with a 401 that ends the toolkit.
      const refused = refusal(yield* bridge.act);
      expect(refused?.code).toBe("parent_not_active");
      expect(refused?.message).toContain("next message attaches a new session");

      // The thread's next message attaches a session, which issues the same
      // credential: the agent's existing MCP client acts again, unchanged.
      const reissued = yield* second.registry.issue({ threadId, providerInstanceId });
      expect(reissued.config.authorizationHeader).toBe(issued.config.authorizationHeader);
      McpProviderSession.setMcpProviderSession(reissued.config);
      expect(probedThread(yield* bridge.act)).toBe(threadId);

      yield* bridge.stop;
      yield* second.stop;
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      Effect.provide(layerSecretStore),
    ),
);

it.effect("an agent session started before a server restart keeps its MCP tools after it", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const first = yield* startServer(store, 0);
    const issued = yield* first.registry.issue({ threadId, providerInstanceId });
    const bridge = yield* startBridge(
      { endpoint: issued.config.endpoint, authorization: issued.config.authorizationHeader },
      issued.config.credentialFile,
    );
    yield* bridge.initialize;
    expect(probedThread(yield* bridge.probe)).toBe(threadId);

    // The server restarts (an app update): MCP sessions and the in-memory
    // registry are gone, nothing re-issues the credential yet.
    yield* first.stop;
    const second = yield* startServer(store, first.port);
    const attemptsBefore = bridge.attempts.length;

    // The bridge's stale MCP session is re-established transparently and the
    // token it was spawned with is still honored.
    const afterRestart = yield* bridge.probe;
    expect(afterRestart.error).toBeUndefined();
    expect(probedThread(afterRestart)).toBe(threadId);
    // 404 on the stale session, initialize, initialized, retry.
    expect(bridge.attempts.length - attemptsBefore).toBe(4);
    expect(probedThread(yield* bridge.probe)).toBe(threadId);

    yield* bridge.stop;
    yield* second.stop;
  }).pipe(Effect.provide(layerSecretStore)),
);

it.effect("a bridge follows its credential to a server that moved and fails once revoked", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const first = yield* startServer(store, 0);
    const issued = yield* first.registry.issue({ threadId, providerInstanceId });
    const bridge = yield* startBridge(
      { endpoint: issued.config.endpoint, authorization: issued.config.authorizationHeader },
      issued.config.credentialFile,
    );
    yield* bridge.initialize;
    expect(probedThread(yield* bridge.probe)).toBe(threadId);

    // The restarted server listens elsewhere and its first session for the
    // thread rewrites the credential file.
    yield* first.stop;
    const second = yield* startServer(store, 0);
    expect(second.port).not.toBe(first.port);
    const reissued = yield* second.registry.issue({ threadId, providerInstanceId });
    expect(reissued.config.authorizationHeader).toBe(issued.config.authorizationHeader);

    const afterMove = yield* bridge.probe;
    expect(afterMove.error).toBeUndefined();
    expect(probedThread(afterMove)).toBe(threadId);
    expect(bridge.attempts.at(-1)).toBe(reissued.config.endpoint);

    // Archiving the thread retires the token for good: the bridge re-reads
    // the (now absent) credential file once, then reports the 401.
    yield* second.registry.invalidateThread(threadId);
    const attemptsBefore = bridge.attempts.length;
    const revoked = yield* bridge.probe;
    expect(revoked.error).toMatchObject({ message: expect.stringContaining("HTTP 401") });
    expect(bridge.attempts.length - attemptsBefore).toBe(1);

    yield* bridge.stop;
    yield* second.stop;
  }).pipe(Effect.provide(layerSecretStore)),
);

it.effect("archiving a thread after a restart retires the credential its agent still holds", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const first = yield* startServer(store, 0);
    const issued = yield* first.registry.issue({ threadId, providerInstanceId });
    const bridge = yield* startBridge(
      { endpoint: issued.config.endpoint, authorization: issued.config.authorizationHeader },
      issued.config.credentialFile,
    );
    yield* bridge.initialize;
    expect(probedThread(yield* bridge.probe)).toBe(threadId);

    // After the restart no live provider session remains to detach, so the
    // archive or delete effect alone must retire the restored credential.
    yield* first.stop;
    const second = yield* startServer(store, first.port);
    expect(probedThread(yield* bridge.probe)).toBe(threadId);
    yield* McpSessionRegistry.invalidateActiveMcpThread(threadId);
    const revoked = yield* bridge.probe;
    expect(revoked.error).toMatchObject({ message: expect.stringContaining("HTTP 401") });

    yield* second.stop;
    const third = yield* startServer(store, first.port);
    const afterAnotherRestart = yield* bridge.probe;
    expect(afterAnotherRestart.error).toMatchObject({
      message: expect.stringContaining("HTTP 401"),
    });

    yield* bridge.stop;
    yield* third.stop;
  }).pipe(Effect.provide(layerSecretStore)),
);
