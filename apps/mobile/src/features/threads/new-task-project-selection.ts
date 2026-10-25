import {
  projectChoiceIneligibleReason,
  projectPickerMembers,
  type ScratchRootLookup,
} from "@specweave-studio/client-runtime/state/project-picker";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@specweave-studio/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

/** An explicit machine remains draft context even after its last project disappears. */
export function resolveNewTaskEnvironment(
  projects: readonly EnvironmentProject[],
  selectedEnvironmentId: EnvironmentId | null,
  labelFor: (environmentId: EnvironmentId) => string | undefined,
): { environmentId: EnvironmentId | null; environmentLabel: string } {
  const environmentId = selectedEnvironmentId ?? projects[0]?.environmentId ?? null;
  return {
    environmentId,
    environmentLabel:
      environmentId === null ? "Environment" : (labelFor(environmentId) ?? environmentId),
  };
}

/** Both machine choices and execution use this same eligible matching catalog. */
export function newTaskDestinationProjects(
  projects: readonly EnvironmentProject[],
  selected: EnvironmentProject | null,
  scratchRootFor: ScratchRootLookup,
): EnvironmentProject[] {
  return projectPickerMembers(projects, scratchRootFor).filter(
    (project) => resolveEnvironmentProjectMatch([project], selected) !== null,
  );
}

/** A saved draft remains visible while its project is unavailable for new work. */
export function newTaskProjectUnavailableReason(
  project: EnvironmentProject | null,
  scratchRootFor: ScratchRootLookup,
  missingFromCatalog = false,
): string | null {
  if (missingFromCatalog)
    return "This project is no longer available. Choose an active project to start this task.";
  if (project === null) return "Choose an active project to start this task.";
  const reason = projectChoiceIneligibleReason(project, scratchRootFor);
  // Starting without a project is a separate, explicit action in the task flow.
  if (reason === null || reason === "scratch") return null;
  return reason === "archived"
    ? "This project is archived. Choose an active project to start this task."
    : "This project is automated. Choose an active project to start this task.";
}

/** Last live metadata is display context only; its identity must match the explicit key. */
export function retainNewTaskProjectContext(
  selectedProjectKey: string | null,
  live: EnvironmentProject | undefined,
  retained: EnvironmentProject | null,
): EnvironmentProject | null {
  if (live) return live;
  return selectedProjectKey !== null &&
    retained !== null &&
    scopedProjectKey(retained.environmentId, retained.id) === selectedProjectKey
    ? retained
    : null;
}

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

/**
 * Picks the project on a target environment that corresponds to the project
 * currently selected in the new-task flow, so switching computers follows the
 * same repo. Repository identity is preferred; projects without one (e.g. not
 * yet indexed) fall back to workspace basename, then title. A selected draft
 * never falls through to an unrelated project on another machine.
 */
export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would match nothing meaningful.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // The weaker signals only apply where identity is unknown on at least one
  // side; two known, different repositories never match on a shared basename
  // or title (mirrors the environment list filter in the new-task flow).
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    (selectedProject === null ? projectsOnTarget[0] : null) ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (selectedProjectKey !== null) {
    // A missing explicit choice owns its draft until the user replaces it.
    // Only a genuinely blank task can adopt the sole eligible project.
    return { kind: hasExplicitProjectSelection ? "preserve" : "unavailable" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}
