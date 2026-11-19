import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0076 from "./076_ScheduledTaskRunners.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("076_ScheduledTaskRunners", (it) => {
  it.effect("adds the runner tables and leaves every stored routine as it was", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      const before = yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'scheduled_tasks'`;
      yield* runMigrations({ toMigrationInclusive: 76 });
      // Safe to run again, as an interrupted update would.
      yield* Migration0076;

      // The routines table itself is untouched: a routine with no runner row runs as before.
      assert.deepStrictEqual(
        yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'scheduled_tasks'`,
        before,
      );
      const columns = (table: string) =>
        sql<{ readonly name: string; readonly pk: number }>`
          SELECT name, pk FROM pragma_table_info(${table}) ORDER BY cid
        `.pipe(Effect.map((rows) => rows.map((row) => [row.name, row.pk])));
      assert.deepStrictEqual(yield* columns("scheduled_task_runners"), [
        ["task_id", 1],
        ["state", 0],
        ["runner_environment_id", 0],
        ["runner_label", 0],
        ["revision", 0],
        ["acked_json", 0],
        ["operation_id", 0],
        ["operation_json", 0],
        ["updated_at", 0],
        ["asked_json", 0],
        ["copy_enabled", 0],
      ]);
      assert.deepStrictEqual(yield* columns("scheduled_task_revisions"), [
        ["task_id", 1],
        ["revision", 0],
      ]);
      assert.deepStrictEqual(yield* columns("scheduled_task_runner_receipts"), [
        ["receipt_key", 1],
        ["task_id", 0],
        ["answer_json", 0],
        ["created_at", 0],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_runners`, []);
      // A receipt is written once: the first answer to a step stands.
      yield* sql`INSERT OR IGNORE INTO scheduled_task_runner_receipts
        VALUES ('op-1:enable', 'routine', '{"enabled":true}', '1')`;
      yield* sql`INSERT OR IGNORE INTO scheduled_task_runner_receipts
        VALUES ('op-1:enable', 'routine', '{"enabled":false}', '2')`;
      assert.deepStrictEqual(yield* sql`SELECT answer_json FROM scheduled_task_runner_receipts`, [
        { answer_json: '{"enabled":true}' },
      ]);
    }),
  );
});
