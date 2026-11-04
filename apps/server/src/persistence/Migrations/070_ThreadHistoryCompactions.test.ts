import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("070_ThreadHistoryCompactions", (it) => {
  it.effect("adds the compaction table beside populated history without touching it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      for (let index = 0; index < 25; index += 1) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item-${index}`}, ${`thread-${index % 5}`}, ${index}, 'message', 'completed',
            '2026-11-01T00:00:00Z', '{}'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 70 });

      const items = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
      `;
      assert.strictEqual(items[0]?.count, 25);

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(orchestration_v2_thread_history_compactions)`;
      assert.deepStrictEqual(
        columns.map((column) => [column.name, column.notnull, column.pk]),
        [
          ["thread_id", 0, 1],
          ["kind", 1, 0],
          ["through_sequence", 1, 0],
          ["compacted_at", 1, 0],
          ["completed_at", 0, 0],
        ],
      );

      yield* sql`
        INSERT INTO orchestration_v2_thread_history_compactions (
          thread_id, kind, through_sequence, compacted_at, completed_at
        ) VALUES
          ('thread-0', 'deleted', 10, '2026-11-01T00:00:00Z', NULL),
          ('thread-1', 'archived', 20, '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z')
      `;
      const unknownKind = yield* Effect.exit(
        sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, through_sequence, compacted_at
          ) VALUES ('thread-2', 'horizon', 30, '2026-11-01T00:00:00Z')
        `,
      );
      assert.strictEqual(unknownKind._tag, "Failure");
      const duplicate = yield* Effect.exit(
        sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, through_sequence, compacted_at
          ) VALUES ('thread-0', 'archived', 40, '2026-11-01T00:00:00Z')
        `,
      );
      assert.strictEqual(duplicate._tag, "Failure");
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions
      `;
      assert.strictEqual(rows[0]?.count, 2);
    }),
  );
});
