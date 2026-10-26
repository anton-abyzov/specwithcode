import * as Effect from "effect/Effect";
import type * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import { ScheduledTaskId } from "@specweave-studio/contracts";

/**
 * A finished one-shot routine stays in the list this long after its run
 * succeeded, so that run can still be read there, then it is removed. Its
 * thread keeps the run itself.
 */
export const FINISHED_ROUTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the poll looks for finished one-shots to remove. */
export const FINISHED_ROUTINE_SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Marks a one-shot whose run succeeded as finished at `atIso` (see
 * ScheduledTaskRunPolicy.finishedAt): a one-time task, or a stopAfterPass
 * watch, that the host already turned off. `latest` pins the row to the run
 * that succeeded. A routine someone turned back on, or one that recurs, is
 * never marked, and only marked rows are ever removed.
 */
export const markFinishedOneShot = Effect.fn("ScheduledTaskService.markFinishedOneShot")(function* (
  latest: Statement.Fragment,
  atIso: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly task_id: string }>`
      UPDATE scheduled_tasks
      SET run_policy_json = json_set(COALESCE(run_policy_json, '{}'), '$.finishedAt', ${atIso})
      WHERE ${latest}
        AND enabled = 0 AND next_run_at IS NULL
        AND json_extract(run_policy_json, '$.finishedAt') IS NULL
        AND (json_extract(schedule_json, '$.type') = 'once'
          OR json_extract(run_policy_json, '$.check.stopAfterPass') = 1)
      RETURNING task_id
    `;
  return rows.length > 0;
});

const expired = (sql: SqlClient.SqlClient, cutoffIso: string) =>
  sql`enabled = 0
    AND last_run_status = 'succeeded'
    AND json_extract(run_policy_json, '$.finishedAt') IS NOT NULL
    AND json_extract(run_policy_json, '$.finishedAt') <= ${cutoffIso}`;

/** Routines finished before `cutoffIso` and off ever since. */
export const selectExpiredRoutineIds = Effect.fn("ScheduledTaskService.selectExpiredRoutineIds")(
  function* (cutoffIso: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly task_id: string }>`
      SELECT task_id FROM scheduled_tasks WHERE ${expired(sql, cutoffIso)}
    `;
    return rows.map((row) => ScheduledTaskId.make(row.task_id));
  },
);

/**
 * Removes one expired routine, re-checking it in the delete itself so a
 * routine turned back on, edited or run after the select stays. Cleans up
 * like a delete from the list. Returns whether it was removed.
 */
export const deleteExpiredRoutine = Effect.fn("ScheduledTaskService.deleteExpiredRoutine")(
  function* (id: ScheduledTaskId, cutoffIso: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly task_id: string }>`
          DELETE FROM scheduled_tasks
          WHERE task_id = ${id} AND ${expired(sql, cutoffIso)}
          RETURNING task_id
        `;
        if (rows.length === 0) return false;
        yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`;
        yield* sql`UPDATE scheduled_task_run_receipts SET result_json = NULL, task_created_at = '' WHERE task_id = ${id}`;
        return true;
      }),
    );
  },
);
