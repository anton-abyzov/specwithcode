import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type CloudSessionCreateInput,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as CloudSessions from "../../../cloudSessions/CloudSessions.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("cloud-thread");
const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("cloud-environment"),
  requestNamespace: "cloud-session",
  thread: {
    threadId,
    providerSessionId: "cloud-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  ...threadScope,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const record = (input: CloudSessionCreateInput & { createdByThreadId?: ThreadId | undefined }) => ({
  sessionId: "session_test",
  url: "https://claude.ai/code/session_test",
  title: input.title ?? "Task",
  task: input.task,
  repositoryPath: "/repo",
  branch: "main",
  remoteUrl: "https://github.com/acme/app.git",
  uploaded: input.upload === true,
  projectId: input.projectId ?? null,
  createdByThreadId: input.createdByThreadId ?? null,
  createdAt: "2026-10-16T00:00:00.000Z" as never,
  lastSentAt: null,
});

const listed: Array<ProjectId | undefined> = [];
const created: Array<CloudSessionCreateInput & { createdByThreadId?: ThreadId | undefined }> = [];
const layer = McpHttpServer.layerCloudToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mock(CloudSessions.CloudSessions)({
      create: (input) =>
        Effect.sync(() => {
          created.push(input);
          return { session: record(input), teleportCommand: "claude --teleport session_test" };
        }),
      list: (input) =>
        Effect.sync(() => {
          listed.push(input.projectId);
          return {
            availability: {
              status: "ready" as const,
              cliVersion: "2.1.301",
              authMethod: "claude.ai",
              subscriptionType: "max",
              reason: "Signed in.",
              fix: null,
              checkedAt: "2026-10-16T00:00:00.000Z" as never,
            },
            sessions: [],
          };
        }),
      send: () =>
        Effect.fail(
          new CloudSessions.CloudSessionError({
            reason: "unavailable",
            detail: "Claude Code is not signed in.",
          }),
        ),
    }),
  ),
);

const call = (
  name: string,
  args: Record<string, unknown>,
  invocation: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("a thread caller starts a session in its own project, recorded against its thread", () =>
  Effect.gen(function* () {
    const result = yield* call(
      "studio_cloud_session_create",
      { task: "Fix the flaky test" },
      threadScope,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      session: { sessionId: "session_test", projectId: "project:mcp-test" },
      teleportCommand: "claude --teleport session_test",
    });
    expect(created.at(-1)).toMatchObject({
      task: "Fix the flaky test",
      projectId: ProjectId.make("project:mcp-test"),
      createdByThreadId: threadId,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a client outside a thread must name the project, and a read-only client cannot start one",
  () =>
    Effect.gen(function* () {
      const untargeted = yield* call(
        "studio_cloud_session_create",
        { task: "Do it" },
        clientScope("auto"),
      );
      expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });
      const readOnly = yield* call(
        "studio_cloud_session_create",
        { task: "Do it", projectId: "project:other" },
        clientScope("read-only"),
      );
      expect(declaredFailure(readOnly)).toMatchObject({ code: "capability_denied" });
      const noCapability = yield* call(
        "studio_cloud_session_list",
        {},
        {
          ...threadScope,
          capabilities: new Set<never>(),
        },
      );
      expect(declaredFailure(noCapability)).toMatchObject({ code: "capability_denied" });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "list defaults to the caller's project; the service's own words come back under a known code",
  () =>
    Effect.gen(function* () {
      const list = yield* call("studio_cloud_session_list", {}, threadScope);
      expect(list.isError).toBe(false);
      expect(listed.at(-1)).toBe(ProjectId.make("project:mcp-test"));
      const result = yield* call(
        "studio_cloud_session_send",
        { sessionId: "session_test", message: "Also add a test" },
        threadScope,
      );
      expect(declaredFailure(result)).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "provider_unavailable",
        message: "Claude Code is not signed in.",
      });
    }).pipe(Effect.provide(layer)),
);
