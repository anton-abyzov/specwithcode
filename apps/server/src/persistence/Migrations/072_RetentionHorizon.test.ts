import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

interface CompactionRow {
  readonly thread_id: string;
  readonly kind: string;
  readonly through_sequence: number;
  readonly compacted_at: string;
  readonly completed_at: string | null;
}

layer("072_RetentionHorizon", (it) => {
  it.effect("rebuilds the compaction table with every row and accepts the horizon kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });

      for (let index = 0; index < 30; index += 1) {
        yield* sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, through_sequence, compacted_at, completed_at
          ) VALUES (
            ${`thread-${index}`}, ${index % 2 === 0 ? "deleted" : "archived"}, ${index * 10},
            ${`2026-11-01T00:00:${String(index).padStart(2, "0")}Z`},
            ${index % 3 === 0 ? null : "2026-11-02T00:00:00Z"}
          )
        `;
      }
      const before = yield* sql<CompactionRow>`
        SELECT thread_id, kind, through_sequence, compacted_at, completed_at
        FROM orchestration_v2_thread_history_compactions ORDER BY thread_id
      `;

      yield* runMigrations({ toMigrationInclusive: 72 });

      const after = yield* sql<CompactionRow>`
        SELECT thread_id, kind, through_sequence, compacted_at, completed_at
        FROM orchestration_v2_thread_history_compactions ORDER BY thread_id
      `;
      assert.strictEqual(after.length, 30);
      assert.deepStrictEqual(after, before);

      const tables = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'orchestration_v2_thread_history_compactions%'
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        ["orchestration_v2_thread_history_compactions"],
      );
      assert.include(tables[0]?.sql ?? "", "CHECK (kind IN ('deleted', 'archived', 'horizon'))");

      yield* sql`
        INSERT INTO orchestration_v2_thread_history_compactions (
          thread_id, kind, through_sequence, compacted_at
        ) VALUES ('thread-horizon', 'horizon', 500, '2026-11-03T00:00:00Z')
      `;
      const unknownKind = yield* Effect.exit(
        sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, through_sequence, compacted_at
          ) VALUES ('thread-other', 'pruned', 1, '2026-11-03T00:00:00Z')
        `,
      );
      assert.strictEqual(unknownKind._tag, "Failure");
      const duplicate = yield* Effect.exit(
        sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, through_sequence, compacted_at
          ) VALUES ('thread-0', 'horizon', 1, '2026-11-03T00:00:00Z')
        `,
      );
      assert.strictEqual(duplicate._tag, "Failure");
      const missingSequence = yield* Effect.exit(
        sql`
          INSERT INTO orchestration_v2_thread_history_compactions (
            thread_id, kind, compacted_at
          ) VALUES ('thread-null', 'horizon', '2026-11-03T00:00:00Z')
        `,
      );
      assert.strictEqual(missingSequence._tag, "Failure");

      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions
      `;
      assert.strictEqual(count[0]?.count, 31);
      const check = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
      assert.deepStrictEqual(check, [{ integrity_check: "ok" }]);
    }),
  );
});
