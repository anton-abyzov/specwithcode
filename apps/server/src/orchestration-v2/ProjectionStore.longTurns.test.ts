import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  threadHistoryCursorBoundsLongTurns,
  WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const createThread = Effect.fn("createThread")(function* (
  threadId: ThreadId,
  forkedFrom: { readonly threadId: ThreadId; readonly runId: RunId } | null,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* projectionStore.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:long-turns"),
      title: String(threadId),
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        forkedFrom === null
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
          : {
              parentThreadId: forkedFrom.threadId,
              relationshipToParent: "fork",
              rootThreadId: forkedFrom.threadId,
            },
      forkedFrom: forkedFrom === null ? null : { type: "run", ...forkedFrom },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const putRun = Effect.fn("putRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: "completed" | "rolled_back";
}) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`node:${input.runId}`);
  yield* projectionStore.apply({
    id: EventId.make(`event:${input.runId}:${input.status}`),
    type: input.status === "completed" ? "run.created" : "run.updated",
    threadId: input.threadId,
    runId: input.runId,
    nodeId,
    driver,
    occurredAt: now,
    payload: {
      id: input.runId,
      threadId: input.threadId,
      ordinal: input.ordinal,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${input.runId}:prompt`),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: input.status,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
});

/**
 * One user turn: a prompt and `steps` command rows, all in `runId`. Without
 * a prompt the run is agent work only. `interrupts` puts a stop request and
 * its result at those row indexes.
 */
const insertTurn = Effect.fn("insertTurn")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly firstOrdinal: number;
  readonly steps: number;
  readonly prompt?: boolean;
  readonly interrupts?: ReadonlyArray<number>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const rows = Array.from({ length: input.steps + 1 }, (_, index) => {
    const id = `item:${input.runId}:${index}`;
    const ordinal = input.firstOrdinal + index;
    const base = {
      id,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: nowIso,
      completedAt: nowIso,
      updatedAt: nowIso,
    };
    const interrupt = input.interrupts?.flatMap((at) =>
      index === at
        ? ["run_interrupt_request" as const]
        : index === at + 1
          ? ["run_interrupt_result" as const]
          : [],
    )[0];
    const item =
      interrupt !== undefined
        ? { ...base, type: interrupt, message: "Stopped to steer" }
        : index === 0 && input.prompt !== false
          ? {
              ...base,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              messageId: `message:${input.runId}:prompt`,
              inputIntent: "turn_start",
              text: `Prompt for ${input.runId}`,
              attachments: [],
            }
          : {
              ...base,
              type: "command_execution",
              input: `step ${index}`,
              output: "x".repeat(512),
              exitCode: 0,
            };
    return {
      turn_item_id: id,
      thread_id: input.threadId,
      run_id: input.runId,
      node_id: null,
      provider_thread_id: null,
      provider_turn_id: null,
      parent_item_id: null,
      ordinal,
      type: item.type,
      status: "completed",
      updated_at: nowIso,
      payload_json: encodeUnknownJsonString(item),
    };
  });
  for (let start = 0; start < rows.length; start += 500) {
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows.slice(start, start + 500))}`;
  }
});

const keyOf = (row: { readonly sourceThreadId: string; readonly sourceItemId: string }) =>
  `${row.sourceThreadId}:${row.sourceItemId}`;

/**
 * Pages a thread the way the HTTP routes do: a bounded snapshot, then history
 * pages from each cursor until none is left.
 */
const pageWholeThread = Effect.fn("pageWholeThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly boundLongTurns: boolean;
  /** Runs between the snapshot and the first history page. */
  readonly afterSnapshot?: ReturnType<typeof putRun>;
}) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const initial = yield* projectionStore.getThreadSnapshotWindow(input.threadId, {
    rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
    userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
    boundLongTurns: input.boundLongTurns,
  });
  const bounded = buildBoundedThreadProjection({
    projection: initial.projection,
    snapshotSequence: initial.snapshotSequence,
    latestUserTurnStart: initial.latestUserTurnStart,
    olderRowsUnloaded: initial.olderRowsUnloaded,
    policy: input.boundLongTurns
      ? THREAD_HISTORY_PAGE_POLICY
      : WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY,
  });
  const snapshotKeys = bounded.projection.visibleTurnItems.map(keyOf);
  const pages: Array<{ readonly keys: ReadonlyArray<string>; readonly bytes: number }> = [];
  if (input.afterSnapshot !== undefined) yield* input.afterSnapshot;
  let cursor = bounded.historyCursor;
  while (cursor !== null) {
    assert.isBelow(pages.length, 1_000);
    const anchor = decodeThreadHistoryCursor(cursor);
    const window = yield* projectionStore.getThreadSnapshotWindow(input.threadId, {
      rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
      userTurnLimit: OLDER_THREAD_USER_TURN_LIMIT,
      anchorItemId: TurnItemId.make(anchor.si),
      anchorThreadId: ThreadId.make(anchor.st),
      boundLongTurns: threadHistoryCursorBoundsLongTurns(anchor),
    });
    const page = selectHistoryPageFromCursor({
      items: window.projection.visibleTurnItems,
      cursor,
      snapshotSequence: window.snapshotSequence,
      olderRowsUnloaded: window.olderRowsUnloaded,
    });
    pages.push({
      keys: page.items.map(keyOf),
      bytes: Buffer.byteLength(JSON.stringify(page.items), "utf8"),
    });
    cursor = page.nextCursor;
  }
  // Older pages go above the snapshot, newest page last.
  const loaded = [...pages.toReversed().flatMap((page) => page.keys), ...snapshotKeys];
  return { bounded, pages, loaded };
});

it.layer(layerTest)("ProjectionStoreV2 long turns", (it) => {
  it.effect(
    "retains an old pending question outside the history page and releases it after answering",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:old-restored-question");
        const oldRun = RunId.make("run:old-question");
        const newRun = RunId.make("run:new-work");
        yield* createThread(threadId, null);
        yield* putRun({ threadId, runId: oldRun, ordinal: 687, status: "completed" });
        yield* insertTurn({ threadId, runId: oldRun, firstOrdinal: 687000001, steps: 2 });
        yield* putRun({ threadId, runId: newRun, ordinal: 699, status: "completed" });
        yield* insertTurn({ threadId, runId: newRun, firstOrdinal: 699000001, steps: 1000 });
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make(`${"update-reopen:".repeat(10)}ask-user:relay`);
        yield* store.apply({
          id: EventId.make("event:old-question:request"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make("node:old-question"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const card = {
          id: "card:old-question",
          threadId,
          runId: oldRun,
          nodeId: NodeId.make("node:old-question"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 687000029,
          status: "waiting",
          title: null,
          startedAt: DateTime.formatIso(now),
          completedAt: null,
          updatedAt: DateTime.formatIso(now),
          type: "user_input_request",
          requestId,
          responseMode: "message",
          questions: [
            {
              id: "q1",
              header: "Owner relay",
              question: "Can you relay the existing owner request?",
              options: [],
              allowCustomAnswer: true,
            },
          ],
        };
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({ turn_item_id: card.id, thread_id: threadId, run_id: oldRun, node_id: card.nodeId, provider_thread_id: null, provider_turn_id: null, parent_item_id: null, ordinal: 687000029, type: card.type, status: card.status, updated_at: card.updatedAt, payload_json: encodeUnknownJsonString(card) })}`;
        const read = () =>
          store.getThreadSnapshotWindow(threadId, {
            rowLimit: 20,
            userTurnLimit: 1,
            boundLongTurns: true,
          });
        const first = yield* read();
        assert.isTrue(
          first.projection.runtimeRequests.some(
            (r) => r.id === requestId && r.status === "pending",
          ),
        );
        assert.isTrue(
          first.projection.turnItems.some(
            (i) =>
              i.id === card.id &&
              i.type === "user_input_request" &&
              i.questions[0]?.question === card.questions[0]!.question,
          ),
        );
        assert.isFalse(first.projection.visibleTurnItems.some((r) => r.sourceItemId === card.id));
        assert.isAtMost(first.projection.visibleTurnItems.length, 20);
        const wire = buildBoundedThreadProjection({ ...first, projection: first.projection });
        assert.isTrue(
          wire.projection.turnItems.some(
            (i) =>
              i.id === card.id &&
              i.type === "user_input_request" &&
              i.questions[0]?.question === card.questions[0]!.question,
          ),
        );
        assert.isFalse(wire.projection.visibleTurnItems.some((r) => r.sourceItemId === card.id));
        // An answer receipt can predate the retained page too. It must travel
        // with a restored pending copy so all request consumers can reject it.
        const originalId = RuntimeRequestId.make("ask-user:relay");
        yield* store.apply({
          id: EventId.make("event:old-question:answer"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: originalId,
            nodeId: NodeId.make("node:answer-outside-page"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "resolved",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: now,
            answers: { q1: "Relayed" },
          },
        });
        const answered = yield* read();
        assert.isTrue(
          answered.projection.runtimeRequests.some(
            (r) => r.id === originalId && r.answers?.q1 === "Relayed",
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved', payload_json=json_set(payload_json,'$.status','resolved') WHERE runtime_request_id=${requestId}`;
        const settled = yield* read();
        assert.isFalse(settled.projection.turnItems.some((i) => i.id === card.id));
      }),
  );

  for (const boundLongTurns of [true, false]) {
    it.effect(
      `pages a fork whose source turn has 1,000 rows back to its first row (${boundLongTurns ? "bounded" : "whole"} turns)`,
      () =>
        Effect.gen(function* () {
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const mode = boundLongTurns ? "bounded" : "whole";
          const sourceThreadId = ThreadId.make(`thread:long-fork-source:${mode}`);
          const targetThreadId = ThreadId.make(`thread:long-fork-target:${mode}`);
          const earlierRunId = RunId.make(`run:long-fork:${mode}:earlier`);
          const discardedRunId = RunId.make(`run:long-fork:${mode}:discarded`);
          const forkRunId = RunId.make(`run:long-fork:${mode}:fork`);
          const localRunId = RunId.make(`run:long-fork:${mode}:local`);
          yield* createThread(sourceThreadId, null);
          yield* createThread(targetThreadId, { threadId: sourceThreadId, runId: forkRunId });
          yield* putRun({
            threadId: sourceThreadId,
            runId: earlierRunId,
            ordinal: 1,
            status: "completed",
          });
          yield* putRun({
            threadId: sourceThreadId,
            runId: discardedRunId,
            ordinal: 2,
            status: "completed",
          });
          yield* putRun({
            threadId: sourceThreadId,
            runId: discardedRunId,
            ordinal: 2,
            status: "rolled_back",
          });
          yield* putRun({
            threadId: sourceThreadId,
            runId: forkRunId,
            ordinal: 3,
            status: "completed",
          });
          yield* putRun({
            threadId: targetThreadId,
            runId: localRunId,
            ordinal: 1,
            status: "completed",
          });
          yield* insertTurn({
            threadId: sourceThreadId,
            runId: earlierRunId,
            firstOrdinal: 1,
            steps: 40,
          });
          // The source query keeps a rolled-back run's rows; the fork shows them too.
          yield* insertTurn({
            threadId: sourceThreadId,
            runId: discardedRunId,
            firstOrdinal: 100,
            steps: 30,
          });
          yield* insertTurn({
            threadId: sourceThreadId,
            runId: forkRunId,
            firstOrdinal: 200,
            steps: 999,
          });
          yield* insertTurn({
            threadId: targetThreadId,
            runId: localRunId,
            firstOrdinal: 1,
            steps: 10,
          });

          const full = yield* projectionStore.getThreadProjection(targetThreadId);
          const expected = full.visibleTurnItems.map(keyOf);
          assert.isAbove(expected.length, 1_000);

          const { pages, loaded } = yield* pageWholeThread({
            threadId: targetThreadId,
            boundLongTurns,
          });
          assert.strictEqual(new Set(loaded).size, loaded.length);
          assert.deepEqual(loaded, expected);
          if (boundLongTurns) {
            for (const page of pages) {
              assert.isAtMost(page.keys.length, THREAD_HISTORY_PAGE_POLICY.maxTurnItems);
              assert.isAtMost(page.bytes, THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
            }
          }
        }),
    );
  }

  it.effect("keeps an early stop request in a fork's window out of its paging", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:steer-fork-source");
      const targetThreadId = ThreadId.make("thread:steer-fork-target");
      const forkRunId = RunId.make("run:steer-fork:fork");
      const localRunId = RunId.make("run:steer-fork:local");
      yield* createThread(sourceThreadId, null);
      yield* createThread(targetThreadId, { threadId: sourceThreadId, runId: forkRunId });
      yield* putRun({
        threadId: sourceThreadId,
        runId: forkRunId,
        ordinal: 1,
        status: "completed",
      });
      yield* putRun({
        threadId: targetThreadId,
        runId: localRunId,
        ordinal: 1,
        status: "completed",
      });
      // A stop-and-steer early in the run and another inside the window.
      yield* insertTurn({
        threadId: sourceThreadId,
        runId: forkRunId,
        firstOrdinal: 1,
        steps: 999,
        interrupts: [10, 990],
      });
      yield* insertTurn({
        threadId: targetThreadId,
        runId: localRunId,
        firstOrdinal: 1,
        steps: 10,
      });

      const full = yield* projectionStore.getThreadProjection(targetThreadId);
      const { bounded, loaded } = yield* pageWholeThread({
        threadId: targetThreadId,
        boundLongTurns: true,
      });
      // The early request rides along as a turn item, not as a window row.
      assert.isFalse(
        bounded.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === `item:${forkRunId}:10`,
        ),
      );
      assert.strictEqual(new Set(loaded).size, loaded.length);
      assert.deepEqual(loaded, full.visibleTurnItems.map(keyOf));
    }),
  );

  it.effect("pages a fork of a fork through a middle segment at the row limit", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadA = ThreadId.make("thread:fork-chain:a");
      const threadB = ThreadId.make("thread:fork-chain:b");
      const threadC = ThreadId.make("thread:fork-chain:c");
      const runA = RunId.make("run:fork-chain:a");
      const runB = RunId.make("run:fork-chain:b");
      const runC = RunId.make("run:fork-chain:c");
      yield* createThread(threadA, null);
      yield* createThread(threadB, { threadId: threadA, runId: runA });
      yield* createThread(threadC, { threadId: threadB, runId: runB });
      yield* putRun({ threadId: threadA, runId: runA, ordinal: 1, status: "completed" });
      yield* putRun({ threadId: threadB, runId: runB, ordinal: 1, status: "completed" });
      yield* putRun({ threadId: threadC, runId: runC, ordinal: 1, status: "completed" });
      yield* insertTurn({ threadId: threadA, runId: runA, firstOrdinal: 1, steps: 20 });
      // Exactly the window's row limit of agent work, with no user turn.
      yield* insertTurn({
        threadId: threadB,
        runId: runB,
        firstOrdinal: 1,
        steps: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT - 1,
        prompt: false,
      });
      yield* insertTurn({ threadId: threadC, runId: runC, firstOrdinal: 1, steps: 10 });

      const full = yield* projectionStore.getThreadProjection(threadC);
      const expected = full.visibleTurnItems.map(keyOf);
      assert.isTrue(expected.includes(`${threadA}:item:${runA}:0`));
      for (const boundLongTurns of [true, false]) {
        const { loaded } = yield* pageWholeThread({ threadId: threadC, boundLongTurns });
        assert.strictEqual(new Set(loaded).size, loaded.length);
        assert.deepEqual(loaded, expected);
      }
    }),
  );

  it.effect("resumes below a cursor whose long run was rolled back", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:long-turn-rollback");
      const earlierRunId = RunId.make("run:long-turn-rollback:earlier");
      const longRunId = RunId.make("run:long-turn-rollback:long");
      yield* createThread(threadId, null);
      yield* putRun({ threadId, runId: earlierRunId, ordinal: 1, status: "completed" });
      yield* putRun({ threadId, runId: longRunId, ordinal: 2, status: "completed" });
      yield* insertTurn({ threadId, runId: earlierRunId, firstOrdinal: 1, steps: 120 });
      yield* insertTurn({ threadId, runId: longRunId, firstOrdinal: 1_000, steps: 1_500 });

      const { bounded, pages } = yield* pageWholeThread({
        threadId,
        boundLongTurns: true,
        afterSnapshot: putRun({ threadId, runId: longRunId, ordinal: 2, status: "rolled_back" }),
      });
      // The snapshot opened inside the long run, behind its prompt.
      assert.strictEqual(bounded.windowTurnStart?.sourceItemId, `item:${longRunId}:0`);
      const older = pages.toReversed().flatMap((page) => page.keys);
      assert.deepEqual(
        older,
        Array.from({ length: 121 }, (_, index) => `${threadId}:item:${earlierRunId}:${index}`),
      );
    }),
  );
});
