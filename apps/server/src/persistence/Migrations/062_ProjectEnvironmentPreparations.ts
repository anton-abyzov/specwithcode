import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_environment_preparations (
    project_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    destination TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,command_id)
  )`;
  yield* sql`CREATE TRIGGER project_environment_preparations_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM project_environment_preparations WHERE project_id=NEW.project_id; END`;
  yield* sql`CREATE TRIGGER project_environment_preparations_removed AFTER DELETE ON projection_projects
    BEGIN DELETE FROM project_environment_preparations WHERE project_id=OLD.project_id; END`;
});
