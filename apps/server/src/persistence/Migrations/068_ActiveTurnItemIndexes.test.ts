import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const STATUSES = ["pending", "running", "waiting", "completed", "failed"] as const;

layer("068_ActiveTurnItemIndexes", (it) => {
  it.effect("keeps every turn item and adds the live-item partial indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });

      for (let index = 0; index < 40; index += 1) {
        const status = STATUSES[index % STATUSES.length];
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item-${index}`}, ${`thread-${index % 3}`}, ${`run-${index % 4}`}, ${`node-${index}`},
            ${index}, 'message', ${status}, '2026-11-01T00:00:00Z', ${JSON.stringify({ index })}
          )
        `;
      }
      const before = yield* sql<{ readonly turn_item_id: string; readonly status: string }>`
        SELECT turn_item_id, status, payload_json FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id
      `;

      yield* runMigrations({ toMigrationInclusive: 68 });

      const after = yield* sql<{ readonly turn_item_id: string; readonly status: string }>`
        SELECT turn_item_id, status, payload_json FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id
      `;
      assert.strictEqual(after.length, 40);
      assert.deepStrictEqual(after, before);

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'orchestration_v2_projection_turn_items_active_ordinal_idx',
          'orchestration_v2_projection_turn_items_active_run_idx'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "orchestration_v2_projection_turn_items_active_ordinal_idx",
          "orchestration_v2_projection_turn_items_active_run_idx",
        ],
      );
      for (const index of indexes) {
        assert.include(index.sql, "WHERE status IN ('pending', 'running', 'waiting')");
      }
      const columns = (name: string) =>
        sql<{ readonly name: string }>`SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
      assert.deepStrictEqual(
        (yield* columns("orchestration_v2_projection_turn_items_active_ordinal_idx")).map(
          (column) => column.name,
        ),
        ["thread_id", "ordinal", "turn_item_id"],
      );
      assert.deepStrictEqual(
        (yield* columns("orchestration_v2_projection_turn_items_active_run_idx")).map(
          (column) => column.name,
        ),
        ["thread_id", "run_id"],
      );

      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_active_ordinal_idx
        WHERE thread_id = 'thread-0' AND status IN ('pending', 'running', 'waiting')
      `;
      const expected = before.filter(
        (row) =>
          ["pending", "running", "waiting"].includes(row.status) &&
          Number(row.turn_item_id.slice("item-".length)) % 3 === 0,
      ).length;
      assert.strictEqual(live[0]?.count, expected);
      const check = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
      assert.deepStrictEqual(check, [{ integrity_check: "ok" }]);
    }),
  );
});
