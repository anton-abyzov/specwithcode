/**
 * Which machines "Add to another machine…" offers: one rule for the machine menu's entry
 * and for the dialog's list, so the entry never opens a dialog with no machine in it.
 *
 * @module addableMachines
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { repositoryKeyOf } from "@specweave-studio/shared/existingCopy";

import { linkedMachineIds } from "./linkedMachines";
import { isArchivedMember } from "./projectListVisibility";
import { isProjectFolder } from "./projectMachineFolders";
import { machineHoldings } from "./sendToMachine";

/**
 * The folders of this project on other machines: linked to it, or of the same repository.
 * A linked folder counts even when its repository reads differently there.
 */
export function projectFoldersElsewhere(
  project: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject[] {
  const repositoryKey = repositoryKeyOf(project);
  const logicalId = project.workspaceSettings?.logicalProject?.id ?? null;
  return projects.filter(
    (item) =>
      item.environmentId !== project.environmentId &&
      !isArchivedMember(item) &&
      isProjectFolder(item.workspaceRoot, item.id) &&
      ((logicalId !== null && item.workspaceSettings?.logicalProject?.id === logicalId) ||
        (repositoryKey !== null && repositoryKeyOf(item) === repositoryKey)),
  );
}

/**
 * The machines without the project: no saved folder, no copy found there, and not a member
 * the project names (one this window never opened has the project all the same).
 */
export function addableMachineIds(input: {
  readonly project: EnvironmentProject;
  readonly machineIds: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Old records of machines that joined again; the same set Settings passes. */
  readonly retired?: { has(environmentId: string): boolean } | undefined;
}): string[] {
  const { project } = input;
  const folders = projectFoldersElsewhere(project, input.projects);
  const holdings = machineHoldings({
    source: project,
    machineIds: input.machineIds,
    projects: [project, ...folders],
    retired: input.retired,
  });
  const linked = linkedMachineIds([project]);
  return input.machineIds.filter(
    (id) =>
      id !== project.environmentId &&
      !folders.some((item) => item.environmentId === id) &&
      (holdings.byMachine.get(id)?.kind ?? "none") === "none" &&
      !linked.has(id),
  );
}
