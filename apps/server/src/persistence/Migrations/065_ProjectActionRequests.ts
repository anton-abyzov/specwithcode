import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Agent requests to archive, restore, delete or move a project, and the user's
 * decision on each. The row is written before the approval card is shown and
 * is the audit trail of who asked, why, what the user chose and what happened.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_action_requests (
    request_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    action TEXT NOT NULL,
    params_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`;
  yield* sql`CREATE INDEX project_action_requests_project ON project_action_requests(project_id, created_at)`;
});
