import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  LIVE_SILENT_RUN_REASON,
  PROVIDER_TURN_START_TIMEOUT_MESSAGE,
} from "./systemInterruptReasons.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { isStoppedThreadRefusal } from "./usageLimitRecovery.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([ProjectId.make("project:thread-stop")]);
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "anton-abyzov/specwithcode",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: {
        url: `https://github.com/anton-abyzov/specwithcode/pull/${number}`,
        source: "agent",
      },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect("Stop ends watches, holds queues, and stops the delegated tasks under the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "child task");
    // The parent owns its pull requests; a delegated task cannot watch one.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
    const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
    yield* send(childThreadId, "child follow-up", "queue_after_active");

    // The run that delegated the child ends before the run the user stops, so
    // only a Stop that covers earlier runs keeps the stopped child from waking it.
    const now = yield* DateTime.now;
    const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-parent:first-run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: firstRun.id,
      occurredAt: now,
      payload: { ...firstRun, status: "completed", completedAt: now },
    });
    yield* send(parentThreadId, "second", "start_immediately");
    const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

    const stopCommandId = CommandId.make("stop-parent");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: stopCommandId,
      threadId: parentThreadId,
      runId: secondRun.id,
      holdQueue: true,
    });

    assert.deepEqual(yield* threadState(parentThreadId), {
      runs: ["completed", "interrupted"],
      watched: [],
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
    const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
    assert.include(
      effects.map((row) => row.effect_type),
      "delegated-tasks.stop",
    );

    // What the delegated-tasks.stop effect runs once the Stop commits.
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual(yield* threadState(childThreadId), {
      runs: ["interrupted", "queued:held"],
      watched: [],
    });
    assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

    // A retried effect stops nothing twice.
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop turns off a delegated task's automatic resume after its usage limit", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-limit-parent");
    yield* createWatchingThread(parentThreadId, 7);
    yield* send(parentThreadId, "limit parent", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "limited child task");
    const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    yield* projections.apply({
      id: EventId.make("event:stop-limit-child:run-failed"),
      type: "run.updated",
      threadId: childThreadId,
      runId: childRun.id,
      occurredAt: now,
      payload: { ...childRun, status: "failed", completedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-limit-child:error"),
      type: "turn-item.updated",
      threadId: childThreadId,
      runId: childRun.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-limit-child:error"),
        type: "error",
        threadId: childThreadId,
        runId: childRun.id,
        nodeId: childRun.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed",
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        failure: {
          class: "usage_limit",
          message: "Plan limit reached.",
          code: "usageLimitExceeded",
          retryable: null,
          resetAt,
        },
      },
    });

    const stopCommandId = CommandId.make("stop-limit-parent");
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    const disarmed = (yield* orchestrator.getThreadProjection(childThreadId)).thread.limitRecovery;
    assert.deepEqual(
      { runId: disarmed?.runId, resetAt: disarmed?.resetAt, autoResume: disarmed?.autoResume },
      { runId: childRun.id, resetAt, autoResume: false },
    );
    // Settled too: provider fallback skips settled threads, so it cannot
    // continue the stopped task on another provider.
    const stopped = (yield* orchestrator.getThreadProjection(childThreadId)).thread;
    assert.equal(stopped.settledOverride, "settled");
    // A retried effect writes nothing new.
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    const retried = (yield* orchestrator.getThreadProjection(childThreadId)).thread;
    assert.equal(retried.limitRecovery?.autoResume, false);
    assert.equal(retried.settledOverride, "settled");
    assert.equal(DateTime.formatIso(retried.updatedAt), DateTime.formatIso(stopped.updatedAt));
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    // A queued message the user cancelled does not count as the latest run.
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    // Stop reached the run, but its provider has not stopped it yet.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    // A slow watch_pull_request call can land after the stopped run ended.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    // The user can still stop and restart a watch by hand.
    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // A server restart cut the run before its provider started; its continuation is pending.
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      // A later turn runs ahead of the held queue, then recovery cancels it.
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "interrupted", "cancelled"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    // A task whose thread is gone, listed before the one that can stop.
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop on a finished thread refuses a late agent watch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-finished");
    yield* createWatchingThread(threadId, 9);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-finished:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-finished"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 10))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["completed"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // The turn is running, but its provider session is gone, so the interrupt fails.
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

type ShellThread = Parameters<typeof limitRecoveryCommand>[0];

/** A thread its usage limit stopped, reset in an hour, with recovery's policy arm. */
const limitStoppedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:stop-own-limit:${name}`);
    yield* createWatchingThread(threadId, 20);
    yield* send(threadId, "limited work", "start_immediately");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    yield* projections.apply({
      id: EventId.make(`event:stop-own-limit:${name}:run-failed`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "failed", startedAt: now, completedAt: now },
    });
    yield* projections.apply({
      id: EventId.make(`event:stop-own-limit:${name}:error`),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:stop-own-limit:${name}:error`),
        type: "error",
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed",
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        failure: {
          class: "usage_limit",
          message: "Plan limit reached.",
          code: "usageLimitExceeded",
          retryable: null,
          resetAt,
        },
      },
    });
    const shell: Effect.Effect<ShellThread, Orchestrator.OrchestratorV2Error> = Effect.map(
      orchestrator.getShellSnapshot(),
      (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)!,
    );
    // Armed for the reset, the way the recovery worker's policy arm does it.
    const arm = limitRecoveryCommand(yield* shell, true, DateTime.toEpochMillis(now));
    assert.equal(arm?.type, "thread.metadata.update");
    yield* orchestrator.dispatch(arm!);
    assert.isTrue((yield* shell).limitRecovery?.autoResume);
    return { threadId, run, resetAt, shell };
  });

/** What the recovery worker sends now, or null when it sends nothing. */
const resumeNow = (shell: Effect.Effect<ShellThread, Orchestrator.OrchestratorV2Error>) =>
  Effect.gen(function* () {
    const command = limitRecoveryCommand(
      yield* shell,
      true,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
    if (command !== null) assert.equal(command.type, "message.dispatch");
    return command;
  });

const runCount = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.length;
  });

it.effect("a person's Stop turns off the thread's own usage-limit resume", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId, run, resetAt, shell } = yield* limitStoppedThread("direct");

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:direct"),
      threadId,
    });
    const recovery = (yield* shell).limitRecovery;
    assert.deepEqual(
      {
        runId: recovery?.runId,
        resetAt: recovery?.resetAt,
        autoResume: recovery?.autoResume,
        explicitArm: recovery?.explicitArm,
      },
      { runId: run.id, resetAt, autoResume: false, explicitArm: false },
    );
    // The Stop still ends the thread's watches.
    assert.deepEqual((yield* threadState(threadId)).watched, []);

    // At the reset the worker has nothing to send, and no policy arms it again.
    yield* TestClock.adjust("2 hours");
    assert.isNull(yield* resumeNow(shell));
    assert.equal(yield* runCount(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a limit resume that reaches the thread after a person's Stop starts nothing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId, run, resetAt, shell } = yield* limitStoppedThread("raced");
    yield* TestClock.adjust("2 hours");
    // The worker read the thread before the Stop, so it still sends.
    const raced = yield* resumeNow(shell);
    assert.isNotNull(raced);

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:raced"),
      threadId,
    });
    yield* orchestrator.dispatch(raced!);
    assert.equal(yield* runCount(threadId), 1);

    // A policy arm that lands after the Stop cannot resume the stopped run either.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("stop-own-limit:raced:late-policy-arm"),
      threadId,
      limitRecoveryPolicyArm: true,
      limitRecovery: { runId: run.id, resetAt, autoResume: true },
    });
    const late = yield* resumeNow(shell);
    assert.isNotNull(late);
    yield* orchestrator.dispatch(late!);
    assert.equal(yield* runCount(threadId), 1);

    // The person arming it again after their Stop decides that themselves.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("stop-own-limit:raced:person-arm"),
      threadId,
      limitRecovery: { runId: run.id, resetAt, autoResume: true },
    });
    const chosen = yield* resumeNow(shell);
    assert.isNotNull(chosen);
    yield* orchestrator.dispatch(chosen!);
    assert.equal(yield* runCount(threadId), 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a person's message after their Stop on a limited thread still starts a turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId } = yield* limitStoppedThread("message");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:message"),
      threadId,
    });
    yield* TestClock.adjust("2 hours");
    yield* send(threadId, "keep going", "start_immediately");
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    assert.lengthOf(runs, 2);
    assert.equal(runs[1]?.userMessageId, MessageId.make(`message:${threadId}:keep going`));
    assert.notEqual(runs[1]?.status, "queued");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a service update's Stop leaves a limited thread's automatic resume armed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId, shell } = yield* limitStoppedThread("update");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:update"),
      threadId,
      cause: "service_update",
    });
    assert.isTrue((yield* shell).limitRecovery?.autoResume);

    yield* TestClock.adjust("2 hours");
    const resume = yield* resumeNow(shell);
    assert.isNotNull(resume);
    yield* orchestrator.dispatch(resume!);
    assert.equal(yield* runCount(threadId), 2);
  }).pipe(Effect.provide(layerTest)),
);

type FallbackPrefix =
  | "limit-reset"
  | "limit-credits"
  | "limit-api"
  | "limit-billing"
  | "limit-fallback"
  | "provider-fallback"
  | "limit-return"
  | "provider-retry";

/**
 * Provider fallback's continuation of the stop: on the same provider, or a
 * switch to another one. A move off a provider that could not open
 * (`provider-fallback:`) names the run only in its id.
 */
const fallbackContinuation = (
  prefix: FallbackPrefix,
  threadId: ThreadId,
  runId: string,
  attempt = "",
) => {
  const identity = `${prefix}:${threadId}:${runId}${attempt}`;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId,
    ...(prefix === "provider-fallback" ? {} : { manualContinuationOfRunId: RunId.make(runId) }),
    modelSelection,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "user" as const,
    creationSource: "server" as const,
  };
};

it.effect("provider fallback cannot reopen a limited thread after a person's Stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const prefixes = [
      "limit-reset",
      "limit-api",
      "limit-billing",
      "limit-fallback",
      "provider-fallback",
      "limit-return",
      "limit-credits",
      "provider-retry",
    ] as const;
    const reopened: Array<string> = [];
    for (const prefix of prefixes) {
      const stopped = yield* limitStoppedThread(`fallback-${prefix}`);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-own-limit:fallback-${prefix}`),
        threadId: stopped.threadId,
      });
      const sent = yield* Effect.exit(
        orchestrator.dispatch(fallbackContinuation(prefix, stopped.threadId, stopped.run.id)),
      );
      if (Exit.isSuccess(sent) || (yield* runCount(stopped.threadId)) !== 1) reopened.push(prefix);
    }
    assert.deepEqual(reopened, []);

    // The person arming the resume again after their Stop lets fallback continue too.
    const { threadId, run, resetAt } = yield* limitStoppedThread("fallback");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:fallback"),
      threadId,
    });
    const before = yield* Effect.exit(
      orchestrator.dispatch(fallbackContinuation("limit-reset", threadId, run.id)),
    );
    assert.isTrue(Exit.isFailure(before));
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("stop-own-limit:fallback:person-arm"),
      threadId,
      limitRecovery: { runId: run.id, resetAt, autoResume: true },
    });
    yield* orchestrator.dispatch(fallbackContinuation("limit-reset", threadId, run.id, ":again"));
    assert.equal(yield* runCount(threadId), 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("provider fallback still continues a limited thread after a service update's Stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const held: Array<string> = [];
    for (const prefix of [
      "limit-billing",
      "limit-credits",
      "limit-fallback",
      "provider-fallback",
      "provider-retry",
    ] as const) {
      const { threadId, run } = yield* limitStoppedThread(`fallback-update-${prefix}`);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-own-limit:fallback-update-${prefix}`),
        threadId,
        cause: "service_update",
      });
      const sent = yield* Effect.exit(
        orchestrator.dispatch(fallbackContinuation(prefix, threadId, run.id)),
      );
      if (Exit.isFailure(sent) || (yield* runCount(threadId)) !== 2) held.push(prefix);
    }
    assert.deepEqual(held, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an arm the person turned off before their Stop lets nothing continue", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // Ticked, then unticked "Auto-continue", then Stop (the review's probe).
    const ticked = yield* limitStoppedThread("unticked");
    for (const autoResume of [true, false]) {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`stop-own-limit:unticked:${autoResume}`),
        threadId: ticked.threadId,
        limitRecovery: { runId: ticked.run.id, resetAt: ticked.resetAt, autoResume },
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:unticked"),
      threadId: ticked.threadId,
    });
    assert.equal((yield* ticked.shell).limitRecovery?.explicitArm, false);
    const refused = yield* Effect.exit(
      threads.dispatch(fallbackContinuation("limit-fallback", ticked.threadId, ticked.run.id)),
    );
    assert.isTrue(Exit.isFailure(refused));
    if (Exit.isFailure(refused)) {
      assert.isTrue(isStoppedThreadRefusal(Cause.squash(refused.cause)));
    }
    assert.equal(yield* runCount(ticked.threadId), 1);

    // A recovery stored before an untick cleared the mark: Stop clears it too.
    const stale = yield* limitStoppedThread("stale-arm");
    const thread = (yield* orchestrator.getThreadProjection(stale.threadId)).thread;
    yield* projections.apply({
      id: EventId.make("event:stop-own-limit:stale-arm"),
      type: "thread.metadata-updated",
      threadId: stale.threadId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...thread,
        limitRecovery: { ...thread.limitRecovery!, autoResume: false, explicitArm: true },
      },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:stale-arm"),
      threadId: stale.threadId,
    });
    assert.equal((yield* stale.shell).limitRecovery?.explicitArm, false);
    const reset = yield* Effect.exit(
      orchestrator.dispatch(fallbackContinuation("limit-reset", stale.threadId, stale.run.id)),
    );
    assert.isTrue(Exit.isFailure(reset));
    assert.equal(yield* runCount(stale.threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovery's resume of a derived stop, as a manual continuation, waits after Stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId, run, resetAt } = yield* limitStoppedThread("manual-resume");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:manual-resume"),
      threadId,
    });
    // A policy arm after the Stop, then its resume past the reset.
    const armId = CommandId.make("stop-own-limit:manual-resume:policy-arm");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: armId,
      threadId,
      limitRecoveryPolicyArm: true,
      limitRecovery: { runId: run.id, resetAt, autoResume: true },
    });
    yield* TestClock.adjust("2 hours");
    const resume = (name: string) => {
      const id = `limit-resume:${threadId}:${run.id}:${name}:${armId}`;
      return {
        type: "message.dispatch" as const,
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        threadId,
        manualContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "server" as const,
      };
    };
    yield* Effect.exit(orchestrator.dispatch(resume("held")));
    assert.equal(yield* runCount(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

/** An interrupt request an agent, an update or the watchdog wrote on the limited run. */
const markInterrupted = (
  threadId: ThreadId,
  run: { readonly id: RunId; readonly rootNodeId: NodeId | null },
  cause: "agent" | "service_update" | undefined,
  message = "Interrupt requested",
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:stop-own-limit:${threadId}:marker`),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:run:${run.id}:signal:interrupt-request`),
        type: "run_interrupt_request",
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 3,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        message,
        ...(cause === undefined ? {} : { cause }),
      },
    });
  });

it.effect("a person's Stop after an agent's or update's interrupt still holds fallback", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const reopened: Array<string> = [];
    for (const cause of ["agent", "service_update"] as const) {
      const { threadId, run } = yield* limitStoppedThread(`marked-${cause}`);
      yield* markInterrupted(threadId, run, cause);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-own-limit:marked-${cause}`),
        threadId,
      });
      const sent = yield* Effect.exit(
        orchestrator.dispatch(fallbackContinuation("limit-fallback", threadId, run.id)),
      );
      if (Exit.isSuccess(sent) || (yield* runCount(threadId)) !== 1) reopened.push(cause);
    }
    assert.deepEqual(reopened, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an agent's or the watchdog's interrupt alone does not hold fallback", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const held: Array<string> = [];
    for (const [name, cause, message] of [
      ["agent", "agent", undefined],
      ["watchdog", undefined, LIVE_SILENT_RUN_REASON],
      ["start-timeout", undefined, PROVIDER_TURN_START_TIMEOUT_MESSAGE],
    ] as const) {
      const { threadId, run } = yield* limitStoppedThread(`unstopped-${name}`);
      yield* markInterrupted(threadId, run, cause, message);
      const sent = yield* Effect.exit(
        orchestrator.dispatch(fallbackContinuation("limit-fallback", threadId, run.id)),
      );
      if (Exit.isFailure(sent) || (yield* runCount(threadId)) !== 2) held.push(name);
    }
    assert.deepEqual(held, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a person's Stop keeps their snooze until the reset", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { threadId, run, resetAt, shell } = yield* limitStoppedThread("snoozed");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("stop-own-limit:snoozed:snooze"),
      threadId,
      limitRecovery: { runId: run.id, resetAt, autoResume: true, snooze: true },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-own-limit:snoozed"),
      threadId,
    });
    const recovery = (yield* shell).limitRecovery;
    assert.deepEqual(
      { autoResume: recovery?.autoResume, snooze: recovery?.snooze },
      { autoResume: false, snooze: true },
    );
    const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
    assert.equal(
      thread.snoozedUntil == null ? null : DateTime.formatIso(thread.snoozedUntil),
      resetAt,
    );
  }).pipe(Effect.provide(layerTest)),
);
