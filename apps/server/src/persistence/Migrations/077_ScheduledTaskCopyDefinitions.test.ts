import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0077 from "./077_ScheduledTaskCopyDefinitions.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("077_ScheduledTaskCopyDefinitions", (it) => {
  it.effect("adds one table and leaves the runner table as it was", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const before = yield* sql`
        SELECT name, sql FROM sqlite_schema WHERE name LIKE 'scheduled_task%' ORDER BY name
      `;
      yield* runMigrations({ toMigrationInclusive: 77 });
      // Safe to run again, as an interrupted update would.
      yield* Migration0077;
      const after = yield* sql<{ readonly name: string }>`
        SELECT name, sql FROM sqlite_schema
        WHERE name LIKE 'scheduled_task%' AND name NOT LIKE '%copy_definitions%'
        ORDER BY name
      `;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(
        yield* sql`
          SELECT name, pk FROM pragma_table_info('scheduled_task_copy_definitions') ORDER BY cid
        `,
        [
          { name: "task_id", pk: 1 },
          { name: "definition_hash", pk: 0 },
        ],
      );
    }),
  );
});
