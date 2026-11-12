import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Partial indexes for the two reads that logged most slow-statement warnings:
 * the update readiness look for background work and the thread shell list.
 * Each holds only the few live or matching rows, so building it is one pass
 * over its table and it costs a write only when a row enters or leaves it.
 * None reads payload_json: an index over a JSON expression fails to build,
 * and with it the update, on a database holding one malformed payload.
 *
 * A partial index is used only when the query repeats its WHERE: keep these
 * predicates identical to the ones in ServiceUpdatePreparation.ts
 * (`selectBackgroundBusyThreads`) and ProjectionStore.ts
 * (`selectShellThreadRows`, which pins the two run indexes by name).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Update readiness: live subagent nodes, joined to their run. The look ran
  // every few seconds while a question was open and scanned every node.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_live_subagent_idx
    ON orchestration_v2_projection_nodes(run_id, thread_id)
    WHERE kind = 'subagent' AND status IN ('pending', 'running', 'waiting')
  `;
  // Shell list: a thread's newest live run. The (thread_id, ordinal) index
  // walked every run of a thread to find that none was live.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_active_latest_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_working_latest_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `;
  // Shell list, fallback pairing: a thread's newest fallback notice. Without
  // it the read walked every message of each thread that never fell back.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_fallback_notice_idx
    ON orchestration_v2_projection_messages(thread_id, created_at DESC, message_id DESC)
    WHERE message_id LIKE 'limit-fallback:%' OR message_id LIKE 'provider-fallback:%'
  `;
});
