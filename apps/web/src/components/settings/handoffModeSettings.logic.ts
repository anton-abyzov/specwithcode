import type { EnvironmentId } from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";

import {
  isArchivedMember,
  isScratchMember,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";

/**
 * The projects whose handoff mode can be set on one machine: active ones in the list,
 * archived ones apart. A machine's "No project" folder is not a project, and a personal
 * assistant stays on its machine, so neither has a mode to set.
 */
export function partitionHandoffModeProjects<P extends ProjectListMember>(
  projects: ReadonlyArray<P>,
  environmentId: EnvironmentId,
  scratchRootFor: ScratchRootLookup,
): { readonly active: P[]; readonly archived: P[] } {
  const settable = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !isPersonalAssistantProject(project) &&
      !isScratchMember(project, scratchRootFor),
  );
  return {
    active: settable.filter((project) => !isArchivedMember(project)),
    archived: settable.filter(isArchivedMember),
  };
}
