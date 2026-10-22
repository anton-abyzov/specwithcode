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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CONTEXT_COMPACT_MESSAGE_PREFIX } from "./contextRecoveryIds.ts";
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
const projectId = ProjectId.make("project:compact-queue-hold");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "compact-queue-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// A wake queued behind `first` while it runs; returns the wake's run once
// `first` has ended and the queue was checked.
const wakeQueuedBehind = (first: { readonly messageId: string; readonly text: string }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${first.messageId}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${first.messageId}`),
      threadId,
      projectId,
      title: "Recovering from an overflow",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const messageId = first.messageId.replace("{thread}", threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(messageId),
      threadId,
      messageId: MessageId.make(messageId),
      text: first.text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    // A background-task wake arrives while that run is going.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`wake:${threadId}`),
      threadId,
      messageId: MessageId.make(`wake:${threadId}`),
      text: "Background task finished.",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "system",
      creationSource: "server",
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      before.runs.map((run) => run.status),
      ["starting", "queued"],
    );
    const [ended, queued] = [before.runs[0]!, before.runs[1]!];
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
    yield* sink.write({
      commandId: CommandId.make(`completed:${threadId}`),
      events: [
        {
          id: EventId.make(`completed:${threadId}`),
          type: "run.updated" as const,
          threadId,
          runId: ended.id,
          occurredAt: now,
          payload: { ...ended, status: "completed", completedAt: now },
        },
      ],
    });
    yield* Fiber.join(settled);
    return (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
  });

it.effect(
  "holds a wake queued behind the server's /compact for the request's resend",
  () =>
    Effect.gen(function* () {
      const queued = yield* wakeQueuedBehind({
        messageId: `${CONTEXT_COMPACT_MESSAGE_PREFIX}{thread}:run-overflowed`,
        text: "/compact",
      });
      assert.equal(queued.status, "queued");
      assert.equal(queued.queueHeld, true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);

it.effect(
  "starts a wake queued behind any other completed run",
  () =>
    Effect.gen(function* () {
      const queued = yield* wakeQueuedBehind({
        messageId: "message:{thread}:summary",
        text: "Summarise the release notes.",
      });
      assert.equal(queued.status, "starting");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);
