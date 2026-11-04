import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Partial indexes for two node reads that walked every node of a thread to
 * keep the few live ones. Both hold only live rows, so they stay a few pages
 * and cost a write only when a node enters or leaves a live status.
 *
 * A partial index is used only when the query repeats its WHERE: keep these
 * predicates and the ones in ProjectionStore.ts identical.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Thread open (readCanonicalProjection window mode): the retained-node walk
  // starts from the thread's live nodes.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_active_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending','starting','running','waiting')
  `;
  // getRecoveryThreadIds 'runtime' and 'stranded-subagents' (each swept once a
  // minute): a child thread's live runless root turn. The key must include
  // run_id for the planner to pick it over the (thread_id, run_id) index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_active_root_idx
    ON orchestration_v2_projection_nodes(thread_id, run_id)
    WHERE kind = 'root_turn' AND status IN ('pending', 'running', 'waiting')
  `;
});
