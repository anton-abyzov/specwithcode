import {
  CommandId,
  isProjectCoordinatorThreadId,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

/** What tells a project's coordinator thread apart: its id and settings. */
export interface RoutineProject {
  readonly id: string;
  readonly workspaceSettings?: { readonly coordinatorThreadId?: string | null } | null | undefined;
}

/**
 * Every routine runs in a thread of its own. The only other destination is a
 * worker thread someone bound it to on purpose ("wake me when CI is done").
 * A routine with no thread, or one bound to the project's coordinator, as
 * older routines were, is an own-thread routine whose next run starts its
 * thread: the coordinator plans and delegates, and repeated runs would bury
 * its conversation.
 */
export function asOwnThreadRoutine<
  T extends Pick<ScheduledTask, "projectId" | "threadId"> & {
    readonly ownThread?: boolean | undefined;
  },
>(task: T, project: RoutineProject | null): T {
  if (task.threadId === null) return task.ownThread ? task : { ...task, ownThread: true };
  const coordinator = isProjectCoordinatorThreadId(task.threadId, {
    id: project?.id ?? task.projectId,
    ...(project?.workspaceSettings ? { workspaceSettings: project.workspaceSettings } : {}),
  });
  return coordinator ? { ...task, threadId: null, ownThread: true } : task;
}

/** The routine's project as `asOwnThreadRoutine` needs it; null when it cannot be read. */
export const readRoutineProject = Effect.fn("ScheduledTaskService.readRoutineProject")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects
    .get(projectId)
    .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
  return Option.match(project, {
    onNone: (): RoutineProject | null => null,
    onSome: (row): RoutineProject => ({
      id: row.projectId,
      workspaceSettings: row.workspaceSettings ?? null,
    }),
  });
});

/**
 * A routine with a thread of its own keeps that thread across runs. When the
 * thread was deleted, archived or moved to another project, the routine is
 * treated as unbound so its next run starts a new one; the routine, not the
 * thread, is the durable unit.
 */
export const withLiveOwnThread = Effect.fn("ScheduledTaskService.withLiveOwnThread")(function* (
  task: ScheduledTask,
) {
  if (!task.ownThread || task.threadId === null) return task;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly project_id: string;
    readonly deleted_at: string | null;
    readonly archived_at: string | null;
  }>`
    SELECT project_id, deleted_at, archived_at
    FROM orchestration_v2_projection_threads
    WHERE thread_id = ${task.threadId}
  `.pipe(
    Effect.mapError((cause) =>
      taskError("Could not read the routine's thread.", { taskId: task.id, cause }),
    ),
  );
  const row = rows[0];
  const live =
    row !== undefined &&
    row.project_id === task.projectId &&
    row.deleted_at === null &&
    row.archived_at === null;
  return live ? task : { ...task, threadId: null };
});

/**
 * One launch identity per thread the routine needs: a retried or later run
 * before the binding is saved resumes the same launch instead of starting a
 * second thread. `replacing` is the stored thread being replaced, if any.
 */
export function ownThreadLaunchCommandId(
  task: Pick<ScheduledTask, "id" | "createdAt">,
  replacing: string | null,
): CommandId {
  return CommandId.make(
    `scheduled-task:${task.id}:own-thread:${task.createdAt}:${replacing ?? "first"}`,
  );
}

/**
 * Bind the launched thread, unless an edit rebound the routine meanwhile, and
 * record the routine as owning it, so a routine saved before own threads
 * existed is replaced like any other when its thread is archived.
 */
export const bindOwnThread = Effect.fn("ScheduledTaskService.bindOwnThread")(function* (input: {
  readonly taskId: ScheduledTask["id"];
  readonly replacing: string | null;
  readonly threadId: ThreadId;
  readonly updatedAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET thread_id = ${input.threadId},
        run_policy_json = json_set(COALESCE(run_policy_json, '{}'), '$.ownThread', json('true')),
        updated_at = ${input.updatedAt}
    WHERE task_id = ${input.taskId}
      AND thread_id IS ${input.replacing}
  `.pipe(
    Effect.mapError((cause) =>
      taskError("Could not save the routine's thread.", { taskId: input.taskId, cause }),
    ),
  );
});
