import type { ScheduledTask } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

/** Re-read project policy and destination immediately before every trigger dispatch. */
export const assertTaskAdmission = Effect.fn("ScheduledTaskService.assertAdmission")(function* (
  task: Pick<ScheduledTask, "id" | "projectId" | "threadId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects
    .get(task.projectId)
    .pipe(
      Effect.mapError((cause) =>
        taskError("Could not read routine project.", { taskId: task.id, cause }),
      ),
    );
  if (Option.isNone(project))
    return yield* taskError("Routine project was deleted or is unavailable.", { taskId: task.id });
  const policy = (
    project.value as ProjectStore.ProjectRow & {
      readonly workspaceSettings?: { readonly paused: boolean; readonly archived: boolean } | null;
    }
  ).workspaceSettings;
  if (policy?.paused || policy?.archived)
    return yield* taskError(`Routine project is ${policy.archived ? "archived" : "paused"}.`, {
      taskId: task.id,
    });
  if (task.threadId !== null) {
    const rows = yield* sql<{ readonly project_id: string; readonly deleted_at: string | null }>`
      SELECT project_id, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${task.threadId}
    `.pipe(
      Effect.mapError((cause) =>
        taskError("Could not read routine destination.", { taskId: task.id, cause }),
      ),
    );
    if (rows[0]?.project_id !== task.projectId || rows[0]?.deleted_at !== null)
      return yield* taskError("Routine destination must be an existing thread in this project.", {
        taskId: task.id,
      });
  }
});
