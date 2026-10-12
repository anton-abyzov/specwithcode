import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN workspace_settings_json TEXT`;
  yield* sql`CREATE TABLE project_memory (
    project_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY(project_id, name)
  )`;
  // Tombstones retain revision identity across delete/recreate, preventing stale edits from winning.
  yield* sql`CREATE TABLE project_memory_revisions (
    project_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(project_id, name)
  )`;
  yield* sql`CREATE TABLE scheduled_task_run_receipts (
    command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_created_at TEXT NOT NULL,
    started_at TEXT NOT NULL, result_json TEXT
  )`;
  yield* sql`CREATE INDEX scheduled_task_run_receipts_task_id ON scheduled_task_run_receipts(task_id)`;
});
