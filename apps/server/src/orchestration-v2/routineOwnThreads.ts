import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The threads routines started as their own (`ownThread` in the run policy,
 * `ScheduledTaskOwnThread.ts`). A fallback never gives such a thread a track
 * row's Ultracode: a routine runs unattended and repeatedly (1441, 1506).
 * Empty without a database or on any read error.
 */
export const routineOwnThreadIds = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return new Set<string>();
  return yield* sql.value<{ readonly thread_id: string }>`
    SELECT thread_id FROM scheduled_tasks
    WHERE thread_id IS NOT NULL
      AND json_extract(run_policy_json, '$.ownThread') = 1
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});
