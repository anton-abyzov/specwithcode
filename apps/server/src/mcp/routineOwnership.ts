/**
 * A grantee runs, changes or deletes only routines its own grant made: the
 * owner's routines here stay the owner's, and another machine's stay that
 * machine's. The same rule update_scheduled_task applies.
 */
import {
  OrchestratorMcpFailure,
  type ScheduledTaskError,
  type ScheduledTaskGrantedBy,
  type ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { WorkGrantContext } from "./workGrantAccess.ts";

/** Why `work` may not act on the routine, or null when its own grant made it. */
export function othersRoutineRefusal(
  work: Pick<WorkGrantContext, "coordinatorLabel"> & {
    readonly grant: Pick<WorkGrantContext["grant"], "coordinatorEnvironmentId">;
  },
  task: { readonly title: string },
  grantedBy: Pick<ScheduledTaskGrantedBy, "coordinatorEnvironmentId"> | undefined,
  action: "change" | "run" | "delete" = "change",
): string | null {
  if (grantedBy?.coordinatorEnvironmentId === work.grant.coordinatorEnvironmentId) return null;
  const where =
    grantedBy === undefined ? "was set up on this machine" : "was set up by another machine's work";
  return `Routine "${task.title}" ${where}, so ${work.coordinatorLabel}'s work can't ${action} it. Ask the user here to ${action} it, or schedule a new routine.`;
}

/** Fails with `outside_grant_scope` unless `work` is undefined or its grant made the routine. */
export const refuseOthersRoutine = (
  readGrant:
    | ((
        id: ScheduledTaskId,
      ) => Effect.Effect<ScheduledTaskGrantedBy | undefined, ScheduledTaskError>)
    | undefined,
  work: WorkGrantContext | undefined,
  task: { readonly id: ScheduledTaskId; readonly title: string },
  action: "change" | "run" | "delete",
) =>
  Effect.gen(function* () {
    if (work === undefined) return;
    const grantedBy =
      readGrant === undefined
        ? undefined
        : yield* readGrant(task.id).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Could not load scheduled task: ${error.message}`,
                }),
            ),
          );
    const refusal = othersRoutineRefusal(work, task, grantedBy, action);
    if (refusal !== null)
      return yield* new OrchestratorMcpFailure({ code: "outside_grant_scope", message: refusal });
  });
