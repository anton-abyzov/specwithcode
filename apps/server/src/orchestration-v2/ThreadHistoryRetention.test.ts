import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadHistoryRetention from "./ThreadHistoryRetention.ts";

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

const CREATED = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
/** Ten days before NOW: past the 7-day purge, short of the 30-day compaction. */
const TEN_DAYS_AGO = DateTime.makeUnsafe("2026-02-19T00:00:00.000Z");
const FORTY_DAYS_AGO = DateTime.makeUnsafe("2026-01-20T00:00:00.000Z");
const TWO_DAYS_AGO = DateTime.makeUnsafe("2026-02-27T00:00:00.000Z");
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-01T00:00:00.000Z"));
const POLICY = { deletedAfterDays: 7, archivedAfterDays: 30, historyDays: null } as const;

const makeThread = (
  threadId: ThreadId,
  extra: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:retention"),
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
  createdAt: CREATED,
  updatedAt: CREATED,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...extra,
});

let serial = 0;
const eventId = (label: string) => EventId.make(`event:retention:${label}:${(serial += 1)}`);

/** A thread with `rounds` of node, message and turn-item snapshots, then its end state. */
const threadHistory = (
  threadId: ThreadId,
  rounds: number,
  end: "active" | "archived" | "deleted",
  at: DateTime.Utc,
  extra: Partial<OrchestrationV2AppThread> = {},
): Array<OrchestrationV2DomainEvent> => {
  const thread = makeThread(threadId, extra);
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: eventId("created"),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: CREATED,
      payload: thread,
    },
  ];
  for (let round = 0; round < rounds; round += 1) {
    const nodeId = NodeId.make(`node:${threadId}:${round % 2}`);
    events.push({
      id: eventId("node"),
      type: "node.updated",
      threadId,
      occurredAt: CREATED,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "assistant_message",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: CREATED,
        completedAt: CREATED,
      },
    });
    events.push({
      id: eventId("message"),
      type: "message.updated",
      threadId,
      occurredAt: CREATED,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make(`message:${threadId}:${round}`),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: `round ${round}`,
        attachments:
          round === 0
            ? [
                {
                  type: "file",
                  id: `file_${threadId.replaceAll(/[^a-z0-9]/g, "")}`,
                  name: "input.txt",
                  mimeType: "text/plain",
                  sizeBytes: 10,
                },
              ]
            : [],
        streaming: false,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    });
    events.push({
      id: eventId("item"),
      type: "turn-item.updated",
      threadId,
      occurredAt: CREATED,
      payload: {
        id: TurnItemId.make(`turn-item:${threadId}:${round}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: round,
        status: "completed",
        title: null,
        startedAt: CREATED,
        completedAt: CREATED,
        updatedAt: CREATED,
        type: "assistant_message",
        messageId: MessageId.make(`message:${threadId}:item:${round}`),
        text: `item ${round}`,
        streaming: false,
      },
    });
  }
  if (end === "archived") {
    events.push({
      id: eventId("archived"),
      type: "thread.archived",
      threadId,
      providerInstanceId,
      occurredAt: at,
      payload: { ...thread, archivedAt: at, updatedAt: at },
    });
  }
  if (end === "deleted") {
    events.push({
      id: eventId("deleted"),
      type: "thread.deleted",
      threadId,
      providerInstanceId,
      occurredAt: at,
      payload: { ...thread, deletedAt: at, updatedAt: at },
    });
  }
  return events;
};

const ids = {
  deleted: ThreadId.make("thread:retention:deleted"),
  recentlyDeleted: ThreadId.make("thread:retention:recently-deleted"),
  linked: ThreadId.make("thread:retention:linked"),
  archived: ThreadId.make("thread:retention:archived"),
  recentlyArchived: ThreadId.make("thread:retention:recently-archived"),
  active: ThreadId.make("thread:retention:active"),
};

const writeFixture = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const linkedMachine = EnvironmentId.make("machine-elsewhere");
  for (const event of [
    ...threadHistory(ids.deleted, 6, "deleted", TEN_DAYS_AGO),
    ...threadHistory(ids.recentlyDeleted, 3, "deleted", TWO_DAYS_AGO),
    ...threadHistory(ids.linked, 3, "deleted", TEN_DAYS_AGO, {
      execution: {
        ownerMachineId: linkedMachine,
        executionMachineId: linkedMachine,
        epoch: 1,
        history: [],
      },
    }),
    ...threadHistory(ids.archived, 6, "archived", FORTY_DAYS_AGO),
    ...threadHistory(ids.recentlyArchived, 3, "archived", TEN_DAYS_AGO),
    ...threadHistory(ids.active, 4, "active", CREATED),
  ]) {
    yield* sink.write({ events: [event] });
  }
});

const streamSequences = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly sequence: number; readonly event_type: string }>`
      SELECT sequence, event_type FROM orchestration_events
      WHERE stream_id = ${threadId} ORDER BY sequence
    `;
    return rows;
  });

const rowsFor = (table: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`,
      [threadId],
    );
    return rows[0]?.count ?? 0;
  });

/** What the UI reads of a thread: its shell and its whole projection. */
const threadView = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const shell = yield* store.getThreadShell(threadId);
    const projection = yield* store.getThreadProjection(threadId);
    return JSON.stringify({ shell, projection });
  });

const maxSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly max: number }>`
    SELECT MAX(sequence) AS max FROM orchestration_events
  `;
  return rows[0]?.max ?? 0;
});

/** Each test gets its own in-memory database. */
const fresh = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerTest>>) =>
  effect.pipe(Effect.provide(layerTest));

describe("thread history retention", () => {
  it.effect(
    "keeps a deleted thread's rows while a fork reads its history from them, and purges it after the fork",
    () =>
      fresh(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const sql = yield* SqlClient.SqlClient;
          const source = ThreadId.make("thread:retention:fork-source");
          const fork = ThreadId.make("thread:retention:fork");
          const runId = RunId.make("run:retention:fork-source");
          const nodeId = NodeId.make("node:retention:fork-source");
          const sourceThread = makeThread(source);
          const forkThread = makeThread(fork, {
            lineage: { parentThreadId: source, relationshipToParent: "fork", rootThreadId: source },
            forkedFrom: { type: "run", threadId: source, runId },
          });
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: eventId("created"),
              type: "thread.created",
              threadId: source,
              providerInstanceId,
              occurredAt: CREATED,
              payload: sourceThread,
            },
            {
              id: eventId("run"),
              type: "run.updated",
              threadId: source,
              runId,
              nodeId,
              driver: ProviderDriverKind.make("codex"),
              occurredAt: CREATED,
              payload: {
                id: runId,
                threadId: source,
                ordinal: 1,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make("message:retention:fork-source"),
                rootNodeId: nodeId,
                activeAttemptId: null,
                status: "completed",
                requestedAt: CREATED,
                startedAt: CREATED,
                completedAt: CREATED,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            ...[0, 1, 2].map((ordinal): OrchestrationV2DomainEvent => ({
              id: eventId("item"),
              type: "turn-item.updated",
              threadId: source,
              occurredAt: CREATED,
              payload: {
                id: TurnItemId.make(`turn-item:retention:fork-source:${ordinal}`),
                threadId: source,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: CREATED,
                completedAt: CREATED,
                updatedAt: CREATED,
                type: "assistant_message",
                messageId: MessageId.make(`message:retention:fork-source:item:${ordinal}`),
                text: `inherited ${ordinal}`,
                streaming: false,
              },
            })),
            {
              id: eventId("created"),
              type: "thread.created",
              threadId: fork,
              providerInstanceId,
              occurredAt: CREATED,
              payload: forkThread,
            },
            {
              id: eventId("deleted"),
              type: "thread.deleted",
              threadId: source,
              providerInstanceId,
              occurredAt: TEN_DAYS_AGO,
              payload: { ...sourceThread, deletedAt: TEN_DAYS_AGO, updatedAt: TEN_DAYS_AGO },
            },
          ];
          for (const event of events) yield* sink.write({ events: [event] });

          const forkView = yield* threadView(fork);
          const inherited = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
            fork,
          )).visibleTurnItems.filter((row) => row.sourceThreadId === source);
          assert.isAbove(inherited.length, 0);

          const first = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
          });
          assert.equal(first.purgedThreadCount, 0);
          assert.equal(first.compactedThreadCount, 1);
          assert.equal(first.skipped.forkSource, 1);
          // The source lost its events, not the rows the fork reads.
          assert.deepEqual(
            (yield* streamSequences(source)).map((row) => row.event_type),
            ["thread.created", "thread.deleted"],
          );
          assert.equal(yield* rowsFor("orchestration_v2_projection_runs", source), 1);
          assert.equal(yield* rowsFor("orchestration_v2_projection_turn_items", source), 3);
          assert.strictEqual(yield* threadView(fork), forkView);
          // A rebuild keeps the source's rows too.
          assert.isTrue(
            (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
          );
          assert.strictEqual(yield* threadView(fork), forkView);

          // Once the fork is deleted and purged itself, the source goes on the next pass.
          yield* sink.write({
            events: [
              {
                id: eventId("deleted"),
                type: "thread.deleted",
                threadId: fork,
                providerInstanceId,
                occurredAt: TEN_DAYS_AGO,
                payload: { ...forkThread, deletedAt: TEN_DAYS_AGO, updatedAt: TEN_DAYS_AGO },
              },
            ],
          });
          const second = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
          });
          assert.equal(second.purgedThreadCount, 1);
          assert.equal(second.skipped.forkSource, 1);
          const third = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
          });
          assert.equal(third.purgedThreadCount, 1);
          assert.equal(third.skipped.forkSource, 0);
          for (const table of ThreadHistoryRetention.PURGED_THREAD_TABLES) {
            assert.equal(yield* rowsFor(table, source), 0, table);
          }
          const markers = yield* sql<{ readonly thread_id: string; readonly kind: string }>`
            SELECT thread_id, kind FROM orchestration_v2_thread_history_compactions
            ORDER BY thread_id
          `;
          assert.deepEqual(markers, [
            { thread_id: fork, kind: "deleted" },
            { thread_id: source, kind: "deleted" },
          ]);
        }),
      ),
  );

  it.effect("bounds each event delete by payload bytes as well as rows", () =>
    Effect.gen(function* () {
      /** Writes a pass makes (each one asks the gate) for a deleted thread of six items. */
      const writesFor = (text: string) =>
        fresh(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const threadId = ThreadId.make("thread:retention:bytes");
            const thread = makeThread(threadId);
            const events: Array<OrchestrationV2DomainEvent> = [
              {
                id: eventId("created"),
                type: "thread.created",
                threadId,
                providerInstanceId,
                occurredAt: CREATED,
                payload: thread,
              },
              ...[0, 1, 2, 3, 4, 5].map((ordinal): OrchestrationV2DomainEvent => ({
                id: eventId("item"),
                type: "turn-item.updated",
                threadId,
                occurredAt: CREATED,
                payload: {
                  id: TurnItemId.make(`turn-item:retention:bytes:${ordinal}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  status: "completed",
                  title: null,
                  startedAt: CREATED,
                  completedAt: CREATED,
                  updatedAt: CREATED,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:retention:bytes:${ordinal}`),
                  text,
                  streaming: false,
                },
              })),
              {
                id: eventId("deleted"),
                type: "thread.deleted",
                threadId,
                providerInstanceId,
                occurredAt: TEN_DAYS_AGO,
                payload: { ...thread, deletedAt: TEN_DAYS_AGO, updatedAt: TEN_DAYS_AGO },
              },
            ];
            for (const event of events) yield* sink.write({ events: [event] });
            let writes = 0;
            const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
              policy: POLICY,
              nowMs: NOW_MS,
              mayDelete: () => {
                writes += 1;
                return true;
              },
            });
            assert.equal(result.purgedThreadCount, 1);
            assert.equal(result.deletedEventCount, 6);
            return writes;
          }),
        );
      const small = yield* writesFor("small");
      // 1.5 MB each: two fit the 4 MB bound, so six take three deletes instead of one.
      const large = yield* writesFor("L".repeat(1_500_000));
      assert.equal(large - small, 2);
    }),
  );

  it.effect("does nothing while off", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const before = yield* streamSequences(ids.deleted);
        const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy: ThreadHistoryRetention.RETENTION_OFF,
          nowMs: NOW_MS,
        });
        assert.equal(result.purgedThreadCount + result.compactedThreadCount, 0);
        assert.deepEqual(yield* streamSequences(ids.deleted), before);
      }),
    ),
  );

  it.effect(
    "purges old deleted threads to a tombstone and compacts old archived ones; the dry run counts the same",
    () =>
      fresh(
        Effect.gen(function* () {
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          const sql = yield* SqlClient.SqlClient;
          yield* writeFixture;
          const views = {
            archived: yield* threadView(ids.archived),
            active: yield* threadView(ids.active),
            recentlyArchived: yield* threadView(ids.recentlyArchived),
            linked: yield* threadView(ids.linked),
          };
          const untouched = {
            recentlyDeleted: yield* streamSequences(ids.recentlyDeleted),
            linked: yield* streamSequences(ids.linked),
            recentlyArchived: yield* streamSequences(ids.recentlyArchived),
            active: yield* streamSequences(ids.active),
          };
          const lastSequence = yield* maxSequence;
          const threadIdsBefore = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id
        `;

          const dryRun = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
            dryRun: true,
          });
          assert.equal(yield* maxSequence, lastSequence);
          assert.equal((yield* streamSequences(ids.deleted)).length, 1 + 6 * 3 + 1);

          const removed: Array<string> = [];
          const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
            batchSize: 4,
            removeAttachments: (attachmentIds) => Effect.sync(() => removed.push(...attachmentIds)),
          });
          assert.isFalse(result.interrupted);
          assert.equal(result.purgedThreadCount, 1);
          assert.equal(result.compactedThreadCount, 1);
          assert.deepEqual(result.skipped, { linked: 1, busy: 0, legacy: 0, forkSource: 0 });
          // Dry-run accuracy: the same threads, events and rows.
          assert.equal(dryRun.purgedThreadCount, result.purgedThreadCount);
          assert.equal(dryRun.compactedThreadCount, result.compactedThreadCount);
          assert.equal(dryRun.deletedEventCount, result.deletedEventCount);
          assert.deepEqual(dryRun.deletedRowsByTable, result.deletedRowsByTable);
          assert.isAbove(dryRun.estimatedBytes.low, 0);
          assert.isAtLeast(dryRun.estimatedBytes.high, dryRun.estimatedBytes.low);
          // 6 rounds x 3 snapshots each, for both threads: everything but creation and the lifecycle event.
          assert.equal(result.deletedEventCount, 18 + 18);
          assert.deepEqual(removed, ["file_threadretentiondeleted"]);

          // The deleted thread keeps a tombstone: its row, creation and deletion.
          assert.deepEqual(
            (yield* streamSequences(ids.deleted)).map((row) => row.event_type),
            ["thread.created", "thread.deleted"],
          );
          const tombstone = yield* sql<{ readonly deleted_at: string | null }>`
          SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${ids.deleted}
        `;
          assert.equal(tombstone[0]?.deleted_at, DateTime.formatIso(TEN_DAYS_AGO));
          for (const table of ThreadHistoryRetention.PURGED_THREAD_TABLES) {
            assert.equal(yield* rowsFor(table, ids.deleted), 0, table);
          }
          // Thread ids (the update helper's identity proof) and the log's end are unchanged.
          assert.deepEqual(
            yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id
          `,
            threadIdsBefore,
          );
          assert.equal(yield* maxSequence, lastSequence);

          // The archived thread lost its events but reads exactly as before.
          assert.deepEqual(
            (yield* streamSequences(ids.archived)).map((row) => row.event_type),
            ["thread.created", "thread.archived"],
          );
          assert.strictEqual(yield* threadView(ids.archived), views.archived);

          // Young, linked and active threads are untouched.
          assert.deepEqual(yield* streamSequences(ids.recentlyDeleted), untouched.recentlyDeleted);
          assert.deepEqual(yield* streamSequences(ids.linked), untouched.linked);
          assert.deepEqual(
            yield* streamSequences(ids.recentlyArchived),
            untouched.recentlyArchived,
          );
          assert.deepEqual(yield* streamSequences(ids.active), untouched.active);
          assert.isAbove(yield* rowsFor("orchestration_v2_projection_turn_items", ids.linked), 0);

          // Markers, and a client resuming from before them takes a snapshot.
          const markers = yield* sql<{ readonly thread_id: string; readonly kind: string }>`
          SELECT thread_id, kind FROM orchestration_v2_thread_history_compactions ORDER BY thread_id
        `;
          assert.deepEqual(markers, [
            { thread_id: ids.archived, kind: "archived" },
            { thread_id: ids.deleted, kind: "deleted" },
          ]);
          const events = yield* OrchestrationEventStore.OrchestrationEventStore.pipe(
            Effect.provide(OrchestrationEventStore.layer),
          );
          assert.isTrue(
            yield* events.threadHistoryCompactedAfter({ threadId: ids.archived, afterSequence: 0 }),
          );
          assert.isFalse(
            yield* events.threadHistoryCompactedAfter({
              threadId: ids.archived,
              afterSequence: lastSequence,
            }),
          );
          assert.isFalse(
            yield* events.threadHistoryCompactedAfter({ threadId: ids.active, afterSequence: 0 }),
          );

          // Verify still holds, and a rebuild from the log yields the same thread views.
          assert.isTrue((yield* maintenance.verify).valid);
          const rebuilt = yield* maintenance.rebuild;
          assert.isTrue(rebuilt.valid);
          assert.strictEqual(yield* threadView(ids.archived), views.archived);
          assert.strictEqual(yield* threadView(ids.active), views.active);
          assert.strictEqual(yield* threadView(ids.recentlyArchived), views.recentlyArchived);
          assert.strictEqual(yield* threadView(ids.linked), views.linked);
          for (const table of ThreadHistoryRetention.PURGED_THREAD_TABLES) {
            assert.equal(yield* rowsFor(table, ids.deleted), 0, table);
          }
          assert.equal(
            (yield* sql<{ readonly deleted_at: string | null }>`
            SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${ids.deleted}
          `)[0]?.deleted_at,
            DateTime.formatIso(TEN_DAYS_AGO),
          );

          // A second pass has nothing left to do.
          const again = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: POLICY,
            nowMs: NOW_MS,
          });
          assert.equal(again.purgedThreadCount + again.compactedThreadCount, 0);
          assert.equal(again.deletedEventCount, 0);
        }),
      ),
  );

  it.effect("later events of a compacted thread still replay on top of its kept rows", () =>
    fresh(
      Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:retention:revived");
        for (const event of threadHistory(threadId, 4, "archived", FORTY_DAYS_AGO)) {
          yield* sink.write({ events: [event] });
        }
        const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy: { deletedAfterDays: null, archivedAfterDays: 30, historyDays: null },
          nowMs: NOW_MS,
        });
        assert.equal(result.compactedThreadCount, 1);
        // Unarchived and renamed after the compaction.
        const thread = makeThread(threadId);
        yield* sink.write({
          events: [
            {
              id: eventId("unarchived"),
              type: "thread.unarchived",
              threadId,
              providerInstanceId,
              occurredAt: TWO_DAYS_AGO,
              payload: {
                ...thread,
                title: "Back again",
                archivedAt: null,
                updatedAt: TWO_DAYS_AGO,
              },
            },
          ],
        });
        const live = yield* threadView(threadId);
        assert.include(live, "Back again");
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.strictEqual(yield* threadView(threadId), live);
      }),
    ),
  );

  it.effect("stops before its first delete while an update holds the database", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const before = yield* streamSequences(ids.deleted);
        let checks = 0;
        const refused = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy: POLICY,
          nowMs: NOW_MS,
          shouldContinue: Effect.sync(() => {
            checks += 1;
            return false;
          }),
        });
        assert.isTrue(refused.interrupted);
        assert.equal(checks, 1);
        assert.equal(refused.deletedEventCount, 0);
        assert.deepEqual(yield* streamSequences(ids.deleted), before);

        // The synchronous check inside the transaction refuses too.
        const gated = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy: POLICY,
          nowMs: NOW_MS,
          mayDelete: () => false,
        });
        assert.isTrue(gated.interrupted);
        assert.equal(gated.deletedEventCount, 0);
        assert.deepEqual(yield* streamSequences(ids.deleted), before);
        const sql = yield* SqlClient.SqlClient;
        const markers = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions`;
        assert.equal(markers[0]?.count, 0);
      }),
    ),
  );
  it.effect("resumes a purge a closed update gate stopped half-way instead of skipping it", () =>
    fresh(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:retention:resumed");
        const renderId = createAttachmentId(threadId, "html")!;
        const toolItem = (ordinal: number, toolName: string, output: unknown) =>
          ({
            id: eventId("tool"),
            type: "turn-item.updated",
            threadId,
            occurredAt: CREATED,
            payload: {
              id: TurnItemId.make(`turn-item:${threadId}:tool:${ordinal}`),
              type: "dynamic_tool",
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 100 + ordinal,
              status: "completed",
              title: null,
              toolName,
              input: {},
              output,
              startedAt: CREATED,
              completedAt: CREATED,
              updatedAt: CREATED,
            },
          }) as OrchestrationV2DomainEvent;
        const history = threadHistory(threadId, 6, "deleted", TEN_DAYS_AGO);
        // Tool items before the deletion: ordinary tools around one HTML render.
        history.splice(
          history.length - 1,
          0,
          toolItem(1, "mcp__test__search", { text: "x".repeat(4_000) }),
          toolItem(2, "mcp__test__search", { text: "y".repeat(4_000) }),
          toolItem(3, "mcp__studio-code__html_render", [
            {
              type: "text",
              text: JSON.stringify({
                htmlRender: { attachmentId: renderId, title: "page", height: 300 },
              }),
            },
          ]),
        );
        for (const event of history) yield* sink.write({ events: [event] });
        const policy = { deletedAfterDays: 7, archivedAfterDays: null, historyDays: null } as const;
        const marker = sql<{ readonly completed_at: string | null }>`
          SELECT completed_at FROM orchestration_v2_thread_history_compactions
          WHERE thread_id = ${threadId}
        `;

        // The gate closes after a few checks: the marker is written, some events go.
        let checks = 0;
        const removed: Array<string> = [];
        const stopped = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy,
          nowMs: NOW_MS,
          batchSize: 2,
          shouldContinue: Effect.sync(() => (checks += 1) <= 8),
          removeAttachments: (attachmentIds) => Effect.sync(() => removed.push(...attachmentIds)),
        });
        assert.isTrue(stopped.interrupted);
        assert.equal(stopped.purgedThreadCount, 0);
        assert.isAbove(stopped.deletedEventCount, 0);
        // Pages of two rows each still find every attachment: the message's and the render's.
        assert.sameMembers(removed, [`file_${"threadretentionresumed"}`, renderId]);
        assert.deepEqual(yield* marker, [{ completed_at: null }]);
        const left = yield* streamSequences(threadId);
        assert.isAbove(left.length, 2);

        // The next pass resumes it to the tombstone and marks it complete.
        const resumed = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy,
          nowMs: NOW_MS,
        });
        assert.isFalse(resumed.interrupted);
        assert.equal(resumed.purgedThreadCount, 1);
        assert.equal(resumed.deletedEventCount, left.length - 2);
        assert.deepEqual(
          (yield* streamSequences(threadId)).map((row) => row.event_type),
          ["thread.created", "thread.deleted"],
        );
        for (const table of ThreadHistoryRetention.PURGED_THREAD_TABLES) {
          assert.equal(yield* rowsFor(table, threadId), 0, table);
        }
        assert.isNotNull((yield* marker)[0]?.completed_at);

        // Only now is it done.
        const again = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy,
          nowMs: NOW_MS,
        });
        assert.equal(again.purgedThreadCount, 0);
        assert.equal(again.deletedEventCount, 0);
      }),
    ),
  );

  describe("history horizon", () => {
    const HORIZON = { deletedAfterDays: null, archivedAfterDays: null, historyDays: 7 } as const;
    const DAY_MS = 24 * 60 * 60_000;
    const at = (ms: number) => DateTime.makeUnsafe(ms);
    const prompt = "Look through the storage code and report.\n".repeat(200);
    const subagent = (
      threadId: ThreadId,
      occurredAt: DateTime.Utc,
      status: "running" | "completed",
    ) =>
      ({
        id: eventId("subagent"),
        type: "subagent.updated",
        threadId,
        occurredAt,
        payload: {
          id: NodeId.make(`subagent:${threadId}`),
          threadId,
          runId: null,
          providerThreadId: null,
          parentNodeId: NodeId.make(`node:${threadId}:0`),
          createdBy: "agent",
          nativeTaskRef: null,
          model: null,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          childThreadId: null,
          prompt,
          title: "Inspect storage",
          status,
          result: status === "completed" ? "done" : null,
          startedAt: occurredAt,
          completedAt: status === "completed" ? occurredAt : null,
          updatedAt: occurredAt,
        },
      }) as OrchestrationV2DomainEvent;
    /** Rounds ten days ago, a subagent started then, and rounds plus its end two days ago. */
    const writeLongThread = (threadId: ThreadId, extra: Partial<OrchestrationV2AppThread> = {}) =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const old = threadHistory(threadId, 5, "active", TEN_DAYS_AGO, extra).map((event, index) =>
          index === 0 ? event : { ...event, occurredAt: TEN_DAYS_AGO },
        );
        const recent = threadHistory(threadId, 3, "active", TWO_DAYS_AGO, extra)
          .slice(1)
          .map((event) => ({ ...event, occurredAt: TWO_DAYS_AGO }));
        for (const event of [
          ...old,
          subagent(threadId, TEN_DAYS_AGO, "running"),
          ...recent,
          subagent(threadId, TWO_DAYS_AGO, "completed"),
        ]) {
          yield* sink.write({ events: [event] });
        }
      });

    it.effect(
      "folds a live thread's events older than the horizon; its view, rebuild, resume and prompts hold",
      () =>
        fresh(
          Effect.gen(function* () {
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            const sql = yield* SqlClient.SqlClient;
            const threadId = ThreadId.make("thread:retention:horizon");
            const youngId = ThreadId.make("thread:retention:young");
            const linkedId = ThreadId.make("thread:retention:horizon-linked");
            yield* writeLongThread(threadId);
            yield* writeLongThread(linkedId, {
              execution: {
                ownerMachineId: EnvironmentId.make("machine-elsewhere"),
                executionMachineId: EnvironmentId.make("machine-elsewhere"),
                epoch: 1,
                history: [],
              },
            });
            const sink = yield* EventSink.EventSinkV2;
            for (const event of threadHistory(youngId, 3, "active", TWO_DAYS_AGO, {
              createdAt: TWO_DAYS_AGO,
            }).map((event) => ({ ...event, occurredAt: TWO_DAYS_AGO }))) {
              yield* sink.write({ events: [event] });
            }
            const view = yield* threadView(threadId);
            const before = yield* streamSequences(threadId);
            const untouched = {
              young: yield* streamSequences(youngId),
              linked: yield* streamSequences(linkedId),
              youngView: yield* threadView(youngId),
            };
            const anchor = (yield* sql<{ readonly sequence: number }>`
              SELECT sequence FROM orchestration_events
              WHERE stream_id = ${threadId} AND event_type = 'subagent.updated'
              ORDER BY sequence LIMIT 1
            `)[0]?.sequence;
            const references = yield* sql<{ readonly anchor: number | null }>`
              SELECT json_extract(payload_json, '$.promptSequence') AS anchor
              FROM orchestration_events
              WHERE stream_id = ${threadId} AND event_type = 'subagent.updated'
              ORDER BY sequence DESC LIMIT 1
            `;
            // The newer snapshot names the older one as its prompt.
            assert.equal(references[0]?.anchor, anchor);

            const dryRun = yield* ThreadHistoryRetention.runThreadHistoryRetention({
              policy: HORIZON,
              nowMs: NOW_MS,
              dryRun: true,
            });
            assert.deepEqual(yield* streamSequences(threadId), before);
            const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
              policy: HORIZON,
              nowMs: NOW_MS,
              batchSize: 3,
            });
            assert.isFalse(result.interrupted);
            assert.equal(result.foldedThreadCount, 1);
            assert.equal(dryRun.foldedThreadCount, 1);
            assert.equal(dryRun.deletedEventCount, result.deletedEventCount);
            assert.equal(result.skipped.linked, 1);
            // 5 old rounds of 3 snapshots go; creation and the prompt anchor stay.
            assert.equal(result.deletedEventCount, 15);
            const after = yield* streamSequences(threadId);
            assert.deepEqual(
              after.slice(0, 2).map((row) => row.sequence),
              [before[0]?.sequence, anchor],
            );
            assert.deepEqual(
              after.slice(2),
              before.filter((row) => row.sequence > (anchor ?? 0)),
            );
            // What the user sees is unchanged, and so are young and linked threads.
            assert.strictEqual(yield* threadView(threadId), view);
            assert.deepEqual(yield* streamSequences(youngId), untouched.young);
            assert.deepEqual(yield* streamSequences(linkedId), untouched.linked);
            assert.strictEqual(yield* threadView(youngId), untouched.youngView);

            // A thread replay still restores the kept snapshot's prompt from its anchor.
            const events = yield* OrchestrationEventStore.OrchestrationEventStore.pipe(
              Effect.provide(OrchestrationEventStore.layer),
            );
            const replay = yield* events.readAgentEvents({ threadId }).pipe(Stream.runCollect);
            const subagents = Array.from(replay).filter(
              (row) => row.event.type === "subagent.updated",
            );
            assert.equal(subagents.length, 2);
            for (const row of subagents) {
              assert.equal((row.event.payload as { readonly prompt: string }).prompt, prompt);
            }
            // A client resuming from before the fold takes a snapshot; one after it replays.
            const marker = yield* sql<{
              readonly kind: string;
              readonly through_sequence: number;
              readonly completed_at: string | null;
            }>`
              SELECT kind, through_sequence, completed_at
              FROM orchestration_v2_thread_history_compactions WHERE thread_id = ${threadId}
            `;
            assert.equal(marker[0]?.kind, "horizon");
            assert.isNotNull(marker[0]?.completed_at);
            const through = marker[0]?.through_sequence ?? 0;
            assert.isTrue(
              yield* events.threadHistoryCompactedAfter({ threadId, afterSequence: 0 }),
            );
            assert.isFalse(
              yield* events.threadHistoryCompactedAfter({ threadId, afterSequence: through }),
            );
            // The application shell stream checks every thread's marker the same way.
            assert.isTrue(yield* events.historyCompactedAfter(0));
            assert.isTrue(yield* events.historyCompactedAfter(through - 1));
            assert.isFalse(yield* events.historyCompactedAfter(through));

            // Verify and a rebuild from the log give the same views.
            assert.isTrue((yield* maintenance.verify).valid);
            assert.isTrue((yield* maintenance.rebuild).valid);
            assert.strictEqual(yield* threadView(threadId), view);
            assert.strictEqual(yield* threadView(youngId), untouched.youngView);

            // Folded a moment ago: the next pass does not read it again.
            const again = yield* ThreadHistoryRetention.runThreadHistoryRetention({
              policy: HORIZON,
              nowMs: NOW_MS + 60_000,
            });
            assert.equal(again.foldedThreadCount, 0);
            assert.equal(again.deletedEventCount, 0);

            // New work, then a week later: the fold moves forward and the view still holds.
            const thread = makeThread(threadId);
            yield* sink.write({
              events: [
                {
                  id: eventId("renamed"),
                  type: "thread.metadata-updated",
                  threadId,
                  providerInstanceId,
                  occurredAt: at(NOW_MS),
                  payload: { ...thread, title: "Renamed later", updatedAt: at(NOW_MS) },
                },
              ],
            });
            const renamed = yield* threadView(threadId);
            assert.include(renamed, "Renamed later");
            const later = yield* ThreadHistoryRetention.runThreadHistoryRetention({
              policy: HORIZON,
              nowMs: NOW_MS + 9 * DAY_MS,
            });
            // The young thread's history is past the horizon now too.
            assert.equal(later.foldedThreadCount, 2);
            assert.strictEqual(yield* threadView(youngId), untouched.youngView);
            const moved = yield* sql<{ readonly through_sequence: number }>`
              SELECT through_sequence FROM orchestration_v2_thread_history_compactions
              WHERE thread_id = ${threadId}
            `;
            assert.isAbove(moved[0]?.through_sequence ?? 0, through);
            // Nothing is left but creation and the stream's newest event.
            assert.deepEqual(
              (yield* streamSequences(threadId)).map((row) => row.event_type),
              ["thread.created", "thread.metadata-updated"],
            );
            assert.strictEqual(yield* threadView(threadId), renamed);
            assert.isTrue((yield* maintenance.rebuild).valid);
            assert.strictEqual(yield* threadView(threadId), renamed);
          }),
        ),
    );

    it.effect("never folds while the update gate is closed or the time budget is spent", () =>
      fresh(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make("thread:retention:horizon-gated");
          yield* writeLongThread(threadId);
          const before = yield* streamSequences(threadId);
          const gated = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: HORIZON,
            nowMs: NOW_MS,
            mayDelete: () => false,
          });
          assert.isTrue(gated.interrupted);
          assert.isFalse(gated.budgetExhausted);
          const spent = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: HORIZON,
            nowMs: NOW_MS,
            timeBudgetMs: 0,
          });
          assert.isTrue(spent.interrupted);
          assert.isTrue(spent.budgetExhausted);
          assert.deepEqual(yield* streamSequences(threadId), before);
          const markers = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions
          `;
          assert.equal(markers[0]?.count, 0);

          // A fold stopped half-way is resumed by the next pass, then done.
          let writes = 0;
          const stopped = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: HORIZON,
            nowMs: NOW_MS,
            batchSize: 2,
            mayDelete: () => (writes += 1) <= 3,
          });
          assert.isTrue(stopped.interrupted);
          assert.isAbove(stopped.deletedEventCount, 0);
          const resumed = yield* ThreadHistoryRetention.runThreadHistoryRetention({
            policy: HORIZON,
            nowMs: NOW_MS,
          });
          assert.equal(resumed.foldedThreadCount, 1);
          assert.equal(stopped.deletedEventCount + resumed.deletedEventCount, 15);
        }),
      ),
    );
  });
});
