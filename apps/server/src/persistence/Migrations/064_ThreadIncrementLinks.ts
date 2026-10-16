import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A thread linked to a SpecWeave increment by hand; a NULL increment means "none".
  // No row means automatic binding (docs/studio/plan-progress.md).
  yield* sql`CREATE TABLE thread_increment_links (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, increment_id TEXT, linked_at TEXT NOT NULL
  )`;
});
