import type { ProjectId, ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { iso, nextRunAfter, nextRunAt, taskError } from "./ScheduledTaskStorage.ts";
import { missedRunNote } from "./Schedule.ts";
import { RESTING_ROUTINE_NOTE } from "./ScheduledTaskCoordinatorGate.ts";

/**
 * Due runs the scheduler does not fire: moved on to their next time with a
 * note the routine shows until its next run. A run in progress keeps its own
 * status; its slot still moves on, so the next poll does not find it again.
 */
export const makeRunSkips = (deps: { readonly notifyChanged: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const skipTo = (
      task: ScheduledTask,
      next: string | null,
      note: string,
      now: DateTime.DateTime,
    ) =>
      sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            last_run_error = CASE WHEN last_run_status = 'running' THEN last_run_error ELSE ${note} END,
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
          AND next_run_at IS ${task.nextRunAt}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule schedule task run.", { taskId: task.id, cause }),
        ),
        Effect.andThen(deps.notifyChanged),
      );

    /**
     * A copy that does not coordinate its project rests: a due run moves on to
     * its next time, as for a paused project, and the routine says why. A
     * one-time task keeps its slot, so it fires if this copy takes over.
     */
    const restRun = Effect.fn("ScheduledTaskService.restRun")(function* (
      task: ScheduledTask,
      note: string,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAfter(task, now, false);
      if (next === task.nextRunAt && task.lastRunError === note) return task;
      yield* skipTo(task, next, note, now);
      return { ...task, nextRunAt: next, lastRunError: note, updatedAt: iso(now) };
    });

    /**
     * A due fixed-time run long past its slot is skipped and re-aimed at its
     * next occurrence, not fired late: the machine was off or asleep, or its
     * coordinator was on hold (`held`), at that time.
     */
    const skipMissedRun = Effect.fn("ScheduledTaskService.skipMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
      held: boolean,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* skipTo(task, next, missedRunNote(task.schedule, held ? "held" : "off"), now);
    });

    /** Clears the resting note once this copy coordinates the project again. */
    const clearRestingNotes = (projectId: ProjectId) =>
      sql`
        UPDATE scheduled_tasks SET last_run_error = NULL
        WHERE project_id = ${projectId} AND last_run_error = ${RESTING_ROUTINE_NOTE}
      `.pipe(Effect.andThen(deps.notifyChanged));

    return { restRun, skipMissedRun, clearRestingNotes };
  });
