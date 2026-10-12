import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_connections (
    project_id TEXT NOT NULL, connection_id TEXT NOT NULL, revision INTEGER NOT NULL,
    data_json TEXT NOT NULL, PRIMARY KEY(project_id, connection_id)
  )`;
  // Reserve before dispatch. A pending receipt is deliberately not retried after a crash.
  yield* sql`CREATE TABLE project_connection_calls (
    project_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    result_json TEXT, PRIMARY KEY(project_id, command_id)
  )`;
});
