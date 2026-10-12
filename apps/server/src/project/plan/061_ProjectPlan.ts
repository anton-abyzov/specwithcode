import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Registered by the integration lane. No CLI or filesystem writes are required. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_plans (
    project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL
  )`;
  // Logical project deletion is authoritative; remove spec, assignments and command output too.
  yield* sql`CREATE TRIGGER project_plans_project_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM project_plans WHERE project_id=NEW.project_id; END`;
  yield* sql`CREATE TRIGGER project_plans_project_removed AFTER DELETE ON projection_projects
    BEGIN DELETE FROM project_plans WHERE project_id=OLD.project_id; END`;
});
