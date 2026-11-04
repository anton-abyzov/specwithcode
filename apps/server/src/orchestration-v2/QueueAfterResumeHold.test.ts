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
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { COORDINATOR_RESUME_REFUSAL, CoordinatorWakeGate } from "../project/CoordinatorWakeGate.ts";
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
const projectId = ProjectId.make("project:queue-after-resume");
const layerDatabase = fixtureProjectDatabase([projectId]);

// A gate that refuses as right after a resume while `held`, and signals each refusal.
const gate = { held: false, refused: undefined as Deferred.Deferred<void> | undefined };
const layerGate = Layer.succeed(CoordinatorWakeGate, {
  check: () =>
    Effect.suspend(() => {
      if (!gate.held) return Effect.succeed(null);
      const refused = gate.refused;
      return (
        refused === undefined
          ? Effect.void
          : Deferred.succeed(refused, undefined).pipe(Effect.asVoid)
      ).pipe(Effect.as(COORDINATOR_RESUME_REFUSAL));
    }),
});
const layerHold = Layer.effect(
  Hold.ServiceUpdateHold,
  Hold.makeWithOptions({
    agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "queue-after-resume" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(layerHold, layerGate)));

it.effect(
  "starts a queue a resume hold refused once the hold ends, with no other transition",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:queue-after-resume");
      gate.held = false;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-queue-after-resume"),
        threadId,
        projectId,
        title: "Queued behind a resume",
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
          commandId: CommandId.make(`message:queue-after-resume:${ordinal}`),
          threadId,
          messageId: MessageId.make(`message:queue-after-resume:${ordinal}`),
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

      // The machine resumed: the coordinator's queue is refused when its run ends.
      gate.refused = yield* Deferred.make<void>();
      gate.held = true;
      const started = yield* sink
        .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === queued.id &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make("completed:queue-after-resume"),
        events: [
          {
            id: EventId.make("completed:queue-after-resume"),
            type: "run.updated" as const,
            threadId,
            runId: ended.id,
            occurredAt: now,
            payload: { ...ended, status: "completed", completedAt: now },
          },
        ],
      });
      yield* Deferred.await(gate.refused);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]!.status, "queued");

      // Still held at the first retry: it waits on.
      gate.refused = yield* Deferred.make<void>();
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(gate.refused);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]!.status, "queued");

      // The hold ends: the next retry starts the queue by itself.
      gate.held = false;
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(started);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]!.status, "starting");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);
