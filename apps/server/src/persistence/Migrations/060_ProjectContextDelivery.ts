import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_context_deliveries (
    scope_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    accepted_json TEXT, accepted_epoch TEXT,
    pending_run_id TEXT, pending_json TEXT, pending_epoch TEXT, pending_text TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX project_context_deliveries_project ON project_context_deliveries(project_id)`;
  yield* sql`CREATE INDEX project_context_compaction_lookup ON orchestration_v2_projection_turn_items(thread_id,type,status,run_id)`;
});
