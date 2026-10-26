import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:queue-follows-thread");
// The thread's own provider, which stops, and the one the fallback moves it to.
const broken = ProviderInstanceId.make("codex");
const fallback = ProviderInstanceId.make("codex_fallback");
const brokenSelection = { instanceId: broken, model: "gpt-5.1-codex" };
const fallbackSelection = { instanceId: fallback, model: "gpt-5.1-codex" };
const adapterFor = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Runs here never reach a provider"),
  }) as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
// No effect worker: runs stay unstarted, so each test decides when one ends.
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "queue-follows-thread" },
    ProviderAdapterRegistry.layerFromAdapters([adapterFor(broken), adapterFor(fallback)]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Release worker",
      modelSelection: brokenSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const sendUser = (
  threadId: ThreadId,
  text: string,
  type: "start_immediately" | "queue_after_active",
  modelSelection?: ModelSelection,
) =>
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
      ...(modelSelection === undefined ? {} : { modelSelection }),
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A background-task notification, as ProviderContinuationService queues it. */
const notify = (threadId: ThreadId, text: string, creationSource: "server" | "provider") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`provider-continuation:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      notification: {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Background activity updated",
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource,
    });
  });

/** The fallback's continuation, as ProviderFallbackWorker dispatches it. */
const continueOnFallback = (threadId: ThreadId, stoppedRunId: RunId, prefix = "limit-fallback:") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const id = `${prefix}${threadId}:${stoppedRunId}`;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      modelSelection: fallbackSelection,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
  });

const projectionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.getThreadProjection(threadId);
  });

/**
 * Stops the turn with the queue held, standing in for a failure on the
 * thread's provider. An update's Stop, since no fallback continues after a
 * person's; its hold is the restart's (`queueHeldForRestart`), which a
 * fallback releases the same way as a failure's.
 */
const stopHoldingQueue = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const active = (yield* projectionOf(threadId)).runs.find((run) => run.status !== "queued")!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
      runId: active.id,
      holdQueue: true,
      cause: "service_update",
    });
    return active.id;
  });

/**
 * Ends the run that is executing the way a provider's final event does, and
 * waits until the queue promoted the next run.
 */
const completeAndStartNext = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* projectionOf(threadId);
    const run = projection.runs.find(
      (candidate) => candidate.status === "starting" || candidate.status === "running",
    )!;
    const next = projection.runs.find(
      (candidate) => candidate.status === "queued" && candidate.queueHeld !== true,
    )!;
    const started = yield* sink
      .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === next.id &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("10 seconds"),
        Effect.forkScoped,
      );
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`complete:${run.id}`),
      events: [
        {
          id: EventId.make(`complete:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    yield* Fiber.join(started);
    return (yield* projectionOf(threadId)).runs.find((candidate) => candidate.id === next.id)!;
  });

it.effect(
  "held notifications follow the thread to the provider a limit fallback moved it to",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:follows-fallback");
      yield* createThread(threadId);
      yield* sendUser(threadId, "brief", "start_immediately");
      // Queued on the thread's own provider while it worked: one wake the
      // server wrote, one the provider buffered for its own background task.
      yield* notify(threadId, "server wake", "server");
      yield* notify(threadId, "provider wake", "provider");
      const stoppedRunId = yield* stopHoldingQueue(threadId);
      const held = (yield* projectionOf(threadId)).runs.filter((run) => run.status === "queued");
      assert.deepEqual(
        held.map((run) => [run.providerInstanceId, run.queueHeld]),
        [
          [broken, true],
          [broken, true],
        ],
      );

      // The fallback continues on another provider and releases the hold.
      yield* continueOnFallback(threadId, stoppedRunId);
      const moved = yield* projectionOf(threadId);
      assert.equal(moved.thread.providerInstanceId, fallback);
      assert.isFalse(moved.runs.some((run) => run.queueHeld === true));
      // The provider's buffered wake cannot be delivered by another provider: it becomes text.
      assert.equal(
        moved.messages.find((message) => message.text === "provider wake")?.creationSource,
        "server",
      );

      // After the continuation each wake starts on the fallback, not the stopped provider.
      const first = yield* completeAndStartNext(threadId);
      assert.equal(first.providerInstanceId, fallback);
      assert.deepEqual(first.modelSelection, fallbackSelection);
      const firstThread = yield* projectionOf(threadId);
      assert.equal(firstThread.thread.providerInstanceId, fallback);
      assert.equal(
        firstThread.providerThreads.find((thread) => thread.id === first.providerThreadId)
          ?.providerInstanceId,
        fallback,
      );
      assert.equal(
        firstThread.attempts.find((attempt) => attempt.id === first.activeAttemptId)
          ?.providerInstanceId,
        fallback,
      );

      const second = yield* completeAndStartNext(threadId);
      assert.equal(second.providerInstanceId, fallback);
      assert.equal((yield* projectionOf(threadId)).thread.providerInstanceId, fallback);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "a user's queued message keeps a model picked for it after the fallback releases the hold",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:follows-explicit");
      const picked = { instanceId: broken, model: "gpt-5.2-codex" };
      yield* createThread(threadId);
      yield* sendUser(threadId, "brief", "start_immediately");
      yield* sendUser(threadId, "next step", "queue_after_active", picked);
      const stoppedRunId = yield* stopHoldingQueue(threadId);

      yield* continueOnFallback(threadId, stoppedRunId);
      assert.isFalse((yield* projectionOf(threadId)).runs.some((run) => run.queueHeld === true));

      const queued = yield* completeAndStartNext(threadId);
      assert.equal(queued.providerInstanceId, broken);
      assert.deepEqual(queued.modelSelection, picked);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "queued sends that took the thread's model go with the thread to the fallback",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:follows-inherited");
      yield* createThread(threadId);
      yield* sendUser(threadId, "brief", "start_immediately");
      // One send without a model, one with the model the composer showed, then a wake.
      yield* sendUser(threadId, "no model", "queue_after_active");
      yield* sendUser(threadId, "composer model", "queue_after_active", brokenSelection);
      yield* notify(threadId, "server wake", "server");
      const stoppedRunId = yield* stopHoldingQueue(threadId);

      yield* continueOnFallback(threadId, stoppedRunId);
      const released = (yield* projectionOf(threadId)).runs.filter(
        (run) => run.status === "queued",
      );
      assert.deepEqual(
        released.map((run) => [run.queueHeld, run.modelSelection]),
        [
          [false, fallbackSelection],
          [false, fallbackSelection],
          [false, brokenSelection],
        ],
      );

      for (let index = 0; index < 3; index++) {
        const started = yield* completeAndStartNext(threadId);
        assert.equal(started.providerInstanceId, fallback);
        assert.deepEqual(started.modelSelection, fallbackSelection);
        assert.equal((yield* projectionOf(threadId)).thread.providerInstanceId, fallback);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "a provider-buffered wake follows the thread to its API-credit instance",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:follows-api-credits");
      yield* createThread(threadId);
      yield* sendUser(threadId, "brief", "start_immediately");
      yield* notify(threadId, "provider wake", "provider");
      const stoppedRunId = yield* stopHoldingQueue(threadId);

      yield* continueOnFallback(threadId, stoppedRunId, "limit-api:");
      const moved = yield* projectionOf(threadId);
      assert.equal(
        moved.messages.find((message) => message.text === "provider wake")?.creationSource,
        "server",
      );
      const wake = yield* completeAndStartNext(threadId);
      assert.equal(wake.providerInstanceId, fallback);
      assert.equal((yield* projectionOf(threadId)).thread.providerInstanceId, fallback);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

/**
 * Fails the executing run with a provider error, the way a provider's final
 * events do, and waits until the queue reacted to it for `queuedRunId`.
 */
const failRunningAndAwait = (threadId: ThreadId, queuedRunId: RunId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const run = (yield* projectionOf(threadId)).runs.find(
      (candidate) => candidate.status === "starting" || candidate.status === "running",
    )!;
    const reacted = yield* sink
      .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === queuedRunId &&
            (stored.event.payload.status === "starting" || stored.event.payload.queueHeld === true),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("10 seconds"),
        Effect.forkScoped,
      );
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`fail:${run.id}`),
      events: [
        {
          id: EventId.make(`provider-error:${run.id}`),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:provider-error:${run.id}`),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId!,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 100,
            status: "failed",
            title: "Provider error",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure: {
              class: "provider_error",
              message: "The provider is overloaded.",
              code: null,
              retryable: null,
            },
          },
        },
        {
          id: EventId.make(`fail:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
      ],
    });
    yield* Fiber.join(reacted);
    return run;
  });

it.effect(
  "a wake that follows the thread stays held when the fallback it would start on just failed",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:follows-failed-fallback");
      yield* createThread(threadId);
      yield* sendUser(threadId, "brief", "start_immediately");
      yield* notify(threadId, "server wake", "server");
      const wake = (yield* projectionOf(threadId)).runs.find((run) => run.status === "queued")!;
      // The thread's provider fails and holds the wake behind it.
      const failedRun = yield* failRunningAndAwait(threadId, wake.id);
      assert.equal(
        (yield* projectionOf(threadId)).runs.find((run) => run.id === wake.id)?.queueHeld,
        true,
      );

      yield* continueOnFallback(threadId, failedRun.id);
      const continuation = (yield* projectionOf(threadId)).runs.find(
        (run) => run.status === "starting" || run.status === "running",
      )!;
      assert.equal(continuation.providerInstanceId, fallback);

      // The fallback fails too: the wake, which would start there, is held again.
      yield* failRunningAndAwait(threadId, wake.id);
      const after = (yield* projectionOf(threadId)).runs.find((run) => run.id === wake.id)!;
      assert.equal(after.status, "queued");
      assert.equal(after.queueHeld, true);
      assert.equal(after.providerInstanceId, broken);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it("the server's continuations of a stopped thread release its held queue", () => {
  const resume = {
    commandId: CommandId.make("limit-resume:thread:run:1"),
    messageId: MessageId.make("limit-resume:thread:run:1"),
    text: "Continue where you left off.",
    attachments: [],
    createdBy: "user",
    creationSource: "server",
    usageLimitContinuationOfRunId: RunId.make("run:1"),
  } as const;
  assert.isTrue(Orchestrator.messageReleasesHeldQueue(resume));
  for (const prefix of [
    "limit-fallback:",
    "provider-fallback:",
    "limit-api:",
    "limit-return:",
    "provider-retry:",
  ])
    assert.isTrue(
      Orchestrator.messageReleasesHeldQueue({
        ...resume,
        commandId: CommandId.make(`${prefix}thread:run`),
        messageId: MessageId.make(`${prefix}thread:run`),
      }),
    );
  // Only the server's own continuations; the same id from elsewhere decides nothing.
  assert.isFalse(Orchestrator.messageReleasesHeldQueue({ ...resume, creationSource: "web" }));
  // Native maintenance sent ahead of a continuation leaves the hold to the continuation.
  assert.isFalse(Orchestrator.messageReleasesHeldQueue({ ...resume, text: "/compact" }));
});
