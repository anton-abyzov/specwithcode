import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0074 from "./074_ShellReadIndexes.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const INDEXES = {
  orchestration_v2_projection_messages_fallback_notice_idx: [
    "thread_id",
    "created_at",
    "message_id",
  ],
  orchestration_v2_projection_nodes_live_subagent_idx: ["run_id", "thread_id"],
  orchestration_v2_projection_runs_active_latest_idx: ["thread_id", "ordinal", "run_id"],
  orchestration_v2_projection_runs_working_latest_idx: ["thread_id", "ordinal", "run_id"],
};

// The read shapes below repeat ServiceUpdatePreparation.ts and
// ProjectionStore.ts: a partial index is used only when the query repeats its
// WHERE.
layer("074_ShellReadIndexes", (it) => {
  it.effect("adds partial indexes that the readiness look and the shell list use", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES
          ('limit-fallback:run-a', 'thread-a', NULL, NULL, 'assistant', 0, '1', '1', '{}'),
          -- A malformed payload must not stop the update.
          ('message-a', 'thread-a', NULL, NULL, 'user', 0, '2', '2', 'not json')`;
      yield* runMigrations({ toMigrationInclusive: 74 });
      // Safe to run again, as an interrupted update would.
      yield* Migration0074;

      const names = Object.keys(INDEXES).sort();
      const found = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'orchestration_v2_%'
      `;
      for (const name of names) {
        assert.include(
          found.map((index) => index.name),
          name,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
        assert.deepStrictEqual(
          columns.map((column) => column.name),
          INDEXES[name as keyof typeof INDEXES],
        );
      }

      const plan = (rows: ReadonlyArray<{ readonly detail: string }>) =>
        rows.map((row) => row.detail).join("\n");

      // ServiceUpdatePreparation selectBackgroundBusyThreads.
      const busy = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT n.thread_id AS thread_id FROM orchestration_v2_projection_nodes n
            JOIN orchestration_v2_projection_runs r ON r.run_id = n.run_id
           WHERE n.kind = 'subagent' AND n.status IN ('pending', 'running', 'waiting')
             AND r.status IN ('preparing', 'starting', 'running', 'waiting')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_provider_threads
           WHERE thread_id IS NOT NULL
             AND json_array_length(payload_json, '$.pendingBackgroundTasks') > 0`,
      );
      assert.include(busy, "orchestration_v2_projection_nodes_live_subagent_idx");

      // selectShellThreadRows: the newest live run, pinned by name.
      const active = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT r.run_id FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_active_latest_idx
          WHERE r.thread_id = ${"thread-a"} AND r.status IN ('preparing', 'starting', 'running')
          ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1`,
      );
      assert.include(active, "orchestration_v2_projection_runs_active_latest_idx (thread_id=?)");
      assert.notInclude(active, "TEMP B-TREE");
      const working = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT r.status FROM orchestration_v2_projection_runs r
            INDEXED BY orchestration_v2_projection_runs_working_latest_idx
          WHERE r.thread_id = ${"thread-a"}
            AND r.status IN ('preparing', 'starting', 'running', 'waiting')
          ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1`,
      );
      assert.include(working, "orchestration_v2_projection_runs_working_latest_idx (thread_id=?)");
      assert.notInclude(working, "TEMP B-TREE");

      // selectShellThreadRows fallback pairing: the newest fallback notice.
      const notice = plan(
        yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT m.message_id FROM orchestration_v2_projection_messages m
          WHERE m.thread_id = ${"thread-a"}
            AND (m.message_id LIKE 'limit-fallback:%' OR m.message_id LIKE 'provider-fallback:%')
          ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1`,
      );
      assert.include(notice, "orchestration_v2_projection_messages_fallback_notice_idx");
      assert.notInclude(notice, "TEMP B-TREE");

      // Rows written before the migration are in the new indexes.
      const rows = yield* sql<{ readonly message_id: string }>`
        SELECT m.message_id FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${"thread-a"}
          AND (m.message_id LIKE 'limit-fallback:%' OR m.message_id LIKE 'provider-fallback:%')
        ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1`;
      assert.deepStrictEqual(rows, [{ message_id: "limit-fallback:run-a" }]);
    }),
  );
});
