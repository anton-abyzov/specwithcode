import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Hold from "../serviceUpdate/ServiceUpdateHold.ts";
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
  openSession: () => Effect.die("No provider process needed for queue promotion"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:queue-after-hold");
const layerDatabase = fixtureProjectDatabase([projectId]);

// The real hold, with a signal once the queue start found it held after the run ended.
// In this harness nothing else reads isHeld after the run ends (no scheduler,
// PR watch or terminals), so the signal comes from the queue start.
const runEnded = { value: false };
const layerHold = Layer.effect(
  Hold.ServiceUpdateHold,
  Effect.gen(function* () {
    const hold = yield* Hold.makeWithOptions({
      agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
    });
    const skippedWhileHeld = yield* Deferred.make<void>();
    return {
      ...hold,
      skippedWhileHeld,
      isHeld: hold.isHeld.pipe(
        Effect.tap((held) =>
          held && runEnded.value ? Deferred.succeed(skippedWhileHeld, undefined) : Effect.void,
        ),
      ),
    };
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "queue-after-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(layerHold));

// Two messages on one thread: the first starts, the second queues behind it.
// The update hold is taken, then the first run ends with `outcome` while held.
// Returns the queued run as it stands once the hold is released.
const queueBehindRunEndedWhileHeld = (outcome: "completed" | "failed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const hold = yield* Hold.ServiceUpdateHold;
    runEnded.value = false;
    const threadId = ThreadId.make(`thread:queue-after-hold:${outcome}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-queue-after-hold:${outcome}`),
      threadId,
      projectId,
      title: "Queued behind a hold",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const ordinal of [0, 1]) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`message:queue-after-hold:${outcome}:${ordinal}`),
        threadId,
        messageId: MessageId.make(`message:queue-after-hold:${outcome}:${ordinal}`),
        createdBy: "user",
        creationSource: "web",
        text: `Task ${ordinal}`,
        attachments: [],
        dispatchMode: { type: ordinal === 0 ? "start_immediately" : "queue_after_active" },
      });
    }
    const before = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      before.runs.map((run) => run.status),
      ["starting", "queued"],
    );
    const [ended, queued] = [before.runs[0]!, before.runs[1]!];

    yield* hold.acquire({ draining: true });
    // The queued run either starts or is held for the user after the hold ends.
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
    const now = yield* DateTime.now;
    runEnded.value = true;
    yield* sink.write({
      commandId: CommandId.make(`${outcome}:queue-after-hold`),
      events: [
        ...(outcome === "failed"
          ? [
              {
                id: EventId.make(`provider-error:queue-after-hold:${outcome}`),
                type: "turn-item.updated" as const,
                threadId,
                runId: ended.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`turn-item:provider-error:${outcome}`),
                  threadId,
                  runId: ended.id,
                  nodeId: ended.rootNodeId!,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 100,
                  status: "failed" as const,
                  title: "Provider error",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "error" as const,
                  failure: {
                    class: "provider_error" as const,
                    message: "The provider is overloaded.",
                    code: null,
                    retryable: null,
                  },
                },
              },
            ]
          : []),
        {
          id: EventId.make(`${outcome}:queue-after-hold`),
          type: "run.updated" as const,
          threadId,
          runId: ended.id,
          occurredAt: now,
          payload: { ...ended, status: outcome, completedAt: now },
        },
      ],
    });
    // The run's end checked the queue while held, and left it waiting.
    yield* Deferred.await(
      (hold as unknown as { readonly skippedWhileHeld: Deferred.Deferred<void> }).skippedWhileHeld,
    );
    const whileHeld = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
    assert.equal(whileHeld.status, "queued");
    assert.notEqual(whileHeld.queueHeld, true);

    yield* hold.release("cancelled");
    yield* Fiber.join(settled);
    return (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
  });

it.effect(
  "starts a queue its run's end found held once the update hold is released",
  () =>
    Effect.gen(function* () {
      const queued = yield* queueBehindRunEndedWhileHeld("completed");
      assert.equal(queued.status, "starting");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "keeps a queue behind a provider failure held after the update hold is released",
  () =>
    Effect.gen(function* () {
      const queued = yield* queueBehindRunEndedWhileHeld("failed");
      assert.equal(queued.status, "queued");
      assert.equal(queued.queueHeld, true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);
