import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { isAutomatedProject } from "@specweave-studio/shared/projectOrigin";

/**
 * This machine's projects a person would put on another machine, by name: not
 * archived, not made by a check or an agent, and not the personal assistant,
 * which runs only where it lives. Whether one can be cloned there is the Add
 * to another machine dialog's question, not this list's.
 */
export function projectsToAdd(
  projects: ReadonlyArray<EnvironmentProject>,
  hereEnvironmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentProject> {
  if (hereEnvironmentId === null) return [];
  return projects
    .filter(
      (project) =>
        project.environmentId === hereEnvironmentId &&
        !project.workspaceSettings?.archived &&
        project.workspaceSettings?.kind !== "personal" &&
        !isAutomatedProject(project),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
}
