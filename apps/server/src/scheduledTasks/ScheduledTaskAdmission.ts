import {
  projectExecutionIsFenced,
  type ProjectWorkspaceSettings,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

/**
 * The cause of a refusal because the routine's project is archived or paused.
 * Unlike the other refusals it lasts until a person restores the project, so a
 * scheduled run moves on to its next time instead of being tried again at once.
 */
export class RoutineProjectSuspended extends Schema.TaggedError<RoutineProjectSuspended>()(
  "RoutineProjectSuspended",
  { state: Schema.Literals(["archived", "paused"]) },
) {}

const isRoutineProjectSuspended = Schema.is(RoutineProjectSuspended);

/** Whether `error` refused a run because its project is archived or paused, and which. */
export function suspendedProjectState(error: unknown): "archived" | "paused" | null {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return isRoutineProjectSuspended(cause) ? cause.state : null;
}

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
      readonly workspaceSettings?: ProjectWorkspaceSettings | null;
    }
  ).workspaceSettings;
  if (projectExecutionIsFenced(policy, task.projectId, task.threadId))
    return yield* taskError("Routine coordinator has handed off ownership.", { taskId: task.id });
  if (policy?.paused || policy?.archived) {
    const state = policy.archived ? "archived" : "paused";
    return yield* taskError(`Routine project is ${state}.`, {
      taskId: task.id,
      cause: new RoutineProjectSuspended({ state }),
    });
  }
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
