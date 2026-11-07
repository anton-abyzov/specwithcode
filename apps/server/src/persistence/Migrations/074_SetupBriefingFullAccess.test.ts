import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("074_SetupBriefingFullAccess", (it) => {
  it.effect("moves only the early setup briefing to full access", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      const insert = (taskId: string, runtimeMode: string) => sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, last_run_status, run_count
        ) VALUES (
          ${taskId}, 'Proactive briefing', '/proactive-briefing', 1,
          '{"type":"fixed_time","timeOfDay":"08:00"}', 'p1', NULL, '{"type":"root"}',
          '{"instanceId":"claudeAgent","model":"claude-sonnet-5-5"}', ${runtimeMode}, 'default',
          'user', 'web', '2026-10-10T21:29:44.357Z', '2026-10-10T21:29:44.357Z', 'never', 0
        )
      `;
      yield* insert("scheduled-task:assistant-setup:a", "approval-required");
      yield* insert("scheduled-task:assistant-setup:b", "auto-accept-edits");
      yield* insert("scheduled-task:person-made", "approval-required");
      yield* runMigrations({ toMigrationInclusive: 74 });

      const rows = yield* sql<{ readonly task_id: string; readonly runtime_mode: string }>`
        SELECT task_id, runtime_mode FROM scheduled_tasks ORDER BY task_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.task_id, row.runtime_mode]),
        [
          ["scheduled-task:assistant-setup:a", "full-access"],
          ["scheduled-task:assistant-setup:b", "auto-accept-edits"],
          ["scheduled-task:person-made", "approval-required"],
        ],
      );
    }),
  );
});
