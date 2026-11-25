import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// A declared tool failure comes back as `isError` with its payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-elicitation-refusal", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-elicitation-refusal", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadId = ThreadId.make("worker-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-elicitation-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "full-access" },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

it.effect("an agent cannot answer an MCP server's form card", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "studio_pending_request_respond",
        arguments: { threadId, requestId: "elicitation-card", answers: { confirm: "octo/repo" } },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({
      code: "invalid_request",
      message: "Only the user can answer an approval card. Wait for their answer.",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ projectId: "project-a", deletedAt: null } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  projectId: "project-a",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  deletedAt: null,
                },
                runs: [],
                runtimeRequests: [
                  { id: "elicitation-card", kind: "mcp-elicitation", status: "pending" },
                ],
                turnItems: [],
              } as never),
            dispatch: () => Effect.die("an MCP form must not be answered by an agent"),
          }),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);
