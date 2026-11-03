import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Threads whose event history the opt-in retention (ThreadHistoryRetention.ts)
 * removed through `through_sequence`. Their projection rows are the base from
 * then on: a rebuild keeps them and replays only later events, and a client
 * resuming from before `through_sequence` takes a snapshot instead of a replay.
 * `completed_at` stays NULL until every delete for the thread finished, so a
 * pass stopped half-way (update gate, error, crash) is resumed, not skipped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_thread_history_compactions (
      thread_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('deleted', 'archived')),
      through_sequence INTEGER NOT NULL,
      compacted_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
});
