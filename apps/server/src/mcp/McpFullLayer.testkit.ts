/**
 * The whole studio-code `/mcp` layer over HTTP with stub services, for tests
 * that read the real `tools/list` (1483). The calling thread's shell is the
 * one `threadShell` returns; everything else is a stub that is never called
 * while listing.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
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

export type ListedTool = (typeof ToolsListPayload.Type)["result"]["tools"][number];

/** The fields of a thread shell the listing reads. */
export interface StubShell {
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly deletedAt: null;
}

const stubServices = (shell: StubShell | null) =>
  Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    Layer.mock(DeviceService.DeviceService)({}),
    Layer.mock(ComputerUseBroker.ComputerUseBroker)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell as never),
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
export const serveFullLayer = (shell: StubShell | null) =>
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
    Layer.provide(stubServices(shell)),
    Layer.build,
  );

/** `initialize`, then `tools/list`, as a thread's provider session would. */
export const listToolsAsThread = Effect.gen(function* () {
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
  const listResponse = yield* httpClient.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: auth,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
      "application/json",
    ),
  });
  const json = (yield* listResponse.text).match(/\{.*\}/s)![0];
  return (yield* Schema.decodeUnknownEffect(ToolsListPayload)(json)).result.tools;
});

export const fullLayerTestServices = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-full-layer-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);
