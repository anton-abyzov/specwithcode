import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const createThread = Effect.fn("createThread")(function* (threadId: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* store.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:many"),
      title: "Many",
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
});

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

// SQLite rejects statements binding more than 32,766 variables, so a thread list
// that bound one variable per thread failed for the largest projects.
it.effect(
  "lists every thread past SQLite's bound variable limit",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const templateId = ThreadId.make("thread:many:00000");
      yield* createThread(templateId);
      const threadCount = 32_767;
      yield* sql`
        CREATE TEMP TABLE many_threads AS
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
        SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
        WHERE t.thread_id = ${templateId}
      `;
      yield* sql`
        UPDATE many_threads SET
          thread_id = printf('thread:many:%05d', clone_index),
          payload_json = json_set(
            payload_json,
            '$.id', printf('thread:many:%05d', clone_index),
            '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
          )
      `;
      yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

      const [unscoped, active, candidates] = yield* Effect.all([
        store.getShellSnapshot(),
        store.getShellSnapshot({ location: "active" }),
        store.getSettlementCandidates(),
      ]);
      assert.strictEqual(unscoped.threads.length, threadCount);
      assert.strictEqual(active.threads.length, threadCount);
      assert.strictEqual(candidates.length, threadCount);
    }).pipe(Effect.provide(layerTest)),
  { timeout: 120_000 },
);

it.effect("keeps the pinned pending index with a JSON id list", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT i.thread_id, i.payload_json
      FROM orchestration_v2_projection_turn_items i
        INDEXED BY orchestration_v2_projection_turn_items_shell_pending_idx
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
        AND (i.run_id IS NULL OR r.status <> 'rolled_back')
        AND i.thread_id IN (SELECT value FROM json_each(${JSON.stringify(["thread:a", "thread:b"])}))
    `;
    assert.isTrue(
      plan.some((row) =>
        row.detail.includes("orchestration_v2_projection_turn_items_shell_pending_idx"),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads live recovery items through the active partial indexes", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:recovery-plan");
    yield* createThread(threadId);
    const { statements, tracer } = traceSqlStatements();
    yield* store.getRuntimeRecoveryProjection(threadId).pipe(Effect.withTracer(tracer));
    const turnItemStatements = statements.filter((query) => query.includes("turn_items"));
    assert.isAbove(turnItemStatements.length, 0);
    // Live-item filters must hit the active partial indexes, not walk the thread's history.
    for (const statement of turnItemStatements) {
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      )).map((row) => row.detail);
      for (const detail of plan) {
        assert.notMatch(detail, /turn_items_(thread_ordinal|thread_run)_idx \(thread_id=\?\)$/);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);
