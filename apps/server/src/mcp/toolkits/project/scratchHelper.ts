/**
 * A project thread's helper on another machine. Work asked for in a project
 * runs in that project's copy there; a machine with no copy of the project
 * can still run a check for it in a scratch folder, and that thread stays the
 * project's: the sending machine lists it under the project and the thread
 * there names the project it came from.
 */
import type { OrchestratorMcpMachineRef, Project } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";

/** Whether this project has a copy on that machine: a linked member or a saved worker project. */
export function projectHasCopyOn(
  project: Project,
  machine: Pick<OrchestratorMcpMachineRef, "id" | "environmentId">,
): boolean {
  const members = project.workspaceSettings?.logicalProject?.members ?? [];
  return (
    members.some((member) => member.environmentId === machine.environmentId) ||
    RemoteWorkers.savedWorkerMachine(project, machine)?.projectId != null
  );
}

/**
 * Whether a project thread may start a scratch thread on that machine without
 * `projectless`: only when the machine has no copy of the project to run it in.
 */
export function mayStartScratchHelper(
  project: Project | undefined,
  machine: Pick<OrchestratorMcpMachineRef, "id" | "environmentId">,
): boolean {
  return project !== undefined && !projectHasCopyOn(project, machine);
}

/**
 * The same check against what that machine reports now: a project with no
 * link or saved binding can still match a checkout there by repository, and
 * then the work belongs in that checkout. Only a confirmed "none" allows the
 * helper; an unreachable machine, a partial list or an unreadable answer
 * keeps the old rule.
 */
export const confirmScratchHelper = (
  project: Project | undefined,
  machine: Pick<OrchestratorMcpMachineRef, "id" | "environmentId">,
) =>
  Effect.gen(function* () {
    if (!mayStartScratchHelper(project, machine) || project === undefined) return false;
    const remote = yield* RemoteWorkers.RemoteWorkers;
    // Asks that machine alone, now, for its whole project list.
    const listed = yield* remote.listMachines({
      projectId: project.id,
      probe: true,
      only: machine.id,
      fresh: true,
    });
    const row = listed.machines.find(
      (candidate) =>
        candidate.id === machine.id && candidate.environmentId === machine.environmentId,
    );
    // A grant that shows only some projects there cannot show that none matches.
    const seesAll = row?.projectScope === undefined || row.projectScope === "all";
    return row?.reachable === true && seesAll && row.project?.match === "none";
  }).pipe(Effect.orElseSucceed(() => false));
