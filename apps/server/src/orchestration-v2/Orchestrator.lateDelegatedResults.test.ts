import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

// A delegated task's result must reach the parent exactly once: a late read,
// a steer, an interrupt or a removed queue row may neither drop it nor send it
// twice.

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-orchestration-v2-late-delegated-results-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated result tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      repositoryIdentityNow: () => Effect.succeed(null),
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistryTest))),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

const providerThreadIdOf = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId)}`);

const runPayload = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly rootNodeId?: NodeId;
  readonly providerThreadId?: ProviderThreadId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}): OrchestrationV2Run => ({
  id: input.runId,
  threadId: input.threadId,
  ordinal: input.ordinal,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: input.providerThreadId ?? null,
  userMessageId: MessageId.make(`message:${input.runId}`),
  rootNodeId: input.rootNodeId ?? null,
  activeAttemptId: null,
  status: input.status,
  requestedAt: input.now,
  startedAt: input.now,
  completedAt: input.status === "running" ? null : input.now,
  checkpointId: null,
  contextHandoffId: null,
  ...(input.delegatedCompletion === undefined
    ? {}
    : { delegatedCompletion: input.delegatedCompletion }),
});

const runEvent = (run: OrchestrationV2Run, key: string) => ({
  id: EventId.make(`event:${run.id}:${key}`),
  type: "run.updated" as const,
  threadId: run.threadId,
  runId: run.id,
  providerInstanceId: run.providerInstanceId,
  occurredAt: run.requestedAt,
  payload: run,
});

/**
 * A parent thread whose live spawning run owns one terminal task, either
 * pending or already reserved for its first completion wake.
 */
const seedParent = (input: {
  readonly key: string;
  readonly deliveryState: "pending" | "claimed";
  readonly completionWake: "always" | "settled_only";
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${input.key}`);
    const projectId = ProjectId.make(`project:${input.key}`);
    const runId = RunId.make(`run:${input.key}:origin`);
    const rootNodeId = NodeId.make(`node:${input.key}:origin-root`);
    const taskId = NodeId.make(`node:${input.key}:first`);
    const deliveryMessageId = MessageId.make(`message:${input.key}:wake-1`);
    const providerThreadId = providerThreadIdOf(threadId);
    yield* projects.create({
      commandId: CommandId.make(`command:${input.key}:project`),
      projectId,
      title: "Late delegated results",
      workspaceRoot: `/workspace/${input.key}`,
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${input.key}:create`),
      threadId,
      projectId,
      title: "Late delegated results",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const origin = runPayload({
      threadId,
      runId,
      ordinal: 1,
      status: "running",
      now: input.now,
      rootNodeId,
      providerThreadId,
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery:
          input.deliveryState === "claimed"
            ? { generation: 1, messageId: deliveryMessageId, taskIds: [taskId] }
            : null,
      },
    });
    yield* sink.write({
      commandId: CommandId.make(`command:${input.key}:seed`),
      events: [
        {
          id: EventId.make(`event:${input.key}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${input.key}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        runEvent(origin, "seed"),
        {
          id: EventId.make(`event:${input.key}:origin-root`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: input.now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: input.now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.key}:first-task`),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId,
            runId,
            parentNodeId: rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Check the first part.",
            title: null,
            model: null,
            completionWake: input.completionWake,
            completionDelivery: { state: input.deliveryState, observedByRunId: null },
            status: "completed",
            result: "first part checked",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
    return { threadId, projectId, runId, rootNodeId, taskId, deliveryMessageId, origin };
  });

/** A sibling task of the origin run whose child thread is still working. */
const seedRunningSibling = (input: {
  readonly key: string;
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const taskId = NodeId.make(`node:${input.key}:sibling`);
    const childThreadId = ThreadId.make(`thread:${input.key}:sibling`);
    const childRun = runPayload({
      threadId: childThreadId,
      runId: RunId.make(`run:${input.key}:sibling`),
      ordinal: 1,
      status: "running",
      now: input.now,
    });
    yield* sink.write({
      commandId: CommandId.make(`command:${input.key}:sibling`),
      events: [
        {
          id: EventId.make(`event:${input.key}:sibling-thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: "Sibling",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.key}:sibling-task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: "Check the second part.",
            title: null,
            model: null,
            completionWake: "always",
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
        runEvent(childRun, "running"),
      ],
    });
    // The child's run ends with an answer; recovery settles the task the way
    // the terminal-run listener does, so the test never waits on a timer.
    const complete = Effect.gen(function* () {
      yield* sink.write({
        commandId: CommandId.make(`command:${input.key}:sibling-finished`),
        events: [
          {
            id: EventId.make(`event:${input.key}:sibling-answer`),
            type: "message.updated",
            threadId: childThreadId,
            runId: childRun.id,
            occurredAt: input.now,
            payload: {
              id: MessageId.make(`message:${input.key}:sibling-answer`),
              threadId: childThreadId,
              runId: childRun.id,
              nodeId: null,
              role: "assistant",
              text: "second part checked",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: input.now,
              updatedAt: input.now,
            },
          },
          runEvent({ ...childRun, status: "completed", completedAt: input.now }, "completed"),
        ],
      });
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
    });
    return { taskId, childThreadId, complete };
  });

const deliveryStateOf = (projection: OrchestrationV2ThreadProjection, taskId: NodeId) =>
  projection.subagents.find((task) => task.id === taskId)?.completionDelivery?.state;

const cohortOf = (projection: OrchestrationV2ThreadProjection, runId: RunId) =>
  projection.runs.find((run) => run.id === runId)?.delegatedCompletion;

/** Every completion wake message, and the reserved one, that carries the task. */
const wakesCarrying = (
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  taskId: NodeId,
) => {
  const delivery = cohortOf(projection, runId)?.delivery;
  const messages = projection.messages.filter(
    (message) =>
      message.delegatedCompletion?.parentRunId === runId &&
      message.delegatedCompletion.taskIds.includes(taskId),
  );
  const reservedWithoutMessage =
    delivery != null &&
    delivery.taskIds.includes(taskId) &&
    !messages.some((message) => message.id === delivery.messageId);
  return messages.length + (reservedWithoutMessage ? 1 : 0);
};

/** The origin run's turn ended; the parent thread is now idle. */
const endOrigin = (origin: OrchestrationV2Run, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const current = (yield* orchestrator.getThreadProjection(origin.threadId)).runs.find(
      (run) => run.id === origin.id,
    )!;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`command:${key}:origin-ended`),
      events: [runEvent({ ...current, status: "completed", completedAt: now }, "completed")],
    });
  });

/** Queues the reserved first completion wake the way the continuation service does. */
const dispatchFirstWake = (input: {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly taskIds: ReadonlyArray<NodeId>;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`command:${input.key}:wake`),
      threadId: input.threadId,
      messageId: input.messageId,
      text: "Delegated task completed",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: { parentRunId: input.runId, generation: 1, taskIds: input.taskIds },
    });
    return (yield* orchestrator.getThreadProjection(input.threadId)).runs.find(
      (run) => run.userMessageId === input.messageId,
    )!;
  });

it.layer(layerTest)("late delegated results", (it) => {
  it.effect("a read with no observing run wakes an idle parent with a pending result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const key = "late-read";
      const seeded = yield* seedParent({
        key,
        deliveryState: "pending",
        completionWake: "settled_only",
        now,
      });
      const acknowledge = (name: string) =>
        orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:${key}:${name}`),
          parentThreadId: seeded.threadId,
          taskId: seeded.taskId,
          observedByRunId: null,
        });

      // While the spawning turn runs, its blocking wait still owns the result.
      yield* acknowledge("while-live");
      const live = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.equal(
        deliveryStateOf(live, seeded.taskId),
        "pending",
        "a read no run observed must not mark the result seen",
      );

      yield* endOrigin(seeded.origin, key);
      yield* acknowledge("after-end");
      const woken = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.equal(
        deliveryStateOf(woken, seeded.taskId),
        "claimed",
        "the late read must wake the idle parent instead of swallowing the result",
      );
      assert.deepEqual(cohortOf(woken, seeded.runId)?.delivery?.taskIds, [seeded.taskId]);

      // Repeated reads and recovery reserve no second wake.
      yield* acknowledge("repeated");
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.recoverDelegatedTasks;
      const settled = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.deepEqual(cohortOf(settled, seeded.runId), cohortOf(woken, seeded.runId));
      assert.equal(wakesCarrying(settled, seeded.runId, seeded.taskId), 1);
      assert.equal(
        settled.subagents.find((task) => task.id === seeded.taskId)?.result,
        "first part checked",
      );
    }),
  );

  it.effect("interrupting a completion wake keeps a still-running sibling's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const key = "interrupted-wake";
      const seeded = yield* seedParent({
        key,
        deliveryState: "claimed",
        completionWake: "always",
        now,
      });
      const sibling = yield* seedRunningSibling({
        key,
        parentThreadId: seeded.threadId,
        projectId: seeded.projectId,
        parentRunId: seeded.runId,
        rootNodeId: seeded.rootNodeId,
        now,
      });
      yield* endOrigin(seeded.origin, key);
      const wake = yield* dispatchFirstWake({
        key,
        threadId: seeded.threadId,
        runId: seeded.runId,
        messageId: seeded.deliveryMessageId,
        taskIds: [seeded.taskId],
      });
      yield* orchestrator.resumeQueuedRuns;
      const started = (yield* orchestrator.getThreadProjection(seeded.threadId)).runs.find(
        (run) => run.id === wake.id,
      );
      assert.notEqual(started?.status, "queued");

      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`command:${key}:interrupt`),
        threadId: seeded.threadId,
        runId: wake.id,
      });
      const interrupted = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.equal(deliveryStateOf(interrupted, seeded.taskId), "disposed");
      assert.notEqual(
        deliveryStateOf(interrupted, sibling.taskId),
        "disposed",
        "the interrupt dropped a sibling result the wake never carried",
      );
      assert.equal(cohortOf(interrupted, seeded.runId)?.disposition, "open");

      yield* sibling.complete;
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.recoverDelegatedTasks;
      const after = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.include(["claimed", "delivered"], deliveryStateOf(after, sibling.taskId));
      assert.equal(wakesCarrying(after, seeded.runId, sibling.taskId), 1);
      assert.equal(wakesCarrying(after, seeded.runId, seeded.taskId), 1);
    }),
  );

  it.effect("removing a queued completion wake keeps its siblings' results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const key = "removed-wake";
      const seeded = yield* seedParent({
        key,
        deliveryState: "claimed",
        completionWake: "always",
        now,
      });
      const sibling = yield* seedRunningSibling({
        key,
        parentThreadId: seeded.threadId,
        projectId: seeded.projectId,
        parentRunId: seeded.runId,
        rootNodeId: seeded.rootNodeId,
        now,
      });
      yield* endOrigin(seeded.origin, key);
      // The parent is busy with another turn, so the wake waits in the queue.
      yield* sink.write({
        commandId: CommandId.make(`command:${key}:busy`),
        events: [
          runEvent(
            runPayload({
              threadId: seeded.threadId,
              runId: RunId.make(`run:${key}:busy`),
              ordinal: 2,
              status: "running",
              now,
            }),
            "running",
          ),
        ],
      });
      const wake = yield* dispatchFirstWake({
        key,
        threadId: seeded.threadId,
        runId: seeded.runId,
        messageId: seeded.deliveryMessageId,
        taskIds: [seeded.taskId],
      });
      assert.equal(wake.status, "queued");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`command:${key}:cancel`),
        threadId: seeded.threadId,
        runId: wake.id,
      });
      const removed = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.equal(
        removed.runs.find((run) => run.id === wake.id)?.status,
        "cancelled",
        "the removed wake row must leave the queue",
      );
      assert.equal(deliveryStateOf(removed, seeded.taskId), "disposed");
      // The removed wake's own result stays readable.
      assert.equal(
        removed.subagents.find((task) => task.id === seeded.taskId)?.result,
        "first part checked",
      );
      assert.notEqual(
        deliveryStateOf(removed, sibling.taskId),
        "disposed",
        "removing the wake dropped a sibling result it never carried",
      );
      assert.equal(cohortOf(removed, seeded.runId)?.disposition, "open");

      yield* sibling.complete;
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.resumeQueuedRuns;
      yield* orchestrator.recoverDelegatedTasks;
      const after = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.include(["claimed", "delivered"], deliveryStateOf(after, sibling.taskId));
      assert.equal(wakesCarrying(after, seeded.runId, sibling.taskId), 1);
      assert.notEqual(cohortOf(after, seeded.runId)?.delivery?.messageId, seeded.deliveryMessageId);
    }),
  );

  it.effect("settling a thread with a queued completion wake still drops every result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const key = "settled-wake";
      const seeded = yield* seedParent({
        key,
        deliveryState: "claimed",
        completionWake: "always",
        now,
      });
      const sibling = yield* seedRunningSibling({
        key,
        parentThreadId: seeded.threadId,
        projectId: seeded.projectId,
        parentRunId: seeded.runId,
        rootNodeId: seeded.rootNodeId,
        now,
      });
      yield* endOrigin(seeded.origin, key);
      const busy = runPayload({
        threadId: seeded.threadId,
        runId: RunId.make(`run:${key}:busy`),
        ordinal: 2,
        status: "running",
        now,
      });
      yield* sink.write({
        commandId: CommandId.make(`command:${key}:busy`),
        events: [runEvent(busy, "running")],
      });
      const wake = yield* dispatchFirstWake({
        key,
        threadId: seeded.threadId,
        runId: seeded.runId,
        messageId: seeded.deliveryMessageId,
        taskIds: [seeded.taskId],
      });
      yield* sink.write({
        commandId: CommandId.make(`command:${key}:busy-ended`),
        events: [
          runEvent({ ...busy, status: "cancelled", completedAt: now }, "cancelled"),
          runEvent({ ...wake, queueHeld: true }, "held"),
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`command:${key}:settle`),
        threadId: seeded.threadId,
      });
      const settled = yield* orchestrator.getThreadProjection(seeded.threadId);
      assert.equal(settled.runs.find((run) => run.id === wake.id)?.status, "cancelled");
      assert.equal(deliveryStateOf(settled, sibling.taskId), "disposed");
      assert.equal(cohortOf(settled, seeded.runId)?.disposition, "disposed");
    }),
  );
});

// A provider that cannot steer a live turn restarts it with the steer as the
// run's new input, so the completion wake it was running is replaced.
const restartingSteerHarness = Effect.fn("restartingSteerHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const started: ProviderAdapterV2TurnInput[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: true,
    },
  };
  const adapter: ProviderAdapterV2Shape = {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId: modelSelection.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.die("this provider restarts instead of steering"),
          // The restart waits for the interrupted turn to end before it starts the next.
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              const turn = started.find(
                (candidate) => `provider-turn:${candidate.attemptId}` === providerTurnId,
              );
              if (turn === undefined) return;
              const at = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "interrupted",
                  startedAt: at,
                  completedAt: at,
                },
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const projectId = ProjectId.make(`project:${name}`);
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false, databaseLayer: fixtureProjectDatabase([projectId]) },
  );
  return { cwd, events, started, layer, projectId };
});

const steeredWakeScenario = (name: string, siblingFinishesFirst: boolean) =>
  Effect.gen(function* () {
    const harness = yield* restartingSteerHarness(name);
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`thread:${name}`);
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const turnRunning = (ordinal: number) =>
        watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.ordinal === ordinal,
        );
      const finishTurn = (turn: ProviderAdapterV2TurnInput) =>
        Effect.gen(function* () {
          const providerTurn = (yield* orchestrator.getThreadProjection(
            threadId,
          )).providerTurns.find((candidate) => candidate.runAttemptId === turn.attemptId)!;
          const settled = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turn.runId &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(harness.events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...providerTurn,
              status: "completed",
              completedAt: yield* DateTime.now,
            },
          });
          yield* Queue.offer(harness.events, {
            type: "turn.terminal",
            driver,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnId: providerTurn.id,
            runOrdinal: turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
        });

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`command:${name}:create`),
        threadId,
        projectId: harness.projectId,
        title: "Steered completion wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: harness.cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const originRunning = yield* turnRunning(1);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:${name}:first`),
        threadId,
        messageId: MessageId.make(`message:${name}:first`),
        text: "split the review in two",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(originRunning);
      const origin = harness.started[0]!;
      const now = yield* DateTime.now;
      const sibling = (key: string) =>
        seedRunningSibling({
          key: `${name}-${key}`,
          parentThreadId: threadId,
          projectId: harness.projectId,
          parentRunId: origin.runId,
          rootNodeId: origin.rootNodeId,
          now,
        });
      const first = yield* sibling("first");
      const second = yield* sibling("second");
      yield* finishTurn(origin);

      yield* first.complete;
      const firstDelivery = cohortOf(
        yield* orchestrator.getThreadProjection(threadId),
        origin.runId,
      )?.delivery;
      assert.deepEqual(firstDelivery?.taskIds, [first.taskId]);
      const wakeRunning = yield* turnRunning(2);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:${name}:first-wake`),
        threadId,
        messageId: firstDelivery!.messageId,
        text: "Delegated task completed",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        delegatedCompletion: {
          parentRunId: origin.runId,
          generation: firstDelivery!.generation,
          taskIds: firstDelivery!.taskIds,
        },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      yield* Fiber.join(wakeRunning);
      const wake = harness.started[1]!;
      assert.equal(wake.message.messageId, firstDelivery!.messageId);

      if (siblingFinishesFirst) {
        yield* second.complete;
        assert.equal(
          deliveryStateOf(yield* orchestrator.getThreadProjection(threadId), second.taskId),
          "pending",
        );
      }

      const steeredRunning = yield* turnRunning(3);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:${name}:steer`),
        threadId,
        messageId: MessageId.make(`message:${name}:steer`),
        text: "also check the logs",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "steer_active", targetRunId: wake.runId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(steeredRunning);
      const steered = harness.started[2]!;
      assert.equal(steered.runId, wake.runId);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).attempts.find(
          (attempt) => attempt.id === steered.attemptId,
        )?.reason,
        "steering_restart",
      );
      yield* finishTurn(steered);
      if (!siblingFinishesFirst) {
        yield* second.complete;
      }

      const delivered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        deliveryStateOf(delivered, second.taskId),
        "claimed",
        "the sibling's result was stranded behind the steered wake",
      );
      assert.equal(
        deliveryStateOf(delivered, first.taskId),
        "delivered",
        "the steered wake's own result never settled",
      );
      assert.deepInclude(cohortOf(delivered, origin.runId)?.delivery ?? {}, {
        generation: 2,
        taskIds: [second.taskId],
      });

      // Recovery and the queue re-offer open deliveries; none reserves a second wake.
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      yield* orchestrator.recoverDelegatedTasks;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(cohortOf(after, origin.runId)?.nextGeneration, 3);
      assert.equal(wakesCarrying(after, origin.runId, first.taskId), 1);
      assert.equal(wakesCarrying(after, origin.runId, second.taskId), 1);
    }).pipe(Effect.provide(harness.layer));
  });

it.effect("wakes the parent for a sibling that finishes after a steer restarted the wake", () =>
  Effect.scoped(steeredWakeScenario("steered-wake-sibling-after", false)),
);

it.effect(
  "reserves the next wake for a sibling that finished before a steer restarted the wake",
  () => Effect.scoped(steeredWakeScenario("steered-wake-sibling-before", true)),
);
