import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Lets `orchestration_v2_thread_history_compactions` record a third kind,
 * `horizon`: a thread that is neither deleted nor archived whose events older
 * than the history horizon were folded into its projection rows
 * (ThreadHistoryRetention.ts). SQLite cannot alter a CHECK, so the table is
 * rebuilt: create, copy, drop, rename, in the migration's transaction. The
 * table holds one row per compacted thread, so the copy is small.
 *
 * Builds from migration 070 read the new kind the same way: any marker keeps
 * the thread's projection rows on a rebuild and sends a resuming client a
 * snapshot, and their own passes only ever write `deleted` or `archived`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_thread_history_compactions_next (
      thread_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('deleted', 'archived', 'horizon')),
      through_sequence INTEGER NOT NULL,
      compacted_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_thread_history_compactions_next (
      thread_id, kind, through_sequence, compacted_at, completed_at
    )
    SELECT thread_id, kind, through_sequence, compacted_at, completed_at
    FROM orchestration_v2_thread_history_compactions
  `;
  yield* sql`DROP TABLE orchestration_v2_thread_history_compactions`;
  yield* sql`
    ALTER TABLE orchestration_v2_thread_history_compactions_next
    RENAME TO orchestration_v2_thread_history_compactions
  `;
});
