import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { isAutomatedProject } from "@specweave-studio/shared/projectOrigin";

import { usableCopy } from "../../studio/addToMachine";

/**
 * This machine's projects a person would put on another machine, by name: the
 * ones Settings > Machines lists as its own (not scratch, not made by a check
 * or an agent) that Run on would also accept as a copy (not archived, a real
 * project folder, not the personal assistant, which runs only where it
 * lives). Whether one can be cloned there, for example whether it has a Git
 * remote, is the Add to another machine dialog's question and its message.
 */
export function projectsToAdd(
  projects: ReadonlyArray<EnvironmentProject>,
  hereEnvironmentId: EnvironmentId | null,
  scratchWorkspaceRoot?: string | null,
): ReadonlyArray<EnvironmentProject> {
  if (hereEnvironmentId === null) return [];
  return projects
    .filter(
      (project) =>
        project.environmentId === hereEnvironmentId &&
        usableCopy(project) &&
        !isScratchProject(project, scratchWorkspaceRoot) &&
        !isAutomatedProject(project),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
}
