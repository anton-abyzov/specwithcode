// Runs scripts/studio-verify/mcp-after-restart.mjs (the release check for
// installed builds) against a real MCP HTTP server and credential files.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const script = NodeURL.fileURLToPath(
  new URL("../../../../scripts/studio-verify/mcp-after-restart.mjs", import.meta.url),
);
const threadId = ThreadId.make("thread-mcp-after-restart-script");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-mcp-after-restart")),
  getDescriptor: Effect.die("unused"),
});

// The two tools the script calls, gated as the real ones are.
const ScriptToolkit = Toolkit.make(
  Tool.make("orchestrator_capabilities", {
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("task_status", {
    parameters: Schema.Struct({ taskId: Schema.String }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
);

const layerIdleThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  // No turn was stopped.
  getThreadRecords: (id) =>
    Effect.succeed(idleThreadProjection(liveThreadShell(id, { activeRunId: null }))),
  getThreadShell: (id) =>
    Effect.succeed({
      ...liveThreadShell(id, { activeRunId: null }),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
    }),
});

const layerSecretStore = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-script-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const startServer = (store: ServerSecretStore.ServerSecretStore["Service"]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const layerRegistry = Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.__testing.makeActive({ secretStore: store }),
    ).pipe(Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)));
    const layerServer = HttpRouter.serve(
      McpHttpServer.toolkitRegistration(
        ScriptToolkit,
        McpToolAccess.toLayer(ScriptToolkit, {
          orchestrator_capabilities: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
          task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "task_not_found",
                message: `Delegated task ${taskId} was not found.`,
              }),
            ),
          ),
        }),
      ).pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport), Layer.provide(layerIdleThreads)),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provideMerge(layerRegistry),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
      ),
    );
    const context = yield* Layer.buildWithScope(layerServer, scope);
    return {
      registry: Context.get(context, McpSessionRegistry.McpSessionRegistry),
      stop: Scope.close(scope, Exit.void),
    };
  });

interface ScriptResult {
  readonly code: number;
  readonly output: {
    readonly ok: boolean;
    readonly before: ReadonlyArray<{ read: string; write?: string; reason?: string }>;
    readonly failures: ReadonlyArray<string>;
  };
}

const runScript = (baseDir: string) =>
  Effect.callback<ScriptResult>((resume) => {
    NodeChildProcess.execFile(
      process.execPath,
      [script, "--base-dir", baseDir, "--json"],
      { timeout: 60_000 },
      (error, stdout) => {
        resume(
          Effect.succeed({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
            output: JSON.parse(stdout),
          }),
        );
      },
    );
  });

it.effect(
  "the installed-build check reads, sees who may write, and catches a dead credential",
  () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const server = yield* startServer(store);
      const issued = yield* server.registry.issue({ threadId, providerInstanceId });
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-after-restart-"));
      const secrets = NodePath.join(baseDir, "userdata", "secrets");
      NodeFS.mkdirSync(secrets, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secrets, `mcp-session-${"a".repeat(32)}.bin`),
        JSON.stringify({
          endpoint: issued.config.endpoint,
          authorization: issued.config.authorizationHeader,
        }),
        { mode: 0o600 },
      );

      // Its provider session is attached: the coordinator can change things.
      McpProviderSession.setMcpProviderSession(issued.config);
      const live = yield* runScript(baseDir);
      expect(live.code).toBe(0);
      expect(live.output.before).toMatchObject([{ read: "ok", write: "live" }]);

      // After a restart nothing holds it yet: it reads, and a change says what to do.
      McpProviderSession.clearMcpProviderSession(threadId);
      const detached = yield* runScript(baseDir);
      expect(detached.code).toBe(0);
      expect(detached.output.before).toMatchObject([{ read: "ok", write: "refused" }]);
      expect(detached.output.before[0]?.reason).toContain("next message attaches a new session");

      // A retired credential is a 401, which the check reports as a failure.
      yield* server.registry.invalidateThread(threadId);
      const retired = yield* runScript(baseDir);
      expect(retired.code).toBe(1);
      expect(retired.output.before).toMatchObject([{ read: "401" }]);

      yield* server.stop;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      Effect.provide(layerSecretStore),
    ),
);
