/**
 * The advisor-caller guard (`McpToolAccess.refuseAdvisorCaller`) on the
 * server as production assembles it: every toolkit of `McpHttpServer.layer`,
 * with the thread service provided from outside the MCP layer the way
 * server.ts provides the runtime's services. The guard reads that service
 * from the handlers layer's build environment, so an assembly that lost it
 * would refuse ordinary callers of every tool that is not read-only. This
 * calls those tools over HTTP as an advisor child, an ordinary thread and an
 * outside client.
 */
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

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
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { THREAD_CONTENT_TOOLS } from "./studioReadOnlyTools.ts";

const environmentId = EnvironmentId.make("environment-advisor-guard");
const advisorThreadId = ThreadId.make("thread-advisor-child");
const ordinaryThreadId = ThreadId.make("thread-ordinary");

const threadScope = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session-guard",
  thread: undefined,
  client: { sessionId: "session-guard", label: "Claude Code", access: "auto" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const tokens = {
  advisor: "advisorTokenWithoutDots",
  ordinary: "ordinaryTokenWithoutDots",
  client: "client-payload.client-signature",
} as const;

/** Which threads the guard asked about, in order. */
const shellReads: Array<ThreadId> = [];

const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.sync(() => {
      shellReads.push(threadId);
      const shell = McpToolAccessTestkit.liveThreadShell(threadId);
      return threadId === advisorThreadId ? { ...shell, purpose: "advisor" as const } : shell;
    }),
});

// Every other service is a stub: a tool that gets past the guard fails
// inside its handler, which is not what this test is about.
const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ComputerUseBroker.ComputerUseBroker)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(AccessRequests.AccessRequests)({}),
  // Hands-on toolkits ask whether the caller is its project's coordinator first.
  McpToolAccessTestkit.noProjectsLayer,
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
    getEnvironmentId: Effect.succeed(environmentId),
  }),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Unknown,
          annotations: Schema.optional(
            Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) }),
          ),
        }),
      ),
    }),
  }),
);

/** The smallest arguments the advertised schema asks for, so most calls decode. */
const minimalArguments = (schema: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(schema)) return {};
  const properties = Predicate.isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as Array<string>) : [];
  return Object.fromEntries(required.map((name) => [name, sampleValue(properties[name])]));
};

const sampleValue = (schema: unknown): unknown => {
  if (!Predicate.isObject(schema)) return "x";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("const" in schema) return schema.const;
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (branches !== undefined && branches.length > 0) return sampleValue(branches[0]);
  switch (schema.type) {
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return minimalArguments(schema);
    case "null":
      return null;
    default:
      return typeof schema.minLength === "number" ? "x".repeat(Math.max(1, schema.minLength)) : "x";
  }
};

/** Arguments for tools whose schemas the sampler above cannot satisfy. */
const argumentsFor: Record<string, Record<string, unknown>> = {
  studio_project_memory_write: { name: "project_notes.md", content: "x" },
  create_threads: { threads: [{ prompt: "Go" }] },
  studio_threads_wait: { threads: ["thread-missing"], timeoutMs: 1 },
  studio_thread_search: { query: "plan" },
};

const ADVISOR_UNKNOWN = "could not confirm that the calling thread is not an advisor";

it.effect(
  "refuses only the advisor child on every non-read-only tool of the production assembly",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const layerRoutes = McpHttpServer.layer.pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(
                  token === tokens.advisor
                    ? threadScope(advisorThreadId)
                    : token === tokens.ordinary
                      ? threadScope(ordinaryThreadId)
                      : undefined,
                ),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === `Bearer ${tokens.client}`
                    ? clientScope
                    : undefined,
                ),
            }),
          ),
        );
        // As in server.ts: the runtime's services, the thread service among
        // them, reach the MCP layer from outside it.
        yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(environmentId),
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
          Layer.provide(layerThreads),
          Layer.build,
        );

        const httpClient = yield* HttpClient.HttpClient;
        const session = (token: string) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"guard","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            expect(initialize.status).toBe(200);
            const sessionHeaders = {
              ...headers,
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
            };
            let id = 1;
            return (method: string, params: unknown) =>
              httpClient
                .post("/mcp", {
                  headers: sessionHeaders,
                  body: HttpBody.text(
                    JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
                    "application/json",
                  ),
                })
                .pipe(Effect.flatMap((response) => response.text));
          });

        const asAdvisor = yield* session(tokens.advisor);
        const asOrdinary = yield* session(tokens.ordinary);
        const asClient = yield* session(tokens.client);

        const listed = (yield* asOrdinary("tools/list", {})).match(/\{.*\}/s)![0];
        const tools = (yield* Schema.decodeUnknownEffect(ToolsListPayload)(listed)).result.tools;
        // Tools that change something, plus read-only ones that return other threads' text.
        const changing = tools.filter(
          (tool) => tool.annotations?.readOnlyHint !== true || THREAD_CONTENT_TOOLS.has(tool.name),
        );
        expect(changing.length).toBeGreaterThan(40);

        const refusedAdvisor: Array<string> = [];
        const reachedPastDecoding: Array<string> = [];
        for (const tool of changing) {
          const params = {
            name: tool.name,
            arguments: argumentsFor[tool.name] ?? minimalArguments(tool.inputSchema),
          };
          const advisorReads = shellReads.length;
          const advisor = yield* asAdvisor("tools/call", params);
          // The guard read the advisor's shell only when the call decoded.
          const guarded = shellReads.slice(advisorReads).includes(advisorThreadId);
          if (guarded) reachedPastDecoding.push(tool.name);
          if (advisor.includes(McpToolAccess.ADVISOR_CALLER_REFUSAL))
            refusedAdvisor.push(tool.name);
          expect(advisor, tool.name).not.toContain(ADVISOR_UNKNOWN);

          const ordinary = yield* asOrdinary("tools/call", params);
          expect(ordinary, tool.name).not.toContain(McpToolAccess.ADVISOR_CALLER_REFUSAL);
          expect(ordinary, tool.name).not.toContain(ADVISOR_UNKNOWN);

          const client = yield* asClient("tools/call", params);
          expect(client, tool.name).not.toContain(McpToolAccess.ADVISOR_CALLER_REFUSAL);
          expect(client, tool.name).not.toContain(ADVISOR_UNKNOWN);
        }
        // Every call that decoded reached the guard and refused the advisor,
        // across the toolkits, the hands-on (`toWorkerLayer`) ones included.
        expect(refusedAdvisor).toEqual(reachedPastDecoding);
        expect(refusedAdvisor.length).toBeGreaterThan(30);
        for (const name of [
          "delegate_task",
          "studio_thread_launch",
          "studio_project_memory_write",
          "studio_report_save",
          "preview_open",
          "chrome_open",
          "computer_click",
          "device_open",
          "studio_worktree_handoff",
          "link_pull_request",
          "design_create",
          "create_threads",
          // Not read-only: reading a direct child's result acknowledges its delivery.
          "studio_thread_read",
          // Read-only, but an advisor sees only its brief, never other threads.
          ...THREAD_CONTENT_TOOLS,
        ])
          expect(refusedAdvisor, name).toContain(name);
        // Read-only tools such as studio_thread_list never reach the guard.
        expect(changing.map((tool) => tool.name)).not.toContain("studio_thread_list");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-advisor-guard-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  30_000,
);
