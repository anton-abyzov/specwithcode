import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProjectMemoryToolkit } from "./toolkits/projectMemory/tools.ts";
import { DesignToolkit } from "./toolkits/design/tools.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerConfig from "../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { DesignSystemProposals } from "../design/systems/DesignSystemService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as BrowserExtension from "../browserExtension/BrowserExtension.ts";
import * as ComputerUseBroker from "../computerUse/ComputerUseBroker.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ComputerUseBroker.ComputerUseBroker)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  // The design tools resolve owners through these.
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
    getEnvironmentId: Effect.succeed("environment-scratch" as never),
  }),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

/**
 * Where a schema still carries JSON noise `advertisedJsonSchema` drops. The `null` branch of an
 * optional property is checked separately against real nullable toolkit inputs below.
 */
const schemaNoise = (schema: unknown, path: string): Array<string> => {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => schemaNoise(item, `${path}[${i}]`));
  if (!Predicate.isObject(schema)) return [];
  const found: Array<string> = [];
  if (schema.additionalProperties === true) found.push(`${path}: additionalProperties true`);
  if (schema.maximum === Number.MAX_SAFE_INTEGER || schema.minimum === Number.MIN_SAFE_INTEGER)
    found.push(`${path}: safe-integer bound`);
  if (schema.type === "string" && schema.contentMediaType === "application/json")
    found.push(`${path}: JSON-string fallback`);
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (
        Predicate.isObject(branch) &&
        Array.isArray(branch.anyOf) &&
        Object.keys(branch).length === 1
      )
        found.push(`${path}: nested anyOf`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && Predicate.isObject(value)) {
      for (const [name, property] of Object.entries(value))
        found.push(...schemaNoise(property, `${path}.${name}`));
    } else found.push(...schemaNoise(value, `${path}/${key}`));
  }
  return found;
};

it.effect("every tool on /mcp advertises a compact input schema", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(layerRoutes, {
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
        Layer.provide(layerStubServices),
        Layer.build,
      );

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
      const tools = (yield* decodeToolsListPayload(json)).result.tools;
      // These nulls carry user intent (clear a value), unlike codec-only optional nulls.
      // Check the actual HTTP tools/list and the toolkit decoder together.
      const nullableCases = [
        {
          tool: ProjectToolkit.tools.studio_project_update,
          input: { projectId: "project-scratch" },
          fields: ["faviconPath", "projectIcon", "defaultThreadEnvMode", "defaultModelSelection"],
        },
        {
          tool: ProjectMemoryToolkit.tools.studio_project_memory_write,
          input: { name: "note.md", content: "fixture" },
          fields: ["expectedRevision"],
        },
        {
          tool: DesignToolkit.tools.design_create,
          input: { kind: "design", title: "Fixture" },
          fields: ["designSystem"],
        },
      ];
      for (const { tool, input, fields } of nullableCases) {
        const listed = tools.find((entry) => entry.name === tool.name);
        expect(listed, tool.name).toBeDefined();
        const schema = listed!.inputSchema as { properties: Record<string, unknown> };
        for (const field of fields) {
          const payload = { ...input, [field]: null };
          expect(yield* Schema.decodeUnknownEffect(tool.parametersSchema)(payload)).toMatchObject({
            [field]: null,
          });
          expect(schema.properties[field], `${tool.name}.${field}`).toMatchObject({
            anyOf: expect.arrayContaining([{ type: "null" }]),
          });
        }
      }
      const report = process.env.STUDIO_MCP_TOOL_LIST_REPORT;
      if (report) {
        const { writeFileSync } = yield* Effect.promise(() => import("node:fs"));
        writeFileSync(
          report,
          JSON.stringify({ tools: tools.length, toolListJsonBytes: Buffer.byteLength(json) }),
        );
      }

      expect(tools.length).toBeGreaterThan(50);
      for (const tool of tools) {
        expect(schemaNoise(tool.inputSchema, ""), tool.name).toEqual([]);
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-schemas-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
