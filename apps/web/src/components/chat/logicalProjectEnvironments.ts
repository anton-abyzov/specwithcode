import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "~/logicalProject";
import type { EnvironmentPresentation } from "~/state/environments";
import type { Project } from "~/types";
import { isArchivedMember, type ScratchRootLookup } from "~/studio/projectListVisibility";
import type { EnvironmentOption } from "../BranchToolbar.logic";

/** Draft routing offers only active destinations; the current project's history is untouched. */
export function buildLogicalProjectEnvironments(input: {
  readonly activeProject: Project | null;
  readonly activeProjectIsScratch: boolean;
  readonly draftId: string | null;
  readonly allProjects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly scratchWorkspaceRootFor: ScratchRootLookup;
}): EnvironmentOption[] {
  const {
    activeProject,
    activeProjectIsScratch,
    draftId,
    allProjects,
    environments,
    environmentById,
    primaryEnvironmentId,
    projectGroupingSettings,
    scratchWorkspaceRootFor,
  } = input;
  if (!activeProject) return [];
  const envs: EnvironmentOption[] = [];
  const pushEnvironment = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
    const environment = environmentById.get(environmentId) ?? null;
    envs.push({
      environmentId,
      projectId,
      label: environment?.label ?? environmentId,
      isPrimary: environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
    });
  };
  if (activeProjectIsScratch && draftId) {
    // Each machine keeps its own "No project" folder at its own path, so they
    // never group as one logical project. Offer every machine that has one.
    for (const environment of environments) {
      const scratchRoot = scratchWorkspaceRootFor(environment.environmentId);
      // Keep the current machine visible so an offline source can still switch away.
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : allProjects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      if (scratchProject && isArchivedMember(scratchProject)) continue;
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const seen = new Set<string>();
    for (const p of allProjects) {
      const currentHistory =
        !draftId && p.environmentId === activeProject.environmentId && p.id === activeProject.id;
      if (isArchivedMember(p) && !currentHistory) continue;
      if (seen.has(p.environmentId)) continue;
      if (deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) !== logicalKey) continue;
      seen.add(p.environmentId);
      pushEnvironment(p.environmentId, p.id);
    }
  }
  // Sort: primary first, then alphabetical
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}
