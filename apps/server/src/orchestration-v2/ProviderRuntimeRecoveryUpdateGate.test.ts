import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

// After an update restart the helper's install gate is live while it proves
// history is unchanged, so startup runs `reconcile` alone and defers
// `resumeAfterUpdate` (see runOrderedV2StartupPhases). Reconcile must not
// queue again what the update cancelled; the resume must.

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const projectId = ProjectId.make("project:update-gate");
const threadId = ThreadId.make("thread:update-gate");

type UnstampedEvent = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt">
    : never
  : never;

const requeueCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
    WHERE effect_id LIKE 'effect:update-requeue:%'
  `;
  return Number(rows[0]?.count ?? 0);
});

const seedCancelledForUpdate = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  let index = 0;
  const apply = (event: UnstampedEvent) =>
    projections.apply({
      ...event,
      id: EventId.make(`event:update-gate:${index++}`),
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    threadId,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "update gate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runId = RunId.make(`run:${threadId}:1`);
  yield* apply({
    type: "run.created",
    threadId,
    runId,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "cancelled",
      requestedAt: now,
      startedAt: null,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
      cancelledForUpdate: true,
    },
  } as UnstampedEvent);
});

const layerStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  IdAllocator.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layer = Layer.fresh(
  ProviderRuntimeRecovery.layer.pipe(
    Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(layerStores))),
    Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
  ),
);

it.live(
  "startup reconcile alone queues nothing; resumeAfterUpdate queues the cancelled message",
  () =>
    Effect.gen(function* () {
      yield* seedCancelledForUpdate;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      yield* recovery.reconcile("startup");
      assert.equal(yield* requeueCount, 0, "reconcile writes no requeue while the gate is live");
      yield* recovery.resumeAfterUpdate;
      assert.equal(yield* requeueCount, 1);
    }).pipe(Effect.provide(layer)),
);

it.live("recover reconciles and queues the cancelled message again", () =>
  Effect.gen(function* () {
    yield* seedCancelledForUpdate;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    yield* recovery.recover;
    assert.equal(yield* requeueCount, 1);
  }).pipe(Effect.provide(layer)),
);
