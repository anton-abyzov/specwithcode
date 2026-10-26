import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  type RunId,
  SERVICE_UPDATE_STOP_REASON,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { prepareInputFromFlags } from "../cli/servicePrepareUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { resumeAfterHoldReleases } from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Cleanup from "../serviceUpdate/ServiceUpdateCleanup.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as Preparation from "../serviceUpdate/ServiceUpdatePreparation.ts";
import * as ClosedQuestions from "../serviceUpdate/ServiceUpdateClosedQuestions.ts";
import * as ReopenQuestions from "../serviceUpdate/ServiceUpdateReopenQuestions.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as StudioCapacity from "../studio/Capacity.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { continueRestartedRun, resumeQueueAfterRestart } from "./RestartContinuation.ts";
import { holdForRestart } from "./RestartQueueHold.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// A service update interrupts each running turn, then either restarts the
// service or gives up and releases its hold. Either way the interrupted turn
// must continue once, through the real projection reads, and a user's Stop
// must never be continued.

const layerPlatformTest = Layer.mergeAll(
  Layer.mock(StudioCapacity.Capacity)({ assertNativeStart: () => Effect.void }),
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-update-continuation-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by lifecycle tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerBase = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
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
const layerTest = Cleanup.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provideMerge(layerBase),
);

/** A thread whose first turn is running on a live provider session, then is interrupted. */
const interruptedThread = (name: string, cause: "service_update" | "user") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* startedThread(name);
    const initial = yield* orchestrator.getThreadProjection(threadId);
    const runId = yield* interruptRun(name, threadId, initial.runs[0]!.id, cause);
    return { threadId, runId };
  });

/** A thread whose first turn has been sent and not yet settled. */
const startedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const projectId = ProjectId.make(`project:${name}`);
    const createdAt = "2026-10-09T00:00:00.000Z";
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: name,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:create`),
      threadId,
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:first`),
      threadId,
      messageId: MessageId.make(`${name}:first`),
      text: "Start work.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    return threadId;
  });

/** Queues a message the user sent behind the thread's active turn. */
const queueMessage = (name: string, threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:queue:${text}`),
      threadId,
      messageId: MessageId.make(`${name}:queue:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find(
      (candidate) => candidate.userMessageId === `${name}:queue:${text}`,
    );
    assert.equal(run?.status, "queued");
    return run!.id;
  });

/** Marks a pending run as running on a provider turn. */
const markRunning = (name: string, threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const initial = yield* orchestrator.getThreadProjection(threadId);
    const run = initial.runs.find((candidate) => candidate.id === runId)!;
    const providerThread = initial.providerThreads[0]!;
    const now = yield* DateTime.now;
    const providerTurn = {
      id: ProviderTurnId.make(`${name}:turn`),
      providerThreadId: providerThread.id,
      nodeId: run.rootNodeId!,
      runAttemptId: run.activeAttemptId,
      nativeTurnRef: null,
      ordinal: run.ordinal,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    yield* eventSink.write({
      commandId: CommandId.make(`${name}:running`),
      events: [
        {
          id: EventId.make(`${name}:run-running`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          id: EventId.make(`${name}:turn-running`),
          type: "provider-turn.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: providerTurn,
        },
      ],
    });
    return providerTurn;
  });

/** Marks a pending run as running on a provider turn, then interrupts it with `cause`. */
const interruptRun = (
  name: string,
  threadId: ThreadId,
  runId: RunId,
  cause: "service_update" | "user",
  holdQueue?: true,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerTurn = yield* markRunning(name, threadId, runId);
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`${name}:interrupt`),
      threadId,
      runId: run.id,
      reason: cause === "service_update" ? "SpecWithCode is updating" : "Stopped by the user",
      cause,
      ...(holdQueue === undefined ? {} : { holdQueue }),
    });
    const interrupted = yield* orchestrator.getThreadProjection(threadId);
    const current = interrupted.runs.find((candidate) => candidate.id === run.id)!;
    if (current.status !== "interrupted") {
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:interrupted`),
        events: [
          {
            id: EventId.make(`${name}:run-interrupted`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...current, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make(`${name}:turn-interrupted`),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "interrupted", completedAt: now },
          },
        ],
      });
    }
    return run.id;
  });

// The recovery query compares against SQLite's wall-clock 'now' and only looks
// at runs from the last day, so tests run a minute before the real present.
// (TestClock replaces Clock here, so the wall clock is read from performance.)
const recentTime = Math.floor(performance.timeOrigin + performance.now()) - 60_000;

/**
 * An update's drain on a running thread: it cancels the queued message, then
 * interrupts the turn. With `personStop`, the person presses Stop after it.
 */
const drainedThread = (name: string, personStop: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* startedThread(name);
    const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
    const queuedId = yield* queueMessage(name, threadId, "Behind the turn.");
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`${name}:cancel`),
      threadId,
      runId: queuedId,
      cause: "service_update",
    });
    yield* interruptRun(name, threadId, first, "service_update");
    if (personStop)
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${name}:person-stop`),
        threadId,
      });
    return { threadId, queuedId };
  });

/** The requeue effects recovery wrote for a thread. */
const requeueEffects = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_id LIKE 'effect:update-requeue:%'
    `;
    return rows.map((row) => row.effect_id);
  });

const continueAll = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  yield* recovery.resumeAfterUpdate;
  return outbox;
});

it.layer(layerTest)("update continuation through real projections", (it) => {
  it.effect("continues a turn an update interrupted, once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, runId } = yield* interruptedThread("update-continue", "service_update");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        before.runs.map((run) => run.status),
        ["interrupted"],
      );
      const outbox = yield* continueAll;
      const effects = yield* outbox.listByCommandId(
        CommandId.make(`command:update-continue:${runId}`),
      );
      assert.deepEqual(
        effects.map((effect) => effect.request),
        [{ type: "provider-runtime.continue", sourceRunId: runId }],
      );
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.messages
          .filter((message) => message.id === `message:update-continuation:${runId}`)
          .map((message) => message.text),
        ["Continue where you left off."],
      );
      assert.lengthOf(after.runs, 2);
      assert.equal(after.runs[1]!.restartContinuationOfRunId, runId);
    }),
  );

  // The release thread was interrupted by the 1.0.58 install (ordinal 21) and
  // again by the 1.0.60 install (ordinal 23). Each install must continue it
  // once, or it never reports the install to the workers waiting on it.
  it.effect("continues the same thread again after a second update", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, runId } = yield* interruptedThread("release-thread", "service_update");
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const resumed = yield* orchestrator.getThreadProjection(threadId);
      const continuation = resumed.runs.find((run) => run.restartContinuationOfRunId === runId)!;
      yield* interruptRun("release-thread-2", threadId, continuation.id, "service_update");
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: continuation.id });
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => [run.status, run.restartContinuationOfRunId ?? null]),
        [
          ["interrupted", null],
          ["interrupted", runId],
          [after.runs[2]!.status, continuation.id],
        ],
      );
      assert.notEqual(after.runs[2]!.status, "interrupted");
    }),
  );

  // October 23, 2026: a delegated task's wake-up started after the drain's last
  // stop round, and the drain's release of busy sessions failed it ("The
  // provider event stream closed unexpectedly"), so nothing continued it. The
  // release now ends the stream; the turn is left running, the drain marks it
  // stopped for the update and the restart continues it. A Stop the user asked
  // for on a turn the provider never ended stays theirs.
  it.effect("continues a turn the update's session release cut, never a user's Stop", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const cleanup = yield* Cleanup.ServiceUpdateCleanup;
      const cutThread = yield* startedThread("release-cut");
      const cutRun = (yield* orchestrator.getThreadProjection(cutThread)).runs[0]!.id;
      yield* markRunning("release-cut", cutThread, cutRun);
      const stoppedThread = yield* startedThread("release-user-stop");
      const stoppedRun = (yield* orchestrator.getThreadProjection(stoppedThread)).runs[0]!.id;
      yield* markRunning("release-user-stop", stoppedThread, stoppedRun);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("release-user-stop:interrupt"),
        threadId: stoppedThread,
        runId: stoppedRun,
        reason: "Stopped by the user",
        cause: "user",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(stoppedThread)).runs[0]!.status,
        "running",
      );
      // The drain's stop round interrupts every running turn, the user's too.
      for (const [threadId, runId] of [
        [cutThread, cutRun],
        [stoppedThread, stoppedRun],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`release-round:${runId}`),
          threadId,
          runId,
          reason: "SpecWithCode is updating",
          cause: "service_update",
        });
      }

      yield* cleanup.finalizeStuckRuns({
        nonce: "release-cut",
        reason: "SpecWithCode is updating",
      });
      const causes = (projection: {
        readonly turnItems: ReadonlyArray<{ readonly type: string; readonly cause?: unknown }>;
      }) =>
        projection.turnItems
          .filter((item) => item.type === "run_interrupt_request")
          .map((item) => item.cause);
      const cut = yield* orchestrator.getThreadProjection(cutThread);
      assert.deepEqual(
        cut.runs.map((run) => run.status),
        ["interrupted"],
      );
      assert.deepEqual(causes(cut), ["service_update"]);
      const stopped = yield* orchestrator.getThreadProjection(stoppedThread);
      assert.deepEqual(
        stopped.runs.map((run) => run.status),
        ["interrupted"],
      );
      assert.deepEqual(causes(stopped), ["user"]);

      yield* continueAll;
      yield* continueRestartedRun({ threadId: cutThread, sourceRunId: cutRun });
      yield* continueRestartedRun({ threadId: stoppedThread, sourceRunId: stoppedRun });
      const continued = yield* orchestrator.getThreadProjection(cutThread);
      assert.lengthOf(continued.runs, 2);
      assert.equal(continued.runs[1]!.restartContinuationOfRunId, cutRun);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(stoppedThread)).runs.map((run) => run.status),
        ["interrupted"],
      );
    }),
  );

  // A hold that ends while the service keeps running (Cancel update, its time
  // limit, an agent pass that installed nothing) has no restart behind it, so
  // startup never continued the turns its drain stopped.
  it.effect("continues a turn an update stopped when its hold ends without a restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const hold = yield* ServiceUpdateHold.makeWithOptions({
        agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
      }).pipe(Effect.provide(NodeServices.layer));
      yield* resumeAfterHoldReleases({
        releaseCount: hold.releaseCount,
        updateUnderway: hold.isHeld,
        installRequestOpen: Effect.succeed(false),
        exclusive: (effect) => effect,
        resumeAfterUpdate: recovery.resumeAfterUpdate,
        pollMs: 1_000,
      }).pipe(Effect.forkScoped);
      yield* hold.acquire({ reason: "install" });
      const stopped = yield* interruptedThread("hold-cancel", "service_update");
      const userStop = yield* interruptedThread("hold-cancel-user", "user");
      const effectOf = (runId: RunId) => outbox.get(`effect:restart-continuation:${runId}`);
      yield* TestClock.adjust("1 second");
      yield* TestClock.withLive(Effect.sleep("100 millis"));
      // Still held: nothing continues yet.
      assert.isTrue(Option.isNone(yield* effectOf(stopped.runId)));
      yield* hold.release("cancelled");
      yield* TestClock.adjust("1 second");
      // The forked pass reads SQLite; wait in real time for it to write.
      let written = yield* effectOf(stopped.runId);
      for (let look = 0; Option.isNone(written) && look < 100; look += 1) {
        yield* TestClock.withLive(Effect.sleep("10 millis"));
        written = yield* effectOf(stopped.runId);
      }
      assert.isTrue(Option.isSome(written));
      assert.equal(Option.getOrThrow(written).status, "pending");
      assert.deepEqual(Option.getOrThrow(written).request, {
        type: "provider-runtime.continue",
        sourceRunId: stopped.runId,
      });
      assert.isTrue(Option.isNone(yield* effectOf(userStop.runId)));
      yield* continueRestartedRun({ threadId: stopped.threadId, sourceRunId: stopped.runId });
      const after = yield* orchestrator.getThreadProjection(stopped.threadId);
      assert.lengthOf(
        after.messages.filter(
          (message) => message.id === `message:update-continuation:${stopped.runId}`,
        ),
        1,
      );
      assert.equal(after.runs[1]!.restartContinuationOfRunId, stopped.runId);
    }).pipe(Effect.scoped),
  );

  // The next update's drain cancels a continuation a hold release wrote before
  // it ran. The turn is still stopped for an update, so the next pass (or the
  // restart) continues it; a continuation cancelled by anyone else stays.
  it.effect("continues again a turn whose continuation an update's drain cancelled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drained = yield* interruptedThread("drain-cancelled", "service_update");
      const other = yield* interruptedThread("other-cancelled", "service_update");
      yield* recovery.resumeAfterUpdate;
      yield* outbox.cancelUnsettled({
        threadId: drained.threadId,
        effectTypes: ["provider-runtime.continue"],
        reason: SERVICE_UPDATE_STOP_REASON,
      });
      yield* outbox.cancelUnsettled({
        threadId: other.threadId,
        effectTypes: ["provider-runtime.continue"],
        reason: "Stopped by the user",
      });
      yield* recovery.resumeAfterUpdate;
      const status = (runId: RunId) =>
        Effect.map(outbox.get(`effect:restart-continuation:${runId}`), (effect) =>
          Option.map(effect, (row) => [row.status, row.attemptCount] as const),
        );
      assert.deepEqual(yield* status(drained.runId), Option.some(["pending", 0] as const));
      assert.deepEqual(yield* status(other.runId), Option.some(["cancelled", 0] as const));
    }),
  );

  it.effect("never continues a turn the user stopped", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, runId } = yield* interruptedThread("user-stop", "user");
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["interrupted"],
      );
    }),
  );
  // A forced update closed the question this turn asked. After the update the
  // thread asks it again on that turn, as a card the person answers by message,
  // and a second pass (a crash before the record was marked) repeats nothing.
  it.effect("asks a question an update closed again on its turn, once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, runId } = yield* interruptedThread("reopen-card", "service_update");
      const entry: ClosedQuestions.ClosedQuestion = {
        requestId: "ask-user:closed",
        threadId,
        threadTitle: "reopen-card",
        runId,
        kind: "user_input",
        text: "Which database should I use?",
        questions: [
          {
            id: "q1",
            header: "Database",
            question: "Which database should I use?",
            options: [{ label: "Postgres", description: "The usual one." }],
            allowCustomAnswer: true,
          },
        ],
        askedAt: null,
        closedAt: "2026-10-21T10:00:00.000Z",
        reopenedAt: null,
      };
      const reopenWith = Effect.gen(function* () {
        // Unmarked every time: as if the service stopped before it marked the entry.
        const pending = yield* Ref.make<ReadonlyArray<ClosedQuestions.ClosedQuestion>>([entry]);
        const store = ClosedQuestions.ServiceUpdateClosedQuestions.of({
          bootId: "after-the-restart",
          record: () => Effect.succeed(true),
          pending: Ref.get(pending),
          forRun: () => Effect.succeed([entry]),
          markReopened: () => Ref.set(pending, []).pipe(Effect.as(true)),
          draining: (effect) => effect,
          isDraining: Effect.succeed(false),
          reopening: (effect) => effect,
        });
        const reopener = yield* ReopenQuestions.makeReopener.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ClosedQuestions.ServiceUpdateClosedQuestions, store),
              IdAllocator.layer,
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
            ),
          ),
        );
        return yield* reopener.reopenPending;
      });
      const first = yield* reopenWith;
      assert.deepEqual(first[0]?.outcome, { type: "reopened", by: "card" });
      yield* reopenWith;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const reopened = after.runtimeRequests.filter(
        (request) => request.id === "update-reopen:ask-user:closed",
      );
      assert.deepEqual(
        reopened.map((request) => [request.kind, request.status, request.responseCapability.type]),
        [["user_input", "pending", "message"]],
      );
      const notes = after.turnItems.flatMap((item) =>
        item.type === "system_notice" && item.title === "Closed by the update" ? [item] : [],
      );
      assert.lengthOf(notes, 1);
      assert.equal(notes[0]!.runId, runId);
      assert.include(notes[0]!.message, "> Which database should I use?");
      const cards = after.turnItems.flatMap((item) =>
        item.type === "user_input_request" && item.requestId === "update-reopen:ask-user:closed"
          ? [item]
          : [],
      );
      assert.deepEqual(
        cards.map((card) => [card.status, card.responseMode, card.questions[0]?.question]),
        [["waiting", "message", "Which database should I use?"]],
      );
    }),
  );
  // shared-champion-highlight, October 21: a forced update cancelled the two
  // messages queued behind run 3, then interrupted it. The cancelled rows have
  // higher ordinals, and the thread was never continued.
  it.effect("continues a turn whose queued messages the update cancelled, then requeues them", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "update-cancelled-queue";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      const queued = [
        yield* queueMessage(name, threadId, "First follow-up."),
        yield* queueMessage(name, threadId, "Second follow-up."),
      ];
      // The update's drain: queued messages first, then the running turn.
      for (const runId of queued) {
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${name}:cancel:${runId}`),
          threadId,
          runId,
          cause: "service_update",
        });
      }
      const runId = yield* interruptRun(name, threadId, first, "service_update");
      const outbox = yield* continueAll;
      const effects = yield* outbox.listByCommandId(
        CommandId.make(`command:update-continue:${runId}`),
      );
      assert.deepEqual(
        effects.map((effect) => effect.request),
        [{ type: "provider-runtime.continue", sourceRunId: runId }],
      );
      // Effects on a thread run in order: the continuation, then the requeue.
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:1`, releaseHeld: false });
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:2`, releaseHeld: false });
      const after = yield* orchestrator.getThreadProjection(threadId);
      const textOf = (messageId: string) =>
        after.messages.find((message) => message.id === messageId)?.text;
      assert.deepEqual(
        after.runs.map((run) => [
          run.status,
          run.restartContinuationOfRunId === runId ? "continuation" : textOf(run.userMessageId),
          run.queueHeld === true,
        ]),
        [
          ["interrupted", "Start work.", false],
          ["cancelled", "First follow-up.", false],
          ["cancelled", "Second follow-up.", false],
          [after.runs[3]!.status, "continuation", false],
          ["queued", "First follow-up.", false],
          ["queued", "Second follow-up.", false],
        ],
      );
      assert.notEqual(after.runs[3]!.status, "queued");
    }),
  );

  // The drain cancels the queued message and interrupts the turn; a person's
  // Stop then makes that interrupt theirs (#753). Their Stop is final, so
  // neither a restart nor a hold that ends sends the message again.
  it.effect("never requeues a drained message on a thread a person stopped, after a restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "drained-then-stopped";
      const { threadId } = yield* drainedThread(name, true);
      yield* continueAll;
      assert.deepEqual(yield* requeueEffects(threadId), []);
      // Even a resume-queue effect written before the Stop sends nothing.
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:requeue`, releaseHeld: true });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.messages.filter((message) => message.id.startsWith("message:update-requeue:")),
        [],
      );
      assert.lengthOf(after.runs, 2);
    }),
  );

  // The Stop settles the drained message for good: a newer turn the person
  // ran since does not bring it back at the next restart or hold end.
  it.effect("never requeues a drained message after the person's Stop and a newer turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const name = "drained-stopped-then-later";
      const { threadId, queuedId } = yield* drainedThread(name, true);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}:later`),
        threadId,
        messageId: MessageId.make(`${name}:later`),
        text: "Do something else.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const later = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === `${name}:later`,
      )!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:later-done`),
        events: [
          {
            id: EventId.make(`${name}:later-done`),
            type: "run.updated",
            threadId,
            runId: later.id,
            occurredAt: now,
            payload: { ...later, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* continueAll;
      assert.deepEqual(yield* requeueEffects(threadId), []);
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:requeue`, releaseHeld: true });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.messages.filter((message) => message.id.startsWith("message:update-requeue:")),
        [],
      );
      const drained = after.runs.find((run) => run.id === queuedId)!;
      assert.deepEqual([drained.status, drained.cancelledForUpdate], ["cancelled", undefined]);
    }),
  );

  // A message the person queues after their Stop, while the stopped turn still
  // runs, is theirs: the drain cancels it, and the restart queues it again once.
  it.effect("requeues a message queued after the person's Stop, once and in order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const name = "queued-after-stop";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      const providerTurn = yield* markRunning(name, threadId, first);
      // The person's Stop reaches the turn; its provider has not ended it yet.
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${name}:person-stop`),
        threadId,
        runId: first,
        holdQueue: true,
      });
      const queuedId = yield* queueMessage(name, threadId, "After my Stop.");
      // The update's drain: the queued message, then the turn.
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`${name}:cancel`),
        threadId,
        runId: queuedId,
        cause: "service_update",
      });
      const running = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === first,
      )!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:interrupted`),
        events: [
          {
            id: EventId.make(`${name}:run-interrupted`),
            type: "run.updated",
            threadId,
            runId: first,
            occurredAt: now,
            payload: { ...running, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make(`${name}:turn-interrupted`),
            type: "provider-turn.updated",
            threadId,
            runId: first,
            occurredAt: now,
            payload: { ...providerTurn, status: "interrupted", completedAt: now },
          },
        ],
      });
      yield* continueAll;
      assert.lengthOf(yield* requeueEffects(threadId), 1);
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:1`, releaseHeld: false });
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:2`, releaseHeld: false });
      const after = yield* orchestrator.getThreadProjection(threadId);
      const textOf = (messageId: string) =>
        after.messages.find((message) => message.id === messageId)?.text;
      assert.deepEqual(
        after.runs.map((run) => [run.status, textOf(run.userMessageId)]),
        [
          ["interrupted", "Start work."],
          ["cancelled", "After my Stop."],
          [after.runs[2]!.status, "After my Stop."],
        ],
      );
      assert.equal(after.runs[2]!.userMessageId, `message:update-requeue:${queuedId}`);
    }),
  );

  it.effect("never requeues a drained message on a thread a person stopped, after a hold", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const hold = yield* ServiceUpdateHold.makeWithOptions({
        agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
      }).pipe(Effect.provide(NodeServices.layer));
      yield* resumeAfterHoldReleases({
        releaseCount: hold.releaseCount,
        updateUnderway: hold.isHeld,
        installRequestOpen: Effect.succeed(false),
        exclusive: (effect) => effect,
        resumeAfterUpdate: recovery.resumeAfterUpdate,
        pollMs: 1_000,
      }).pipe(Effect.forkScoped);
      yield* hold.acquire({ reason: "install" });
      const stopped = yield* drainedThread("hold-drained-stopped", true);
      // The same drain with no Stop after it: its message is queued again.
      const updateOnly = yield* drainedThread("hold-drained-update", false);
      yield* hold.release("cancelled");
      yield* TestClock.adjust("1 second");
      // The forked pass reads SQLite; wait in real time for it to write.
      let written = yield* requeueEffects(updateOnly.threadId);
      for (let look = 0; written.length === 0 && look < 100; look += 1) {
        yield* TestClock.withLive(Effect.sleep("10 millis"));
        written = yield* requeueEffects(updateOnly.threadId);
      }
      assert.lengthOf(written, 1);
      assert.deepEqual(yield* requeueEffects(stopped.threadId), []);
    }).pipe(Effect.scoped),
  );

  it.effect("holds the queue for the person when they stop the turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "person-stop-holds";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      const queuedId = yield* queueMessage(name, threadId, "Later.");
      // Stop: the interrupt holds the rest of the thread.
      yield* interruptRun(name, threadId, first, "user", true);
      const after = yield* orchestrator.getThreadProjection(threadId);
      const held = after.runs.find((run) => run.id === queuedId)!;
      assert.deepEqual(
        [held.status, held.queueHeld, held.queueHeldForRestart],
        ["queued", true, undefined],
      );
    }),
  );

  // A person held this queue (Stop) before the update cut the turn off. The
  // continuation resumes the turn and leaves the held messages for the person;
  // a message the update cancelled is queued again behind that hold. The hold is
  // written as versions before the restart mark saved it.
  it.effect("keeps a queue a person held when it continues the turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const name = "person-held-queue";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      const heldId = yield* queueMessage(name, threadId, "Wait for me.");
      const cancelledId = yield* queueMessage(name, threadId, "Cancelled by the update.");
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`${name}:cancel`),
        threadId,
        runId: cancelledId,
        cause: "service_update",
      });
      const held = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === heldId,
      )!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:hold`),
        events: [
          {
            id: EventId.make(`${name}:hold`),
            type: "run.updated",
            threadId,
            runId: heldId,
            occurredAt: now,
            payload: { ...held, queueHeld: true },
          },
        ],
      });
      const runId = yield* interruptRun(name, threadId, first, "service_update");
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        after.runs.find((run) => run.restartContinuationOfRunId === runId)?.threadId,
        threadId,
      );
      const stillHeld = after.runs.find((run) => run.id === heldId)!;
      assert.deepEqual([stillHeld.status, stillHeld.queueHeld], ["queued", true]);
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:requeue`, releaseHeld: true });
      const requeued = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        requeued.runs
          .filter((run) => run.status === "queued")
          .map((run) => [run.userMessageId, run.queueHeld, run.queueHeldForRestart]),
        [
          [held.userMessageId, true, undefined],
          [`message:update-requeue:${cancelledId}`, true, undefined],
        ],
      );
    }),
  );

  // When the update cannot interrupt a turn it stops the thread. That Stop holds
  // the queue for the restart, which releases it with the continuation.
  it.effect("holds the queue for the restart when the update stops the thread", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "update-stop-holds";
      const threadId = yield* startedThread(name);
      const queuedId = yield* queueMessage(name, threadId, "Behind the update.");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${name}:stop`),
        threadId,
        reason: "SpecWithCode is updating",
        cause: "service_update",
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      const held = after.runs.find((run) => run.id === queuedId)!;
      assert.deepEqual(
        [held.status, held.queueHeld, held.queueHeldForRestart],
        ["queued", true, true],
      );
    }),
  );

  // Messages queued behind a turn the restart cut off are held by the restart
  // itself (its shutdown recovery); the continuation releases them to run after it.
  it.effect("releases the queue the restart held when it continues the turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const name = "restart-held-queue";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      const queuedId = yield* queueMessage(name, threadId, "After the update.");
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === queuedId,
      )!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:hold`),
        events: [
          {
            id: EventId.make(`${name}:hold`),
            type: "run.updated",
            threadId,
            runId: queuedId,
            occurredAt: now,
            payload: holdForRestart(queued),
          },
        ],
      });
      const runId = yield* interruptRun(name, threadId, first, "service_update");
      yield* continueAll;
      yield* continueRestartedRun({ threadId, sourceRunId: runId });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        after.runs.find((run) => run.restartContinuationOfRunId === runId)?.threadId,
        threadId,
      );
      const released = after.runs.find((run) => run.id === queuedId)!;
      assert.deepEqual(
        [released.status, released.queueHeld === true, released.queueHeldForRestart],
        ["queued", false, undefined],
      );
    }),
  );
  // An automatic install that waited too long for running work pauses it the
  // way Update now does: the agent runs `service prepare-update --stop-work
  // --hold --reason install`, which sends the very RPC input the desktop's
  // Update now sends, and the real drain interrupts each turn for the update.
  // After the restart that turn continues once with its update label and its
  // cancelled message is queued again; a turn the person stopped stays stopped.
  it.effect("continues a turn an automatic install paused through the service CLI drain", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recentTime);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = "automatic-pause";
      const threadId = yield* startedThread(name);
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      yield* markRunning(name, threadId, first);
      const queuedId = yield* queueMessage(name, threadId, "After the pause.");
      const personName = "automatic-pause-person";
      const personThread = yield* startedThread(personName);
      const personRun = (yield* orchestrator.getThreadProjection(personThread)).runs[0]!.id;
      yield* markRunning(personName, personThread, personRun);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${personName}:interrupt`),
        threadId: personThread,
        runId: personRun,
        reason: "Stopped by the user",
        cause: "user",
      });

      // The CLI flags give the input Update now sends (apps/web serviceUpdateFlow.ts).
      const input = yield* prepareInputFromFlags({
        stopWork: true,
        hold: true,
        releaseHold: false,
        reason: Option.some("install"),
      });
      assert.deepEqual(input, { stopWork: true, hold: true, reason: "install" });

      // The agent is waiting for a quiet moment, so the drain holds the service.
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-automatic-pause-" });
      const agentStatePath = path.join(dir, "state.json");
      yield* fileSystem.writeFileString(
        agentStatePath,
        JSON.stringify({ status: "waiting-for-quiet", installedVersion: "1.0.90" }),
      );
      const hold = yield* ServiceUpdateHold.makeWithOptions({ agentStatePath });
      const released: Array<string> = [];
      const preparation = yield* Preparation.makeWithTimings({
        interruptGraceMs: 40,
        settleMs: 40,
        effectGraceMs: 40,
        deadlineMs: 5_000,
        pollMs: 5,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ThreadManagementService.layer,
            Layer.succeed(ServiceUpdateHold.ServiceUpdateHold, hold),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              release: (request) =>
                Effect.sync(() => {
                  released.push(request.providerSessionId);
                }) as never,
              releaseIdle: () => Effect.succeed(0),
            }),
          ),
        ),
      );
      // The drain polls in real time, as it does in the service.
      const result = yield* TestClock.withLive(preparation.prepare(input));
      assert.isTrue(result.held);
      assert.equal(result.holdReason, "install");
      assert.isTrue(result.idle);

      const causes = (projection: {
        readonly turnItems: ReadonlyArray<{ readonly type: string; readonly cause?: unknown }>;
      }) =>
        projection.turnItems
          .filter((item) => item.type === "run_interrupt_request")
          .map((item) => item.cause);
      const drained = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        drained.runs.map((run) => [run.id, run.status]),
        [
          [first, "interrupted"],
          [queuedId, "cancelled"],
        ],
      );
      assert.deepEqual(causes(drained), ["service_update"]);
      const personDrained = yield* orchestrator.getThreadProjection(personThread);
      assert.deepEqual(
        personDrained.runs.map((run) => run.status),
        ["interrupted"],
      );
      assert.deepEqual(causes(personDrained), ["user"]);

      // The restart: recovery continues the update's turn once, then requeues.
      yield* hold.release("cancelled");
      const outbox = yield* continueAll;
      const effects = yield* outbox.listByCommandId(
        CommandId.make(`command:update-continue:${first}`),
      );
      assert.deepEqual(
        effects.map((effect) => effect.request),
        [{ type: "provider-runtime.continue", sourceRunId: first }],
      );
      yield* continueRestartedRun({ threadId, sourceRunId: first });
      yield* continueRestartedRun({ threadId, sourceRunId: first });
      yield* resumeQueueAfterRestart({ threadId, effectId: `${name}:1`, releaseHeld: false });
      yield* continueRestartedRun({ threadId: personThread, sourceRunId: personRun });
      const after = yield* orchestrator.getThreadProjection(threadId);
      // The update label: the web names a run continued for an update by this id.
      assert.deepEqual(
        after.messages
          .filter((message) => message.id === `message:update-continuation:${first}`)
          .map((message) => message.text),
        ["Continue where you left off."],
      );
      const textOf = (messageId: string) =>
        after.messages.find((message) => message.id === messageId)?.text;
      assert.deepEqual(
        after.runs.map((run) => [
          run.restartContinuationOfRunId === first ? "continuation" : textOf(run.userMessageId),
          run.status === "queued",
        ]),
        [
          ["Start work.", false],
          ["After the pause.", false],
          ["continuation", false],
          ["After the pause.", true],
        ],
      );
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(personThread)).runs.map((run) => run.status),
        ["interrupted"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
