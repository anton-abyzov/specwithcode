import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

// The read shapes below repeat ProjectionStore.ts and ProjectionMaintenance.ts:
// a partial index is used only when the query repeats its WHERE, and the join
// order of the rewritten reads is what keeps them off thread-wide walks.
layer("071_HotReadPartialIndexes", (it) => {
  it.effect("adds live-node partial indexes that the hot reads use", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* runMigrations({ toMigrationInclusive: 71 });

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'orchestration_v2_projection_nodes_active_idx',
          'orchestration_v2_projection_nodes_active_root_idx'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "orchestration_v2_projection_nodes_active_idx",
          "orchestration_v2_projection_nodes_active_root_idx",
        ],
      );
      const columns = (name: string) =>
        sql<{ readonly name: string }>`SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
      assert.deepStrictEqual(
        (yield* columns("orchestration_v2_projection_nodes_active_idx")).map((c) => c.name),
        ["thread_id"],
      );
      assert.deepStrictEqual(
        (yield* columns("orchestration_v2_projection_nodes_active_root_idx")).map((c) => c.name),
        ["thread_id", "run_id"],
      );

      const plan = (rows: ReadonlyArray<{ readonly detail: string }>) =>
        rows.map((row) => row.detail).join("\n");

      // readCanonicalProjection window mode: retained-node walk.
      const walk = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT node_id FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${"thread-a"} AND status IN ('pending','starting','running','waiting')`,
      );
      assert.include(walk, "orchestration_v2_projection_nodes_active_idx");

      // getRecoveryThreadIds 'runtime' and 'stranded-subagents'.
      const recovery = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT subagents.child_thread_id FROM orchestration_v2_projection_subagents AS subagents
          WHERE subagents.child_thread_id IS NOT NULL
            AND subagents.origin = 'provider_native'
            AND EXISTS (
              SELECT 1 FROM orchestration_v2_projection_nodes AS node
              WHERE node.thread_id = subagents.child_thread_id
                AND node.run_id IS NULL
                AND node.kind = 'root_turn'
                AND node.status IN ('pending', 'running', 'waiting')
            )`,
      );
      assert.include(recovery, "orchestration_v2_projection_nodes_active_root_idx");

      // Window node load: one primary-key lookup per retained id.
      const nodes = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT node.payload_json FROM json_each(${'["node-a"]'}) AS retained
          CROSS JOIN orchestration_v2_projection_nodes AS node
            ON node.node_id = retained.value
          WHERE node.thread_id = ${"thread-a"}
          ORDER BY COALESCE(node.started_at, ''), node.node_id ASC`,
      );
      assert.match(
        nodes,
        /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 \(node_id=\?\)/,
      );

      // Shell snapshot last_error: bindings of the thread first, then the session by key.
      const lastError = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT json_extract(session.payload_json, '$.lastError')
          FROM orchestration_v2_projection_provider_session_bindings binding
          CROSS JOIN orchestration_v2_projection_provider_sessions session
            ON session.provider_session_id = binding.provider_session_id
          WHERE binding.thread_id = ${"thread-a"}
            AND session.provider_instance_id = ${"instance-a"}
          ORDER BY session.updated_at DESC, session.provider_session_id DESC
          LIMIT 1`,
      );
      assert.match(
        lastError,
        /SEARCH binding USING (COVERING )?INDEX \S*bindings_thread_idx \(thread_id=\?\)/,
      );
      assert.match(
        lastError,
        /SEARCH session USING INDEX sqlite_autoindex_\S+ \(provider_session_id=\?\)/,
      );

      // Incremental compaction touched-stream discovery: a rowid range, not an index walk.
      const touched = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT DISTINCT stream_id
          FROM orchestration_events NOT INDEXED
          WHERE sequence > ${1} AND sequence <= ${2} AND aggregate_kind = 'thread'`,
      );
      assert.include(touched, "USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");

      // A gap past TOUCHED_RANGE_SCAN_LIMIT keeps the bounded covering-index walk.
      const touchedLongGap = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT DISTINCT stream_id
          FROM orchestration_events
          WHERE sequence > ${1} AND sequence <= ${2} AND aggregate_kind = 'thread'`,
      );
      assert.match(touchedLongGap, /USING COVERING INDEX \S+ \(aggregate_kind=\?\)/);
    }),
  );
});
