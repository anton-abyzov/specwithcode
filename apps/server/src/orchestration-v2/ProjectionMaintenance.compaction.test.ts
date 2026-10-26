import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(
  layerStores,
  EventSink.layer.pipe(Layer.provide(layerStores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerStores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const makeThread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: `Thread ${threadId}`,
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
});

let serial = 0;

/** Builds a history in which every compacted event type is superseded several times. */
const makeHistory = (threadIds: ReadonlyArray<ThreadId>, start: DateTime.Utc, rounds: number) => {
  let tick = 0;
  const at = () => DateTime.add(start, { seconds: (tick += 1) });
  const id = (label: string) => EventId.make(`event:compaction:${label}:${(serial += 1)}`);
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const threadId of threadIds) {
    events.push({
      id: id("created"),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: at(),
      payload: makeThread(threadId, start),
    });
  }
  for (let round = 0; round < rounds; round += 1) {
    for (const threadId of threadIds) {
      const thread = makeThread(threadId, start);
      // Node A is first written before node B, and with an even number of
      // rounds B's newest snapshot lands before A's: keep-last would reorder them.
      for (const name of round % 2 === 0 ? ["a", "b"] : ["b", "a"]) {
        const nodeId = NodeId.make(`node:${threadId}:${name}`);
        const occurredAt = at();
        events.push({
          id: id("node"),
          type: "node.updated",
          threadId,
          occurredAt,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "assistant_message",
            status: round === rounds - 1 ? "completed" : "running",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: start,
            completedAt: round === rounds - 1 ? occurredAt : null,
          },
        });
      }
      const messageId = MessageId.make(`message:${threadId}:${round % 3}`);
      events.push({
        id: id("message"),
        type: "message.updated",
        threadId,
        occurredAt: at(),
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: `round ${round}`,
          attachments: [],
          streaming: round < rounds - 1,
          createdAt: start,
          updatedAt: at(),
        },
      });
      const itemAt = at();
      events.push({
        id: id("item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: itemAt,
        payload: {
          id: TurnItemId.make(`turn-item:${threadId}:${round % 2}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: round % 2,
          status: "completed",
          title: null,
          startedAt: start,
          completedAt: itemAt,
          updatedAt: itemAt,
          type: "assistant_message",
          messageId: MessageId.make(`message:${threadId}:item`),
          text: `item round ${round}`,
          streaming: false,
        },
      });
      if (round % 3 === 0) {
        events.push({
          id: id("meta"),
          type: "thread.metadata-updated",
          threadId,
          providerInstanceId,
          occurredAt: at(),
          payload: { ...thread, title: `Title ${round}`, updatedAt: at() },
        });
      }
      events.push({
        id: id("visit"),
        type: "thread.visited",
        threadId,
        providerInstanceId,
        occurredAt: at(),
        payload: { ...thread, title: `Visited ${round}`, lastVisitedAt: at() },
      });
    }
  }
  return events;
};

/** Every projection row with its rowid, in rowid order; the cursor's write time aside. */
const snapshotProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table'
      AND (name LIKE 'orchestration_v2_projection_%' OR name = 'orchestration_v2_turn_item_positions')
    ORDER BY name
  `;
  const snapshot: Record<string, unknown> = {};
  for (const { name } of tables) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT rowid AS __rowid, * FROM "${name}" ORDER BY rowid`,
    );
    snapshot[name] =
      name === "orchestration_v2_projection_metadata"
        ? rows.map(({ updated_at: _updatedAt, ...row }) => row)
        : rows;
  }
  return JSON.stringify(snapshot);
});

const eventSequences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events ORDER BY sequence
  `;
  return rows.map((row) => row.sequence);
});

const writeHistory = (threadIds: ReadonlyArray<ThreadId>, rounds: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    for (const event of makeHistory(threadIds, now, rounds)) {
      yield* sink.write({ events: [event] });
    }
  });

it.layer(layerTest)("event store compaction", (it) => {
  it.effect("keeps rebuilt projections byte-identical, rowids included", () =>
    Effect.gen(function* () {
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadIds = [
        ThreadId.make("thread:compaction:1"),
        ThreadId.make("thread:compaction:2"),
      ];
      yield* writeHistory(threadIds, 10);

      const live = yield* snapshotProjections;
      assert.isTrue((yield* maintenance.rebuild).valid);
      const rebuiltBefore = yield* snapshotProjections;
      assert.strictEqual(rebuiltBefore, live);
      const before = yield* eventSequences;

      const dryRun = yield* maintenance.compactEventStoreWith({ dryRun: true, pageSize: 7 });
      assert.deepEqual(yield* eventSequences, before);

      const summary = yield* maintenance.compactEventStoreWith({ pageSize: 7 });
      assert.isFalse(summary.interrupted);
      assert.equal(summary.deletedEventCount, dryRun.deletedEventCount);
      assert.deepEqual(summary.deletedByType, dryRun.deletedByType);
      // Per thread: 2 nodes x (10 - 2), messages 2 + 1 + 1, 9 of 10 visits, 3 of 4 metadata updates.
      assert.deepEqual(summary.deletedByType, {
        "node.updated": 32,
        "message.updated": 8,
        "thread.visited": 18,
        "thread.metadata-updated": 6,
      });
      assert.isAbove(summary.deletedEventChars, 0);
      const after = yield* eventSequences;
      assert.equal(after.length, before.length - summary.deletedEventCount);
      assert.equal(after.at(-1), before.at(-1));

      // Rebuild replays across the gaps to the same bytes as before compaction.
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.strictEqual(yield* snapshotProjections, rebuiltBefore);

      // A second pass finds nothing left to delete.
      const again = yield* maintenance.compactEventStore;
      assert.equal(again.deletedEventCount, 0);
    }),
  );

  it.effect("an incremental pass reads only threads with newer events", () =>
    Effect.gen(function* () {
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const busy = ThreadId.make("thread:compaction:busy");
      const quiet = ThreadId.make("thread:compaction:quiet");
      yield* writeHistory([busy, quiet], 3);
      const first = yield* maintenance.compactEventStore;
      assert.isAbove(first.deletedEventCount, 0);
      assert.isNull(first.scannedStreamCount);

      yield* writeHistory([busy], 3);
      const rebuiltBefore = yield* maintenance.rebuild.pipe(Effect.andThen(snapshotProjections));
      const incremental = yield* maintenance.compactEventStoreWith({
        sinceSequence: first.throughSequence,
      });
      assert.equal(incremental.scannedStreamCount, 1);
      assert.isAbove(incremental.deletedEventCount, 0);
      // Nothing an incremental pass skipped was left behind.
      assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.strictEqual(yield* snapshotProjections, rebuiltBefore);
    }),
  );

  it.effect("stops before its next delete once told to", () =>
    Effect.gen(function* () {
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* writeHistory([ThreadId.make("thread:compaction:held")], 6);
      const before = yield* eventSequences;
      let checks = 0;
      const summary = yield* maintenance.compactEventStoreWith({
        pageSize: 5,
        pauseBetweenPages: Duration.zero,
        shouldContinue: Effect.sync(() => {
          checks += 1;
          return false;
        }),
      });
      assert.isTrue(summary.interrupted);
      assert.equal(checks, 1);
      assert.equal(summary.deletedEventCount, 0);
      assert.deepEqual(yield* eventSequences, before);
    }),
  );
});
