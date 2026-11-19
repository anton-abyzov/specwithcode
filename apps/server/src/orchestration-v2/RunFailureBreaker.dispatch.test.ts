import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Run,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for dispatch gating"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:failed-run-breaker");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "failed-run-breaker" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// A task id that itself contains ":manual", so only the trigger after it counts.
const ROUTINE = "scheduled-task:manual";
const fireId = (key: string) => `scheduled-task-message:${ROUTINE}:${key}`;

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId,
      title: "A routine that keeps failing",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const send = (
  threadId: ThreadId,
  messageId: string,
  dispatchMode: "start_immediately" | "queue_after_active" = "start_immediately",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:${messageId}`),
      threadId,
      messageId: MessageId.make(messageId),
      text: "Check the disk and report.",
      attachments: [],
      dispatchMode: { type: dispatchMode },
      createdBy: "system",
      creationSource: "server",
      ...(messageId.startsWith("scheduled-task-message:")
        ? { scheduledTaskId: ScheduledTaskId.make(ROUTINE) }
        : {}),
    });
  });

const finish = (threadId: ThreadId, run: OrchestrationV2Run, status: "failed" | "completed") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`${status}:${run.id}`),
      events: [
        {
          id: EventId.make(`${status}:${run.id}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
  });

const latestRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    return runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]!;
  });

// Each fire starts and fails, as the October 21 thread's routine did.
const failFires = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index++) {
      yield* send(threadId, fireId(`2026-11-19T0${index}:00:00Z:scheduled`));
      yield* finish(threadId, yield* latestRun(threadId), "failed");
    }
  });

it.effect(
  "refuses a routine fire after three failed runs, and lets Run now and a person's message through",
  () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("breaker-dispatch");
      yield* failFires(threadId, 3);
      const refused = yield* Effect.exit(
        send(threadId, fireId("2026-11-19T04:00:00Z:scheduled")),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), "last 3 runs failed");
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(send(threadId, `provider-retry:${threadId}:run-3`))),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(send(threadId, fireId("webhook:delivery-1")))),
      );
      // A person's Run now is the way back after fixing the routine.
      yield* send(threadId, fireId("manual:command:run-now-1"));
      const manual = yield* latestRun(threadId);
      assert.equal(manual.status, "starting");
      // It succeeds, so scheduled fires start again.
      yield* finish(threadId, manual, "completed");
      yield* send(threadId, fireId("2026-11-19T05:00:00Z:scheduled"));
      assert.equal((yield* latestRun(threadId)).status, "starting");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

// A routine fire queued behind the run that makes the third failure.
const fireQueuedBehindThirdRun = (
  name: string,
  third: "failed" | "completed",
  personBehind = false,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const threadId = yield* createThread(name);
    yield* failFires(threadId, 2);
    yield* send(threadId, `message:${threadId}:third`);
    const running = yield* latestRun(threadId);
    yield* send(
      threadId,
      fireId("2026-11-19T06:00:00Z:scheduled"),
      "queue_after_active",
    );
    const queued = yield* latestRun(threadId);
    assert.equal(queued.status, "queued");
    if (personBehind) yield* send(threadId, `message:${threadId}:person`, "queue_after_active");
    const settled = yield* sink
      .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === queued.id &&
            (stored.event.payload.status === "starting" || stored.event.payload.queueHeld === true),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
    yield* finish(threadId, running, third);
    yield* Fiber.join(settled);
    const runs = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId)).runs;
    return { threadId, fire: runs.find((run) => run.id === queued.id)! };
  });

it.effect(
  "holds a queued routine fire for a person once the run ahead of it is the third failure",
  () =>
    Effect.gen(function* () {
      const { fire } = yield* fireQueuedBehindThirdRun("breaker-queue-held", "failed");
      assert.equal(fire.status, "queued");
      assert.equal(fire.queueHeld, true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "starts a queued routine fire when the run ahead of it succeeded",
  () =>
    Effect.gen(function* () {
      const { fire } = yield* fireQueuedBehindThirdRun("breaker-queue-starts", "completed");
      assert.equal(fire.status, "starting");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "starts the held fire when a person resumes the queue, with their message behind it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, fire } = yield* fireQueuedBehindThirdRun("breaker-resume", "failed", true);
      assert.equal(fire.queueHeld, true);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`resume:${threadId}`),
        threadId,
      });
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const resumed = runs.find((run) => run.id === fire.id)!;
      assert.equal(resumed.status, "starting");
      const person = runs.find((run) => run.userMessageId === `message:${threadId}:person`)!;
      assert.equal(person.status, "queued");
      assert.notEqual(person.queueHeld, true);
      // The resumed fire fails too; the person's message behind it still starts.
      const sink = yield* EventSink.EventSinkV2;
      const started = yield* sink
        .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === person.id &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* finish(threadId, resumed, "failed");
      yield* Fiber.join(started);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "holds the fire again when its hold is released by anything but a person's Resume",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, fire } = yield* fireQueuedBehindThirdRun("breaker-auto-release", "failed");
      assert.equal(fire.queueHeld, true);
      const heldAgain = yield* sink
        .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === fire.id &&
              (stored.event.payload.status === "starting" ||
                stored.event.payload.queueHeld === true),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make(`auto-release:${fire.id}`),
        events: [
          {
            id: EventId.make(`auto-release:${fire.id}`),
            type: "run.updated" as const,
            threadId,
            runId: fire.id,
            occurredAt: now,
            payload: { ...fire, queueHeld: false },
          },
        ],
      });
      const [event] = yield* Fiber.join(heldAgain);
      const payload = event?.event.type === "run.updated" ? event.event.payload : undefined;
      assert.equal(payload?.status, "queued");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);
