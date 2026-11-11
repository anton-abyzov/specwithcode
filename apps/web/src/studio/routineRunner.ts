/**
 * Where a linked project's routines run (1267 D-12). The runner is the copy
 * that coordinates. Copies that coordinate side by side (each machine may
 * start its own coordinator) each run their own routines, so none of them has
 * a runner elsewhere. Only a copy that gave its coordinator away rests: its
 * coordinator-owned routines run on the copy that took over, and a page
 * showing the resting copy reads and changes them there, so an edit is never
 * overwritten by the runner's next replica. Routines bound to a worker thread
 * and webhook routines never travel; they keep running on their own machine.
 */
import { projectCoordinatorIsFenced, type ScheduledTask } from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { logicalCoordinator } from "./projectDomain";

export interface RoutineRunner {
  readonly member: EnvironmentProject;
  /** Whether this device reaches the runner now. */
  readonly online: boolean;
}

/**
 * Whether a routine follows the project's coordinator to its runner: one with
 * a thread of its own that is not a webhook. The server rests and replicates
 * exactly these (`isCoordinatorOwnedRoutine` and the webhook rule in
 * `ScheduledTaskCoordinatorGate`); every other routine runs where it is.
 */
export const routineFollowsCoordinator = (task: Pick<ScheduledTask, "ownThread" | "schedule">) =>
  task.ownThread === true && task.schedule.type !== "webhook";

/**
 * The copy that runs `viewed`'s coordinator-owned routines when `viewed` rests
 * (its coordinator was handed over or is being handed over): the successor it
 * names when that copy coordinates, else the newest coordinating copy. Null
 * when the viewed copy coordinates (also beside other coordinating copies),
 * is not linked, or no other copy coordinates. `online` tells whether this
 * device can reach it.
 */
export function routineRunnerOf(
  viewed: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceSettings"> | undefined,
  projects: readonly EnvironmentProject[],
  reachable: (member: EnvironmentProject) => boolean,
): RoutineRunner | null {
  const logicalId = viewed?.workspaceSettings?.logicalProject?.id;
  if (viewed === undefined || logicalId === undefined) return null;
  if (!projectCoordinatorIsFenced(viewed.workspaceSettings)) return null;
  const members = projects.filter(
    (project) => project.workspaceSettings?.logicalProject?.id === logicalId,
  );
  const successor = viewed.workspaceSettings?.coordinatorBinding?.successor;
  const runner =
    members.find(
      (member) =>
        member.environmentId === successor?.environmentId &&
        member.id === successor?.projectId &&
        member.workspaceSettings?.coordinatorBinding?.state === "active",
    ) ?? logicalCoordinator(members)?.member;
  if (
    runner === undefined ||
    (runner.environmentId === viewed.environmentId && runner.id === viewed.id)
  )
    return null;
  return { member: runner, online: reachable(runner) };
}
