import {
  EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskGrantedBy,
} from "@specweave-studio/contracts";
import type { StudioWorkGrantAccounts } from "@specweave-studio/contracts/studioFleet";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as WorkGrants from "../fleet/WorkGrants.ts";
import { effectiveGrant, type WorkGrantPolicyRecord } from "../fleet/WorkGrants.ts";
import { accountInGrant, projectInGrant, type WorkOrigin } from "../fleet/workGrantPolicy.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { decodeRoutineGrantJson } from "./ScheduledTaskStorage.ts";

/**
 * A routine another machine's coordinator made or changed here under its work
 * grant records that grant (`run_policy_json.grantedBy`), in the same write
 * that saves the routine. It runs later as work of that grant, so before every
 * fire the grant is read again, with the coordinators that manage this
 * machine now (routines a grant got only for being the owner's own machine
 * stop counting once it no longer is): once it is revoked, gone, no longer
 * allows routines, no longer covers the project, no longer allows the routine's
 * sign-in or caps runs below the routine's mode, the routine is turned off
 * with a note and never fires again. When the check itself fails, the fire is
 * skipped with a note (fail closed) and the routine tries again next time.
 *
 * A routine the owner saves here records no grant. An owner edit of a grant's
 * routine keeps the grant (the routine still runs under its limits); a
 * grantee may not change an owner's routine at all (OrchestratorMcpService).
 */

export const ROUTINE_GRANT_GONE_NOTE =
  "Turned off: the machine that set up this routine no longer has a grant here.";
export const ROUTINE_GRANT_REVOKED_NOTE =
  "Turned off: this machine revoked work from the machine that set up this routine.";
export const ROUTINE_GRANT_NO_ROUTINES_NOTE =
  "Turned off: the grant this routine was set up under no longer allows routines. Turn it on in Settings > Machines > Who can run work here, then turn the routine back on.";
export const ROUTINE_GRANT_PROJECT_NOTE =
  "Turned off: this routine's project is no longer in the grant it was set up under.";
export const ROUTINE_GRANT_ACCOUNT_NOTE =
  "Turned off: the grant this routine was set up under no longer allows its sign-in.";
export const ROUTINE_GRANT_MODE_NOTE =
  "Turned off: this routine runs with more access than the grant it was set up under allows.";
export const ROUTINE_GRANT_CHECK_FAILED_NOTE =
  "Skipped: could not check the grant this routine was set up under. It tries again next time.";

type GrantProject = Parameters<typeof projectInGrant>[2];

/** Why a routine recorded under `recorded`'s grant may no longer run, or null. */
export function routineGrantRefusal(input: {
  readonly coordinatorEnvironmentId: string;
  readonly policy: WorkGrantPolicyRecord | undefined;
  /** The coordinators that manage this machine now (`WorkGrants.managers`). */
  readonly managers: ReadonlySet<string>;
  readonly project: GrantProject | undefined;
  /** The routine as it would run; omitted, its sign-in and mode are not checked. */
  readonly task?: Pick<ScheduledTask, "runtimeMode" | "modelSelection"> | undefined;
  /** What the routine recorded when it was saved: a fallback cap for a policy without one. */
  readonly recorded?: ScheduledTaskGrantedBy | undefined;
}): string | null {
  if (input.policy === undefined) return ROUTINE_GRANT_GONE_NOTE;
  if (input.policy.revokedAt !== null) return ROUTINE_GRANT_REVOKED_NOTE;
  const grant = effectiveGrant(input.policy, input.managers);
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
  if (input.task === undefined) return null;
  if (!accountInGrant(grant.accounts, input.task.modelSelection.instanceId))
    return ROUTINE_GRANT_ACCOUNT_NOTE;
  const cap = input.policy.runtimeCap ?? input.recorded?.runtimeCap ?? null;
  if (
    cap !== null &&
    exceededDispatchModeLimit(
      { runtimeMode: cap, interactionMode: "default" },
      { runtimeMode: input.task.runtimeMode, interactionMode: "default" },
    ) !== undefined
  )
    return ROUTINE_GRANT_MODE_NOTE;
  return null;
}

/** The grant a routine was made or last changed under, if any. */
export const readRoutineGrant = Effect.fn("ScheduledTaskGrantGate.read")(function* (
  taskId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly run_policy_json: string | null }>`
    SELECT run_policy_json FROM scheduled_tasks WHERE task_id = ${taskId}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const grantedBy = yield* decodeRoutineGrantJson(row.run_policy_json);
  return grantedBy !== undefined && grantedBy.coordinatorEnvironmentId.length > 0
    ? grantedBy
    : undefined;
});

/**
 * The work origin a grant routine's own thread records before it starts, so
 * the thread, and everything it starts, runs under the grant like a thread
 * that machine launched here directly (revoking the grant interrupts it).
 */
export const routineWorkOrigin = (coordinatorEnvironmentId: string): WorkOrigin => {
  const coordinator = EnvironmentId.make(coordinatorEnvironmentId);
  return { coordinatorEnvironmentId: coordinator, path: [coordinator], hops: 1 };
};

/** What the gate decided for one fire. */
export type RoutineGrantHold =
  /** Turned off with `note`; it never fires again until someone turns it back on. */
  | { readonly kind: "off"; readonly note: string }
  /** This fire does not run; the routine stays on and tries again next time. */
  | { readonly kind: "skip"; readonly note: string }
  /** A grant routine its grant still allows: it runs under these limits. */
  | {
      readonly kind: "run";
      readonly coordinatorEnvironmentId: string;
      readonly accounts: StudioWorkGrantAccounts;
    };

export interface RoutineGrantGateDeps {
  readonly sql: SqlClient.SqlClient;
  readonly grants: WorkGrants.WorkGrantsShape;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
}

/**
 * Checks `task` against the grant it was made under. Null for a routine the
 * owner made (one indexed read). A routine its grant no longer allows is
 * turned off with the note. A check that fails skips this fire: a grant
 * routine never runs unchecked.
 */
export const makeRoutineGrantGate =
  (deps: RoutineGrantGateDeps) =>
  (
    task: Pick<ScheduledTask, "id" | "projectId" | "runtimeMode" | "modelSelection">,
  ): Effect.Effect<RoutineGrantHold | null> =>
    Effect.gen(function* () {
      const recorded = yield* readRoutineGrant(task.id).pipe(
        Effect.provideService(SqlClient.SqlClient, deps.sql),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read a routine's work grant", {
            taskId: task.id,
            cause,
          }).pipe(Effect.as("unreadable" as const)),
        ),
      );
      if (recorded === undefined) return null;
      // Not knowing whether a grant holds it is no licence to run it.
      // Without the grant store (a server built without fleet) the grant cannot be read either.
      if (recorded === "unreadable" || !deps.grants.enabled)
        return { kind: "skip", note: ROUTINE_GRANT_CHECK_FAILED_NOTE } as const;
      return yield* Effect.gen(function* () {
        const coordinator = recorded.coordinatorEnvironmentId;
        const policies = yield* deps.grants.policies;
        const policy = policies.find((record) => record.coordinatorEnvironmentId === coordinator);
        // This machine's own sessions, no network; unreadable skips the fire.
        const managers = yield* deps.grants.managers;
        const row = yield* deps.projects.get(task.projectId);
        const note = routineGrantRefusal({
          coordinatorEnvironmentId: coordinator,
          policy,
          managers,
          project: Option.isNone(row)
            ? undefined
            : { id: row.value.projectId, workspaceSettings: row.value.workspaceSettings ?? null },
          task,
          recorded,
        });
        if (note === null)
          return {
            kind: "run",
            coordinatorEnvironmentId: coordinator,
            accounts: effectiveGrant(policy!, managers).accounts,
          } as const;
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
        return { kind: "off", note } as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check a routine's work grant; skipped this run", {
            taskId: task.id,
            cause,
          }).pipe(Effect.as({ kind: "skip", note: ROUTINE_GRANT_CHECK_FAILED_NOTE } as const)),
        ),
      );
    });
