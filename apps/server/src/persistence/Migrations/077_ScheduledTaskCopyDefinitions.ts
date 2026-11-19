import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * For a routine another machine runs (1390 AC-45): the hash of its definition
 * as that machine sent it, kept beside the copy that took it. The copy's own
 * row may hold the definition under this machine's limits, so its hash is not
 * the runner's, and a change made here names the runner's. A table of its own
 * rather than a column on the runner table, so an update keeps the page proof
 * instead of reading the whole database.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_copy_definitions (
      task_id TEXT PRIMARY KEY,
      definition_hash TEXT NOT NULL
    )
  `;
});
