import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const setup = () => {
  const parentId = ThreadId.make("parent");
  const childId = ThreadId.make("child");
  const runId = RunId.make("child-result-run");
  const itemId = TurnItemId.make("child-result-item");
  const messageId = MessageId.make("child-result-message");
  const taskId = NodeId.make("child-task");
  const now = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
  const text = "Finished the bounded task.";
  const parentShell = liveThreadShell(parentId);
  const childShell = {
    ...liveThreadShell(childId, { activeRunId: null }),
    lineage: {
      rootThreadId: parentId,
      parentThreadId: parentId,
      relationshipToParent: "subagent" as const,
    },
  };
  const parent = {
    ...idleThreadProjection(parentShell),
    contextTransfers: [
      {
        id: ContextTransferId.make("result-transfer"),
        type: "subagent_result",
        sourceThreadId: childId,
        targetThreadId: parentId,
        sourcePoint: { runId },
      },
    ],
    subagents: [
      {
        id: taskId,
        threadId: parentId,
        childThreadId: childId,
        origin: "app_owned",
        status: "completed",
        driver: "codex",
        model: "gpt-5",
        providerInstanceId: parentShell.providerInstanceId,
        result: text,
        completionDelivery: { state: "pending" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const item = {
    id: itemId,
    threadId: childId,
    runId,
    messageId,
    type: "assistant_message",
    title: null,
    status: "completed",
    text,
    ordinal: 1,
    updatedAt: now,
    createdAt: now,
    streaming: false,
  };
  const row = {
    sourceThreadId: childId,
    sourceItemId: itemId,
    position: 0,
    visibility: "local",
    item,
  };
  const child = {
    ...idleThreadProjection(childShell),
    runs: [
      {
        id: runId,
        threadId: childId,
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
        providerInstanceId: childShell.providerInstanceId,
        modelSelection: childShell.modelSelection,
        requestedAt: now,
        rootNodeId: taskId,
        failure: null,
      },
    ],
    messages: [{ id: messageId, runId, role: "assistant", text, createdAt: now, updatedAt: now }],
    turnItems: [item],
    visibleTurnItems: [row],
  } as unknown as OrchestrationV2ThreadProjection;
  const dispatched: string[] = [];
  const readTargets: string[] = [];
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(id === childId ? childShell : id === parentId ? parentShell : null),
      getThreadRecords: (id) => Effect.succeed(id === parentId ? parent : child),
      getProjectThreadRecords: ({ threadId }) =>
        Effect.sync(() => {
          readTargets.push(threadId);
          return child;
        }),
      getTimelinePage: () =>
        Effect.succeed({
          items: child.visibleTurnItems,
          totalItems: 1,
          hasMore: false,
          nextPosition: null,
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command.type);
          return {} as never;
        }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("env"),
    requestNamespace: "read-regression",
    issuedAt: 0,
    thread: {
      threadId: parentId,
      providerSessionId: "session",
      providerInstanceId: parentShell.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
  };
  return {
    childId,
    text,
    scope,
    dispatched,
    readTargets,
    layer: OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)),
  };
};

describe("actual thread-read acknowledgement", () => {
  for (const acknowledgeResult of [false, true, undefined])
    it.effect(
      `preserves the full result with acknowledgeResult=${String(acknowledgeResult)}`,
      () => {
        const fx = setup();
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const before = [...fx.dispatched];
          const read = yield* service.readThread(fx.scope, {
            threadId: fx.childId,
            ...(acknowledgeResult === undefined ? {} : { acknowledgeResult }),
          });
          expect(read.items).toMatchObject([
            { type: "assistant_message", text: fx.text, textTruncated: false },
          ]);
          expect(fx.readTargets).toContain(fx.childId);
          expect(fx.dispatched).toEqual(
            acknowledgeResult === false
              ? before
              : ["delegated_task.completion-delivery.acknowledge"],
          );
        }).pipe(Effect.provide(fx.layer));
      },
    );

  it.effect("retains missing-target refusal on a non-acknowledging read", () => {
    const fx = setup();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .readThread(fx.scope, { threadId: ThreadId.make("missing"), acknowledgeResult: false })
        .pipe(Effect.flip);
      expect(error.code).toBe("thread_not_found");
      expect(fx.dispatched).toEqual([]);
      expect(fx.readTargets).toEqual([]);
    }).pipe(Effect.provide(fx.layer));
  });
});
