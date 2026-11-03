import type { ProjectId, ScheduledTask, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type CoordinatorRoleShape,
  type CoordinatorRoleStatus,
  coordinatorRoleOf,
} from "../project/CoordinatorRole.ts";
import type { CoordinatorWakeGateShape } from "../project/CoordinatorWakeGate.ts";
import { isCoordinatorOwnedRoutine } from "./ScheduledTaskCopies.ts";

/**
 * Where a project's coordinator-owned routines fire: only on the copy that
 * coordinates it, read again before every fire. Several machines may hold the
 * same routine (the coordinator, and its standby's copy, see
 * ScheduledTaskCopies); the coordinator binding and its epoch decide which one
 * runs it, so a takeover moves the routines with the coordinator and the old
 * machine's rest once it gives way.
 *
 * - `rest`: this copy does not coordinate. A due run moves on to its next
 *   time, with one note, as for a paused project.
 * - `wait`: this copy coordinates but must not start its coordinator now: it
 *   is being handed to another machine, or it has not heard from its standby
 *   for long enough that the standby may be taking over (CoordinatorWakeGate).
 *   The run stays due and is tried again on the next poll; that way a copy
 *   superseded while it was away never fires before it hears it gave way.
 *
 * A routine bound to a worker thread follows that worker, never the coordinator,
 * and a webhook routine stays with the machine its URL points to.
 */
export type RoutineCoordinatorHold =
  | { readonly kind: "rest"; readonly note: string }
  | { readonly kind: "wait"; readonly reason: string };

export const RESTING_ROUTINE_NOTE =
  "Not run on this machine: another machine runs this project's coordinator. It runs here if this one takes over.";
export const HANDOFF_ROUTINE_WAIT = "Waiting: this project is being handed to another machine.";

export interface RoutineCoordinatorGateDeps {
  /** This machine's coordinator roles; without it the project's own binding is read. */
  readonly role: CoordinatorRoleShape | undefined;
  readonly wakeGate: CoordinatorWakeGateShape;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
}

/** Why `task` may not fire on this copy now, or null when it may. Never fails. */
export const makeRoutineCoordinatorGate =
  (deps: RoutineCoordinatorGateDeps) =>
  (
    task: Pick<ScheduledTask, "projectId" | "ownThread" | "schedule">,
  ): Effect.Effect<RoutineCoordinatorHold | null> =>
    Effect.gen(function* () {
      // A webhook routine never travels (its URL and secret are this machine's), so it is never held.
      if (!isCoordinatorOwnedRoutine(task) || task.schedule.type === "webhook") return null;
      const row = yield* deps.projects
        .get(task.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      // A project that is gone is refused by admission, with its own message.
      if (Option.isNone(row)) return null;
      const role: Option.Option<CoordinatorRoleStatus> =
        deps.role === undefined
          ? Option.some(
              coordinatorRoleOf({
                id: row.value.projectId,
                workspaceSettings: row.value.workspaceSettings ?? undefined,
              }),
            )
          : yield* deps.role.roleOf(task.projectId);
      if (Option.isNone(role)) return null;
      if (role.value.state === "transferring")
        return { kind: "wait", reason: HANDOFF_ROUTINE_WAIT } as const;
      if (!role.value.active) return { kind: "rest", note: RESTING_ROUTINE_NOTE } as const;
      const coordinatorThread = (row.value.workspaceSettings?.coordinatorThreadId ??
        `project-coordinator:${task.projectId}`) as ThreadId;
      const fenced = yield* deps.wakeGate.check(coordinatorThread);
      return fenced === null ? null : ({ kind: "wait", reason: fenced } as const);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check where a routine's project coordinates", {
          projectId: task.projectId as ProjectId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
