/**
 * A project thread's helper on another machine. Work asked for in a project
 * runs in that project's copy there; a machine with no copy of the project
 * can still run a check for it in a scratch folder, and that thread stays the
 * project's: the sending machine lists it under the project and the thread
 * there names the project it came from.
 */
import type { OrchestratorMcpMachineRef, Project } from "@specweave-studio/contracts";

import { savedWorkerMachine } from "../../../fleet/RemoteWorkers.ts";

/** Whether this project has a copy on that machine: a linked member or a saved worker project. */
export function projectHasCopyOn(
  project: Project,
  machine: Pick<OrchestratorMcpMachineRef, "id" | "environmentId">,
): boolean {
  const members = project.workspaceSettings?.logicalProject?.members ?? [];
  return (
    members.some((member) => member.environmentId === machine.environmentId) ||
    savedWorkerMachine(project, machine)?.projectId != null
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
