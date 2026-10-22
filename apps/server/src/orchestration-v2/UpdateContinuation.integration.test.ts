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
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
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
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
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

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
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

/** A thread whose first turn is running on a live provider session, then is interrupted. */
const interruptedThread = (name: string, cause: "service_update" | "user") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
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
    const initial = yield* orchestrator.getThreadProjection(threadId);
    const runId = yield* interruptRun(name, threadId, initial.runs[0]!.id, cause);
    return { threadId, runId };
  });

/** Marks a pending run as running on a provider turn, then interrupts it with `cause`. */
const interruptRun = (
  name: string,
  threadId: ThreadId,
  runId: RunId,
  cause: "service_update" | "user",
) =>
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
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`${name}:interrupt`),
      threadId,
      runId: run.id,
      reason: cause === "service_update" ? "SpecWithCode is updating" : "Stopped by the user",
      cause,
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
});
