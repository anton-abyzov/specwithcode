import {
  type CommandId,
  ScheduledTask,
  ScheduledTaskError,
  type ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { taskError } from "./ScheduledTaskStorage.ts";

const json = Schema.fromJsonString(ScheduledTask);
const decode = Schema.decodeUnknownEffect(json);
const encode = Schema.encodeEffect(json);

/** A pending receipt is deliberately never retried automatically after a crash. */
export const reserveRun = Effect.fn("ScheduledTaskService.reserveRun")(function* (
  commandId: CommandId,
  task: ScheduledTask,
  startedAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const inserted = yield* sql<{ command_id: string }>`
      INSERT INTO scheduled_task_run_receipts (command_id, task_id, project_id, task_created_at, started_at)
      VALUES (${commandId}, ${task.id}, ${task.projectId}, ${task.createdAt}, ${startedAt})
      ON CONFLICT(command_id) DO NOTHING RETURNING command_id
    `;
        if (inserted.length > 0) return null;
        const [receipt] = yield* sql<{
          task_id: string;
          task_created_at: string;
          result_json: string | null;
        }>`
      SELECT task_id, task_created_at, result_json FROM scheduled_task_run_receipts WHERE command_id = ${commandId}
    `;
        if (!receipt || receipt.task_id !== task.id || receipt.task_created_at !== task.createdAt)
          return yield* new ScheduledTaskError({
            message: "Run command was already used for another routine.",
            reason: "run_command_conflict",
            taskId: task.id,
          });
        if (receipt.result_json === null)
          return yield* new ScheduledTaskError({
            message:
              "This run was already admitted and may still be running or interrupted. Check its thread before starting a new run.",
            reason: "run_outcome_unknown",
            taskId: task.id,
          });
        return yield* decode(receipt.result_json);
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof ScheduledTaskError
          ? cause
          : taskError("Could not admit routine run.", { taskId: task.id, cause }),
      ),
    );
});

export const completeRun = Effect.fn("ScheduledTaskService.completeRun")(function* (
  commandId: CommandId,
  taskId: ScheduledTaskId,
  task: ScheduledTask,
) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* encode(task);
  yield* sql`UPDATE scheduled_task_run_receipts SET result_json = ${result}
    WHERE command_id = ${commandId} AND task_id = ${taskId}
      AND EXISTS (SELECT 1 FROM scheduled_tasks
        WHERE scheduled_tasks.task_id = scheduled_task_run_receipts.task_id
          AND scheduled_tasks.project_id = scheduled_task_run_receipts.project_id
          AND scheduled_tasks.created_at = scheduled_task_run_receipts.task_created_at)`;
});
