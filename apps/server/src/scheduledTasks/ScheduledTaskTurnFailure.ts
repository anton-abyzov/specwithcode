import type {
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { iso, taskError } from "./ScheduledTaskStorage.ts";

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

/**
 * A run counts as succeeded once its message is dispatched. When that
 * message's turn fails later, record the failure, unless the task has run
 * again since. "running" means the dispatch has not been recorded yet.
 */
export const makeRecordTurnFailure = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly findTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly notifyChanged: Effect.Effect<void>;
}) =>
  Effect.fn("ScheduledTaskService.recordTurnFailure")(function* (input: {
    readonly id: ScheduledTaskId;
    readonly requestedAt: DateTime.DateTime;
    readonly error: string;
  }) {
    const now = yield* localNow;
    const rows = yield* deps.sql<{ last_run_status: string }>`
      UPDATE scheduled_tasks
      SET updated_at = ${iso(now)},
          last_run_status = 'failed',
          last_run_error = ${input.error}
      WHERE task_id = ${input.id}
        AND last_run_status = 'succeeded'
        AND last_run_at <= ${iso(input.requestedAt)}
      RETURNING last_run_status
    `.pipe(
      Effect.mapError((cause) =>
        taskError("Could not record schedule task turn failure.", { taskId: input.id, cause }),
      ),
    );
    if (rows.length > 0) {
      yield* deps.notifyChanged;
      return "recorded" as const;
    }
    const current = yield* deps.findTask(input.id);
    return current !== null &&
      current.lastRunStatus === "running" &&
      current.lastRunAt !== null &&
      current.lastRunAt <= iso(input.requestedAt)
      ? ("running" as const)
      : ("stale" as const);
  });
