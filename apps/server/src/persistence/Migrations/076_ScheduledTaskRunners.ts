import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The one machine that runs a routine (1390 AC-45), apart from the routine's
 * own row so a save, a replica or a run transition never rewrites it. No row
 * means no runner is recorded yet: the routine runs where it always did.
 *
 * `scheduled_task_revisions` counts the changes made to a routine on this
 * machine, runner record or not, so a change made against an older count is
 * refused instead of replacing a newer one.
 *
 * `scheduled_task_runner_receipts` keeps the answer to each step of a runner
 * move under its operation id, so a repeated request gets the same answer and
 * changes nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runners (
      task_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      runner_environment_id TEXT NOT NULL,
      runner_label TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      acked_json TEXT NOT NULL DEFAULT '[]',
      operation_id TEXT,
      operation_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_revisions (
      task_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runner_receipts (
      receipt_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
