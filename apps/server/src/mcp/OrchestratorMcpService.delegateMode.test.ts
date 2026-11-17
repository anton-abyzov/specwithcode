import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

// A worker sent to a provider that lacks the asked mode runs Supervised
// (RuntimePolicy.ts providerRuntimeMode); delegate_task must say so.
describe("delegate_task on a provider without the asked mode", () => {
  const parentThreadId = ThreadId.make("thread:mcp-mode-parent");
  const childThreadId = ThreadId.make("thread:mcp-mode-child");
  const parentRunId = RunId.make("run:mcp-mode-parent");
  const parentNodeId = NodeId.make("node:mcp-mode-root");
  const taskId = NodeId.make("node:mcp-mode-task");
  const projectId = ProjectId.make("project:mcp-mode");
  const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
  const museInstanceId = ProviderInstanceId.make("muse");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-mode"),
    requestNamespace: "provider-session:mcp-mode",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-mode",
      providerInstanceId: claudeInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const snapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: string;
    readonly model: string;
    readonly displayName?: string;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: [...input.supportedRuntimeModes] }),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T00:00:00.000Z",
    models: [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providers: ReadonlyArray<ServerProvider> = [
    snapshot({ instanceId: claudeInstanceId, driver: "claudeAgent", model: "claude-opus" }),
    snapshot({
      instanceId: museInstanceId,
      driver: "muse",
      model: "muse-wonder-full-1.0",
      displayName: "Muse Code",
      supportedRuntimeModes: ["approval-required", "full-access"],
    }),
  ];

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    runtimeMode: RuntimeMode,
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP mode parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection: { instanceId: claudeInstanceId, model: "claude-opus" },
        runtimeMode,
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: claudeInstanceId,
          modelSelection: { instanceId: claudeInstanceId, model: "claude-opus" },
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = (runtimeMode: RuntimeMode) =>
    ({
      thread: { id: childThreadId, runtimeMode },
      runs: [],
      contextTransfers: [],
      messages: [],
      subagents: [],
      providerThreads: [],
      turnItems: [],
    }) as unknown as OrchestrationV2ThreadProjection;

  const delegate = (input: {
    readonly parentMode: RuntimeMode;
    readonly runtimeMode?: RuntimeMode;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    /** The child as stored, when dispatch replays an earlier round's child. */
    readonly storedChildMode?: RuntimeMode;
    /** What the registry lists before its first refresh. */
    readonly staleProviders?: ReadonlyArray<ServerProvider>;
  }) =>
    Effect.gen(function* () {
      let providerReads = 0;
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make(String(input.instanceId)),
        providerInstanceId: input.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: input.model,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [], input.parentMode)
                : childProjection(input.storedChildMode ?? input.runtimeMode ?? input.parentMode),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() =>
            providerReads++ === 0 && input.staleProviders !== undefined
              ? input.staleProviders
              : providers,
          ),
          refreshInstance: () => Effect.succeed(providers),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([claudeInstanceId, museInstanceId]),
            get: (instanceId) =>
              Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Review the diff.",
          target: { providerInstanceId: input.instanceId, model: input.model },
          ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
          increment: "none",
          mode: "async",
          clientRequestId: `delegate-mode-${input.parentMode}-${input.runtimeMode ?? "inherit"}`,
        });
        const [request] = (yield* Ref.get(dispatched)) as ReadonlyArray<{
          readonly runtimeMode: RuntimeMode;
        }>;
        return { result, request };
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("warns that a Muse worker asked for Auto runs Supervised", () =>
    Effect.gen(function* () {
      const { result, request } = yield* delegate({
        parentMode: "full-access",
        runtimeMode: "auto",
        instanceId: museInstanceId,
        model: "muse-wonder-full-1.0",
      });
      // The thread keeps the asked mode; only the warning is new.
      assert.equal(request?.runtimeMode, "auto");
      assert.include(result.warning ?? "", "Muse Code has no Auto mode");
      assert.include(result.warning ?? "", "runs Supervised");
      assert.include(result.warning ?? "", 'runtimeMode "full-access"');
    }),
  );

  it.effect("says nothing when the provider runs the asked mode", () =>
    Effect.gen(function* () {
      const { result } = yield* delegate({
        parentMode: "full-access",
        runtimeMode: "full-access",
        instanceId: museInstanceId,
        model: "muse-wonder-full-1.0",
      });
      assert.equal(result.warning, undefined);
    }),
  );

  it.effect("says nothing for a provider that lists no modes", () =>
    Effect.gen(function* () {
      const { result } = yield* delegate({
        parentMode: "auto",
        instanceId: claudeInstanceId,
        model: "claude-opus",
      });
      assert.equal(result.warning, undefined);
    }),
  );

  it.effect("warns from the provider list the target resolved against, not a stale one", () =>
    Effect.gen(function* () {
      const { result } = yield* delegate({
        parentMode: "full-access",
        runtimeMode: "auto",
        instanceId: museInstanceId,
        model: "muse-wonder-full-1.0",
        staleProviders: providers.filter((provider) => provider.instanceId !== museInstanceId),
      });
      assert.include(result.warning ?? "", "Muse Code has no Auto mode");
    }),
  );

  it.effect("warns from the replayed child's stored mode on a retry", () =>
    Effect.gen(function* () {
      const { result } = yield* delegate({
        parentMode: "full-access",
        runtimeMode: "full-access",
        storedChildMode: "auto",
        instanceId: museInstanceId,
        model: "muse-wonder-full-1.0",
      });
      assert.include(result.warning ?? "", "Muse Code has no Auto mode");
    }),
  );
});
