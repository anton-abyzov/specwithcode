import { EnvironmentId, type ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as WorkGrants from "../fleet/WorkGrants.ts";
import { effectiveGrant, type WorkGrantPolicyRecord } from "../fleet/WorkGrants.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

/**
 * A routine another machine's coordinator made or changed here under its work
 * grant records that grant (`run_policy_json.grantedBy`). It runs later as
 * this machine's own work, so before every fire the grant is read again: once
 * it is revoked, gone, no longer allows routines or no longer covers the
 * project, the routine is turned off with a note and never fires again. A
 * routine the owner saves here is the owner's and records no grant.
 */

export const ROUTINE_GRANT_GONE_NOTE =
  "Turned off: the machine that set up this routine no longer has a grant here.";
export const ROUTINE_GRANT_REVOKED_NOTE =
  "Turned off: this machine revoked work from the machine that set up this routine.";
export const ROUTINE_GRANT_NO_ROUTINES_NOTE =
  "Turned off: the grant this routine was set up under no longer allows routines. Turn it on in Settings > Machines > Who can run work here, then turn the routine back on.";
export const ROUTINE_GRANT_PROJECT_NOTE =
  "Turned off: this routine's project is no longer in the grant it was set up under.";

type GrantProject = Parameters<typeof projectInGrant>[2];

/** Why a routine recorded under `coordinatorEnvironmentId`'s grant may no longer run, or null. */
export function routineGrantRefusal(input: {
  readonly coordinatorEnvironmentId: string;
  readonly policy: WorkGrantPolicyRecord | undefined;
  readonly project: GrantProject | undefined;
}): string | null {
  if (input.policy === undefined) return ROUTINE_GRANT_GONE_NOTE;
  if (input.policy.revokedAt !== null) return ROUTINE_GRANT_REVOKED_NOTE;
  const grant = effectiveGrant(input.policy);
  if (grant.legacy !== true && !grant.routines) return ROUTINE_GRANT_NO_ROUTINES_NOTE;
  if (
    input.project === undefined ||
    !projectInGrant(
      grant.projects,
      EnvironmentId.make(input.coordinatorEnvironmentId),
      input.project,
    )
  )
    return ROUTINE_GRANT_PROJECT_NOTE;
  return null;
}

/** Records the grant a routine was made or changed under; a later owner save clears it. */
export const recordRoutineGrant = Effect.fn("ScheduledTaskGrantGate.record")(function* (
  taskId: string,
  coordinatorEnvironmentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET run_policy_json = json_set(COALESCE(run_policy_json, '{}'), '$.grantedBy',
      json_object('coordinatorEnvironmentId', ${coordinatorEnvironmentId}))
    WHERE task_id = ${taskId}
  `;
});

/** The coordinator whose grant a routine was made under, if any. */
export const readRoutineGrant = Effect.fn("ScheduledTaskGrantGate.read")(function* (
  taskId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly coordinator: string | null }>`
    SELECT json_extract(run_policy_json, '$.grantedBy.coordinatorEnvironmentId') AS coordinator
    FROM scheduled_tasks
    WHERE task_id = ${taskId}
  `;
  const coordinator = rows[0]?.coordinator;
  return typeof coordinator === "string" && coordinator.length > 0 ? coordinator : undefined;
});

export interface RoutineGrantGateDeps {
  readonly sql: SqlClient.SqlClient;
  readonly grants: WorkGrants.WorkGrantsShape;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
}

/**
 * Checks `task` against the grant it was made under. When that grant no
 * longer allows it, turns the routine off with the note and returns the note;
 * otherwise null. Cheap for a routine with no grant: one indexed read. A
 * failed check lets the fire go on, as before grants recorded routines.
 */
export const makeRoutineGrantGate =
  (deps: RoutineGrantGateDeps) =>
  (task: Pick<ScheduledTask, "id" | "projectId">): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      if (!deps.grants.enabled) return null;
      const coordinator = yield* readRoutineGrant(task.id).pipe(
        Effect.provideService(SqlClient.SqlClient, deps.sql),
      );
      if (coordinator === undefined) return null;
      const policies = yield* deps.grants.policies;
      const row = yield* deps.projects
        .get(task.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      const note = routineGrantRefusal({
        coordinatorEnvironmentId: coordinator,
        policy: policies.find((policy) => policy.coordinatorEnvironmentId === coordinator),
        project: Option.isNone(row)
          ? undefined
          : { id: row.value.projectId, workspaceSettings: row.value.workspaceSettings ?? null },
      });
      if (note === null) return null;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* deps.sql`
        UPDATE scheduled_tasks
        SET enabled = 0,
            next_run_at = NULL,
            last_run_error = ${note},
            updated_at = ${now}
        WHERE task_id = ${task.id}
      `;
      yield* Effect.logInfo("Turned off a routine whose work grant no longer allows it", {
        taskId: task.id,
        coordinatorEnvironmentId: coordinator,
      });
      return note;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check a routine's work grant", {
          taskId: task.id,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
