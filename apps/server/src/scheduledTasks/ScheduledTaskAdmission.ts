import {
  isProviderAvailable,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  projectExecutionIsFenced,
  type ModelSelection,
  type ProjectWorkspaceSettings,
  type ScheduledTask,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { providersChecking } from "@specweave-studio/shared/coordinatorDefault";
import { canTakeTurn } from "@specweave-studio/shared/providerFallback";
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

/** The project's coordinator thread, as the coordinator service finds or creates it. */
export const routineCoordinatorThreadId = Effect.fn(
  "ScheduledTaskService.routineCoordinatorThreadId",
)(function* (task: Pick<ScheduledTask, "id" | "projectId">) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects
    .get(task.projectId)
    .pipe(
      Effect.mapError((cause) =>
        taskError("Could not read routine project.", { taskId: task.id, cause }),
      ),
    );
  const settings = Option.isNone(project)
    ? null
    : (
        project.value as ProjectStore.ProjectRow & {
          readonly workspaceSettings?: ProjectWorkspaceSettings | null;
        }
      ).workspaceSettings;
  return settings?.coordinatorThreadId ?? `project-coordinator:${task.projectId}`;
});

/**
 * Why the provider itself refuses a session in a way starting one cannot
 * repair, or null. Not installed or prepared, a status "error" from one slow
 * health probe, or a "warning" all fire: a session start installs an
 * on-demand agent and refreshes the status. A usage limit is left to the
 * limit fallback, which needs the run to stop on it.
 */
function providerBlockedDetail(provider: ServerProvider): string | null {
  if (!provider.enabled) return "It is disabled.";
  if (provider.auth.status === "unauthenticated") return "It is signed out.";
  if (!isProviderAvailable(provider))
    return provider.unavailableReason ?? provider.message ?? "It is unavailable.";
  return null;
}

/**
 * Where a fire dispatches: the thread it posts to (null when it starts a new
 * one) and the model it sends, or undefined to keep that thread's provider.
 */
export interface RoutineProviderDestination {
  readonly threadId: string | null;
  readonly modelSelection: ModelSelection | undefined;
}

/**
 * Why a fire must not dispatch, or null to fire as usual. The run goes to the
 * destination's model, else to the provider its thread is on. When that
 * provider is disabled, signed out or unavailable on this machine, or the
 * thread's latest run on it failed as provider_unavailable and no read since
 * found it able to take a turn, a dispatch would only add another failed run,
 * so the fire is skipped and the next one checks again. An unknown provider,
 * or one still awaiting its first check, fires as before.
 */
export const providerSkipReason = Effect.fn("ScheduledTaskService.providerSkipReason")(function* (
  task: Pick<ScheduledTask, "id">,
  providers: ReadonlyArray<ServerProvider>,
  destination: RoutineProviderDestination,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    destination.threadId === null
      ? []
      : yield* sql<{
          readonly thread_instance_id: string | null;
          readonly run_instance_id: string | null;
          readonly run_status: string | null;
          readonly run_completed_at: string | null;
          readonly failure_message: string | null;
        }>`
          SELECT thread.provider_instance_id AS thread_instance_id,
                 run.provider_instance_id AS run_instance_id,
                 run.status AS run_status,
                 run.completed_at AS run_completed_at,
                 (
                   SELECT json_extract(item.payload_json, '$.failure.message')
                   FROM orchestration_v2_projection_turn_items item
                   WHERE item.run_id = run.run_id AND item.type = 'error'
                     AND json_extract(item.payload_json, '$.failure.code') = ${ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE}
                   ORDER BY item.ordinal DESC
                   LIMIT 1
                 ) AS failure_message
          FROM orchestration_v2_projection_threads thread
          LEFT JOIN orchestration_v2_projection_runs run
            ON run.run_id = (
              SELECT latest.run_id FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = thread.thread_id
              ORDER BY latest.ordinal DESC
              LIMIT 1
            )
          WHERE thread.thread_id = ${destination.threadId}
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not read routine destination.", { taskId: task.id, cause }),
          ),
        );
  const thread = rows[0];
  const instanceId = destination.modelSelection?.instanceId ?? thread?.thread_instance_id ?? null;
  if (instanceId === null) return null;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined || providersChecking([provider])) return null;
  const name = provider.displayName ?? provider.instanceId;
  const blocked = providerBlockedDetail(provider);
  if (blocked !== null) return `Skipped: ${name} cannot start on this machine: ${blocked}`;
  const failedAt = Date.parse(thread?.run_completed_at ?? "");
  if (
    thread?.run_instance_id === instanceId &&
    thread.run_status === "failed" &&
    thread.failure_message !== null &&
    // A read after the failure that finds it able to take a turn lets the next run try again.
    !(Date.parse(provider.checkedAt) > failedAt && canTakeTurn(provider))
  )
    return `Skipped: ${name} cannot start on this machine: ${thread.failure_message}`;
  return null;
});
