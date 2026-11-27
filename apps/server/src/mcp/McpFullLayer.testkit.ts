/**
 * The whole studio-code `/mcp` layer over HTTP with stub services, for tests
 * that read the real `tools/list` (1483). The calling thread's shell is the
 * one `threadShell` returns; everything else is a stub that is never called
 * while listing.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";

import * as AccessRequests from "../access/AccessRequests.ts";
import * as BrowserExtension from "../browserExtension/BrowserExtension.ts";
import * as ComputerUseBroker from "../computerUse/ComputerUseBroker.ts";
import * as ServerConfig from "../config.ts";
import { DesignSystemProposals } from "../design/systems/DesignSystemService.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  }),
);
const decodeToolsList = Schema.decodeUnknownEffect(ToolsListPayload);

export type ListedTool = (typeof ToolsListPayload.Type)["result"]["tools"][number];

/** The fields of a thread shell the listing reads. */
export interface StubShell {
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly deletedAt: string | null;
}

/** What the stubs answer beyond the calling thread's shell. */
export interface StubOptions {
  /** The plan-card read's entries for the caller (1497 ownership); none by default. */
  readonly bound?: ReadonlyArray<ThreadIncrementProgress>;
}

/** The listing reads a few shell fields; a write tool needs a whole live shell. */
export type StubCaller = StubShell | OrchestrationV2ThreadShell | null;

const stubServices = (shell: StubCaller, options: StubOptions = {}) =>
  Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    Layer.mock(DeviceService.DeviceService)({}),
    Layer.mock(ComputerUseBroker.ComputerUseBroker)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell as never),
      listProjectThreads: () => Effect.succeed([]),
    }),
    Layer.mock(ThreadIncrementProgressService.ThreadIncrementProgressService)({
      read: (input) =>
        Effect.succeed({ projectId: input.projectId, threads: [...(options.bound ?? [])] }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(AccessRequests.AccessRequests)({}),
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
    ServerSettings.layerTest({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed("environment-scratch" as never),
    }),
  );

/** Serves `/mcp`; the calling thread's shell is `shell` (null: no such thread). */
export const serveFullLayer = (shell: StubCaller, options: StubOptions = {}) =>
  HttpRouter.serve(McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed("environment-scratch" as never),
      }),
    ),
    Layer.provide(PreviewAutomationBroker.layer),
    Layer.provide(PreviewBrowser.layer),
    Layer.provide(DesignSystemProposals.layer),
    Layer.provide(
      Layer.succeed(
        BrowserExtension.BrowserExtension,
        BrowserExtension.makeBrowserExtension({ stateDir: "/nonexistent-state", port: 1 }),
      ),
    ),
    Layer.provide(stubServices(shell, options)),
    Layer.build,
  );

/** `initialize` as a thread's provider session would; returns a poster for later requests. */
const threadSession = Effect.gen(function* () {
  const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
    threadId: ThreadId.make("thread-scratch"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  });
  const httpClient = yield* HttpClient.HttpClient;
  const auth = credential!.config.authorizationHeader;
  const initResponse = yield* httpClient.post("/mcp", {
    headers: { accept: "application/json, text/event-stream", authorization: auth },
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
      "application/json",
    ),
  });
  const sessionId = initResponse.headers["mcp-session-id"];
  /** Posts one JSON-RPC request and returns the JSON of its answer. */
  return (body: HttpBody.HttpBody) =>
    httpClient
      .post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body,
      })
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((text) => text.match(/\{.*\}/s)![0]),
      );
});

/** `initialize`, then `tools/list`, as a thread's provider session would. */
export const listToolsAsThread = Effect.gen(function* () {
  const post = yield* threadSession;
  const json = yield* post(
    HttpBody.text(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, "application/json"),
  );
  return (yield* decodeToolsList(json)).result.tools;
});

const ToolCallAnswer = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optional(
      Schema.Struct({
        isError: Schema.optional(Schema.Boolean),
        structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        content: Schema.optional(Schema.Array(Schema.Unknown)),
      }),
    ),
  }),
);
const decodeToolCallAnswer = Schema.decodeUnknownEffect(ToolCallAnswer);

/** `initialize`, then `tools/call`, as a thread's provider session would. */
export const callToolAsThread = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const post = yield* threadSession;
    const json = yield* post(
      HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    return yield* decodeToolCallAnswer(json);
  });

export const fullLayerTestServices = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-full-layer-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);
