import * as StudioCapacity from "../studio/Capacity.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerPlatformTest = Layer.mergeAll(
  Layer.mock(StudioCapacity.Capacity)({ assertNativeStart: () => Effect.void }),
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-orchestration-v2-held-queue-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by held queue tests"),
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
const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
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
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(layerPlatformTest),
);

const seedThreadProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Thread fixture",
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    }),
  );

type Sender = "user" | "agent" | "scheduled";

it.layer(layerTest)("queue and continuation recovery", (it) => {
  // A thread fed by agent messages, with helpers to end its runs as a provider would.
  const queueTestThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      yield* seedThreadProject(ProjectId.make(`${threadId}:project`));
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Dispatcher",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      // A started agent message would release the hold itself; a scheduled one does not.
      const send = (key: string, sender: Sender, start: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: sender === "user" ? "user" : "agent",
          creationSource: sender === "user" ? "web" : "server",
          ...(sender === "scheduled"
            ? { scheduledTaskId: ScheduledTaskId.make(`${threadId}:task:${key}`) }
            : {}),
          commandId: CommandId.make(`${threadId}:message:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${key}`),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find(
            (candidate) => candidate.userMessageId === MessageId.make(`${threadId}:message:${key}`),
          );
          assert.isDefined(run);
          return run;
        });
      const startedRunIds = yield* Queue.unbounded<RunId>();
      // Run updates in commit order; the run-update listener handles them in this order too.
      const runUpdates: Array<OrchestrationV2Run> = [];
      yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.runForEach((stored) => {
            if (stored.event.type !== "run.updated") return Effect.void;
            runUpdates.push(stored.event.payload);
            return stored.event.payload.status === "starting"
              ? Queue.offer(startedRunIds, stored.event.payload.id)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      const releasedAfter = (key: string, completedKey: string) =>
        Effect.gen(function* () {
          const [run, completed] = [yield* runFor(key), yield* runFor(completedKey)];
          const released = runUpdates.findIndex(
            (update) => update.id === run.id && update.queueHeld === false,
          );
          const completion = runUpdates.findIndex(
            (update) => update.id === completed.id && update.status === "completed",
          );
          assert.isAbove(released, completion, `${key} was released before ${completedKey} ended`);
        });
      const end = (
        key: string,
        status: "completed" | "failed",
        revision = "",
        patch: Partial<OrchestrationV2Run> = {},
      ) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          assert.isNotNull(run.rootNodeId);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(status === "failed"
                ? [
                    {
                      id: EventId.make(`${threadId}:${key}:error`),
                      type: "turn-item.updated" as const,
                      threadId,
                      runId: run.id,
                      nodeId: run.rootNodeId,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        id: TurnItemId.make(`${threadId}:${key}:error`),
                        type: "error" as const,
                        threadId,
                        runId: run.id,
                        nodeId: run.rootNodeId,
                        providerThreadId: run.providerThreadId,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 2,
                        status: "failed" as const,
                        title: "Provider failure",
                        startedAt: now,
                        completedAt: now,
                        updatedAt: now,
                        failure: {
                          class: "provider_error" as const,
                          message: "Provider failed.",
                          code: "provider_failed",
                          retryable: null,
                        },
                      },
                    },
                  ]
                : []),
              {
                id: EventId.make(`${threadId}:${key}:${status}${revision}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, ...patch, status, startedAt: now, completedAt: now },
              },
            ],
          });
        });
      // The run-update listener places failure holds after the terminal event commits.
      const awaitHeld = (key: string) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          yield* eventSink.stream({ threadId, afterSequence: 0, eventType: "run.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === run.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.runHead,
          );
        });
      return { send, runFor, end, startedRunIds, releasedAfter, awaitHeld };
    });

  it.effect("releases held agent messages once a later run completes, not the user's", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("held-queue-agent-messages");
      const { send, runFor, end, releasedAfter, awaitHeld } = yield* queueTestThread(threadId);
      yield* send("earlier", "agent", true);
      yield* end("earlier", "completed");
      yield* send("active", "agent", true);
      yield* send("issue", "agent", false);
      yield* send("user", "user", false);
      yield* end("active", "failed");
      yield* awaitHeld("issue");
      assert.isTrue((yield* runFor("issue")).queueHeld);
      // Delivery bookkeeping rewrites an older completed run; the thread has not moved on.
      yield* end("earlier", "completed", ":bookkeeping");
      // A scheduled tick finds the thread idle and starts past the held queue.
      yield* send("tick", "scheduled", true);
      assert.equal((yield* runFor("tick")).status, "starting");
      assert.isTrue((yield* runFor("issue")).queueHeld);
      yield* end("tick", "completed");
      yield* releasedAfter("issue", "tick");
      const user = yield* runFor("user");
      assert.equal(user.status, "queued");
      assert.isTrue(user.queueHeld);
      // The user's hold still keeps the released message from starting.
      assert.equal((yield* runFor("issue")).status, "queued");

      // A run that finishes despite a stop request does not release what the stop held.
      yield* send("stopped", "scheduled", true);
      yield* send("after-stop", "scheduled", false);
      assert.isTrue((yield* runFor("after-stop")).queueHeld);
      const stopped = yield* runFor("stopped");
      assert.isNotNull(stopped.rootNodeId);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:stopped:interrupt-request`),
            type: "turn-item.updated",
            threadId,
            runId: stopped.id,
            nodeId: stopped.rootNodeId,
            providerInstanceId: stopped.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:stopped:interrupt-request`),
              type: "run_interrupt_request",
              threadId,
              runId: stopped.id,
              nodeId: stopped.rootNodeId,
              providerThreadId: stopped.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Interrupt requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: "Stopped by user",
            },
          },
        ],
      });
      yield* end("stopped", "completed");
      // The next completed run releases it, which also shows the listener handled the stopped one.
      yield* send("probe", "scheduled", true);
      assert.equal((yield* runFor("probe")).status, "starting");
      assert.isTrue((yield* runFor("after-stop")).queueHeld);
      yield* end("probe", "completed");
      yield* releasedAfter("after-stop", "probe");
    }),
  );

  it.effect("keeps held agent messages while the thread's worktree setup is unresolved", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const dispatcherId = ThreadId.make("held-queue-worktree");
      const dispatcher = yield* queueTestThread(dispatcherId);
      const witness = yield* queueTestThread(ThreadId.make("held-queue-witness"));
      yield* dispatcher.send("setup", "agent", true);
      yield* dispatcher.send("issue", "agent", false);
      yield* dispatcher.end("setup", "failed", "", {
        workspacePreparation: { type: "worktree", baseRef: "main" },
      });
      yield* dispatcher.awaitHeld("issue");
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
      yield* dispatcher.send("tick", "scheduled", true);
      assert.equal((yield* dispatcher.runFor("tick")).status, "starting");
      yield* witness.send("active", "agent", true);
      yield* witness.send("queued", "agent", false);
      // The failed setup never produced the thread's worktree.
      const { thread } = yield* orchestrator.getThreadProjection(dispatcherId);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${dispatcherId}:worktree-missing`),
            type: "thread.metadata-updated",
            threadId: dispatcherId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, worktreePath: null },
          },
        ],
      });
      yield* dispatcher.end("tick", "completed");
      // One listener handles every thread's completions in order, so the witness starting
      // means the tick's completion was handled too.
      yield* witness.end("active", "completed");
      let started = yield* Queue.take(witness.startedRunIds);
      while (started !== (yield* witness.runFor("queued")).id) {
        started = yield* Queue.take(witness.startedRunIds);
      }
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
    }),
  );

  it.effect.each([false, true])(
    "restarts a continuation that failed before its prompt, unless stopped (%s)",
    (stopped) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`continuation-start-retry-${stopped}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* seedThreadProject(ProjectId.make(`${threadId}:project`));
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Continuation start retry",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
            runs.find((candidate) => candidate.userMessageId === messageId(key)),
          );
        const write = (
          key: string,
          payload: OrchestrationV2Run,
          extra: Parameters<typeof eventSink.write>[0]["events"] = [],
        ) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                ...extra,
                {
                  id: EventId.make(`${threadId}:${key}`),
                  type: "run.updated",
                  threadId,
                  runId: payload.id,
                  providerInstanceId: payload.providerInstanceId,
                  occurredAt: now,
                  payload: { ...payload, startedAt: now, completedAt: now },
                },
              ],
            });
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:cut`),
          threadId,
          messageId: messageId("cut"),
          text: "Work that the restart cut",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const cut = (yield* runFor("cut"))!;
        yield* write("cut:cancelled", { ...cut, status: "cancelled" });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`${threadId}:message:continuation`),
          threadId,
          messageId: messageId("continuation"),
          text: "Continue where you left off.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: cut.id,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:queued`),
          threadId,
          messageId: messageId("queued"),
          text: "Queued behind the continuation",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        const continuation = (yield* runFor("continuation"))!;
        assert.equal(continuation.restartContinuationOfRunId, cut.id);
        assert.isNotNull(continuation.rootNodeId);
        const queued = (yield* runFor("queued"))!;
        // The failure holds the queue after the reactor scheduled any retry.
        const held = yield* eventSink
          .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queued.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const now = yield* DateTime.now;
        yield* write("continuation:failed", { ...continuation, status: "failed" }, [
          {
            id: EventId.make(`${threadId}:continuation:error`),
            type: "turn-item.updated",
            threadId,
            runId: continuation.id,
            nodeId: continuation.rootNodeId,
            providerInstanceId: continuation.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:continuation:error`),
              type: "error",
              threadId,
              runId: continuation.id,
              nodeId: continuation.rootNodeId,
              providerThreadId: continuation.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "The provider timed out while registering its MCP tools.",
                code: null,
                retryable: null,
              },
            },
          },
        ]);
        yield* Fiber.join(held);
        const retriesOf = Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
          runs.filter((run) => run.restartContinuationOfRunId === continuation.id),
        );
        yield* worker.drain();
        assert.deepEqual(yield* retriesOf, [], "the retry waits out its backoff");
        if (stopped) {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
        }
        yield* TestClock.adjust("61 seconds");
        yield* worker.drain();
        assert.lengthOf(yield* retriesOf, stopped ? 0 : 1);
      }),
  );
});
