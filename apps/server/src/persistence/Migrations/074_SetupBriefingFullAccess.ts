import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Early builds of the assistant's setup saved its daily briefing with the
 * app's built-in default, `approval-required`, under `assistant-setup:` ids.
 * No person chose that mode, and the setup now saves `full-access`
 * (AideBriefingSetup.ts), so those rows move to it. Team rules still judge
 * every run, and the routine's own thread follows on its next run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET runtime_mode = 'full-access'
    WHERE task_id LIKE 'scheduled-task:assistant-setup:%'
      AND runtime_mode = 'approval-required'
  `;
});
