/**
 * Where a linked project's routines run (1267 D-12): on the copy whose
 * coordinator holds the current epoch, the runner. Its copy is the only one
 * written; other machines keep resting copies for takeover. A page showing a
 * resting copy reads and changes the runner's routines instead, so an edit
 * made there is never overwritten by the runner's next replica.
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { logicalCoordinator } from "./projectDomain";

export interface RoutineRunner {
  readonly member: EnvironmentProject;
  /** Whether this device reaches the runner now. */
  readonly online: boolean;
}

/**
 * The copy that runs `viewed`'s routines when that is another machine's copy,
 * else null (the viewed copy runs them, it is not linked, or no copy
 * coordinates). `online` tells whether this device can reach it.
 */
export function routineRunnerOf(
  viewed: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceSettings"> | undefined,
  projects: readonly EnvironmentProject[],
  reachable: (member: EnvironmentProject) => boolean,
): RoutineRunner | null {
  const logicalId = viewed?.workspaceSettings?.logicalProject?.id;
  if (viewed === undefined || logicalId === undefined) return null;
  const members = projects.filter(
    (project) => project.workspaceSettings?.logicalProject?.id === logicalId,
  );
  const runner = logicalCoordinator(members)?.member;
  if (runner === undefined || runner.environmentId === viewed.environmentId) return null;
  return { member: runner, online: reachable(runner) };
}
