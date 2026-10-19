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
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn("createThread")(function* (suffix: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}`);
  yield* store.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:shell-cache"),
      title: `Thread ${suffix}`,
      providerInstanceId: modelSelection.instanceId,
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
  return threadId;
});

const sweepRead = { location: "active", maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } as const;

it.layer(layerTest)("shared shell snapshot for sweeps", (it) => {
  it.effect("returns what an exact read returns, and reuses it within the age", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* createThread("first");
      const shared = yield* store.getShellSnapshot(sweepRead);
      assert.deepEqual(shared, yield* store.getShellSnapshot({ location: "active" }));
      const again = yield* store.getShellSnapshot(sweepRead);
      // The exact read above refreshed the shared copy; sweeps now get that one.
      assert.deepEqual(again, shared);
      assert.strictEqual(yield* store.getShellSnapshot(sweepRead), again);
    }),
  );

  it.effect("shows a write to the next sweep once the age has passed", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* store.getShellSnapshot(sweepRead);
      const writes = yield* store.writeCount!;
      const added = yield* createThread("second");
      assert.equal(yield* store.writeCount!, writes + 1);
      // Within the age a sweep may still see the copy from before the write.
      assert.strictEqual(yield* store.getShellSnapshot(sweepRead), before);
      yield* TestClock.adjust(SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS);
      const after = yield* store.getShellSnapshot(sweepRead);
      assert.isTrue(after.threads.some((thread) => thread.id === added));
      assert.deepEqual(after, yield* store.getShellSnapshot({ location: "active" }));
    }),
  );

  it.effect("keeps serving an idle server's snapshot without scanning again", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const first = yield* store.getShellSnapshot({ unsettledOnly: true, maxAgeMs: 5_000 });
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(
        yield* store.getShellSnapshot({ unsettledOnly: true, maxAgeMs: 5_000 }),
        first,
      );
    }),
  );
});

const turnItem = (
  threadId: ThreadId,
  runId: RunId,
  nodeId: NodeId,
  ordinal: number,
  now: DateTime.Utc,
) =>
  ordinal % 50 === 0
    ? {
        id: TurnItemId.make(`${threadId}:item:${ordinal}`),
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "failed" as const,
        title: "Provider error",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "provider_error" as const,
          message: `failure ${ordinal}`,
          resetAt: null,
          code: null,
          retryable: null,
        },
      }
    : {
        id: TurnItemId.make(`${threadId}:item:${ordinal}`),
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: "command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: `echo ${ordinal} ${"x".repeat(2_000)}`,
      };

it.layer(layerTest)("type-filtered turn item reads", (it) => {
  it.effect("seek the matching items only and keep their order", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = yield* createThread("many-items");
      const runId = RunId.make("run:many-items");
      const nodeId = NodeId.make("node:many-items");
      yield* store.apply({
        id: EventId.make("event:many-items:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:many-items"),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const count = 1_000;
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        yield* store.apply({
          id: EventId.make(`event:many-items:item:${ordinal}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: turnItem(threadId, runId, nodeId, ordinal, now),
        });
      }
      const records = yield* store.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["error"],
      });
      const all = yield* store.getThreadRecords(threadId, ["turnItems"]);
      assert.deepEqual(
        records.turnItems,
        all.turnItems.filter((item) => item.type === "error"),
      );
      assert.equal(records.turnItems.length, count / 50);

      // The plan the read now runs: a seek on (thread, type), not a walk of every item.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        INDEXED BY project_context_compaction_lookup
        WHERE thread_id = ${threadId}
          AND type IN (SELECT value FROM json_each(${JSON.stringify(["error"])}))
        ORDER BY ordinal ASC, turn_item_id ASC
      `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("USING INDEX project_context_compaction_lookup")),
      );
    }),
  );
});
