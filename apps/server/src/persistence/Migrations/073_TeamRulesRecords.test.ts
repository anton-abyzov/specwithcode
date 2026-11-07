import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("073_TeamRulesRecords", (it) => {
  it.effect("adds the two record tables and keeps existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      const before = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions
      `;
      yield* sql`
        INSERT INTO orchestration_v2_thread_history_compactions
          (thread_id, kind, through_sequence, compacted_at)
        VALUES ('thread-a', 'archived', 3, '2026-11-07T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 73 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('team_rules_command_actors', 'team_rules_settings_changes')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        ["team_rules_command_actors", "team_rules_settings_changes"],
      );
      const kept = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_thread_history_compactions
      `;
      assert.strictEqual(kept[0]!.count, before[0]!.count + 1);

      yield* sql`
        INSERT INTO team_rules_command_actors (command_id, person, os_user, device_json)
        VALUES ('command-1', 'person-a', NULL, '{}')
      `;
      yield* sql`
        INSERT INTO team_rules_settings_changes (occurred_at, paths_json)
        VALUES ('2026-11-07T00:00:00.000Z', '["providers"]')
      `;
      const changes = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM team_rules_settings_changes
      `;
      assert.deepStrictEqual(
        changes.map((change) => change.sequence),
        [1],
      );
    }),
  );
});
