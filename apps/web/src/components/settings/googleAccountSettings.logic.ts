import type { GoogleService, ProjectId } from "@specweave-studio/contracts";

import {
  isArchivedMember,
  isScratchMember,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";

interface GoogleProjectAccess {
  readonly projectId: ProjectId;
  readonly services: ReadonlyArray<GoogleService>;
}

/**
 * The projects Google access is offered to: active ones in the main list, archived ones
 * apart. Scratch is not a project. Personal projects lead, since a personal agent lives there.
 */
export function partitionGoogleProjects<
  P extends ProjectListMember & {
    readonly title: string;
    readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
  },
>(projects: ReadonlyArray<P>, scratchRootFor: ScratchRootLookup) {
  const sorted = projects
    .filter((project) => !isScratchMember(project, scratchRootFor))
    .toSorted(
      (left, right) =>
        Number(right.workspaceSettings?.kind === "personal") -
          Number(left.workspaceSettings?.kind === "personal") ||
        left.title.localeCompare(right.title),
    );
  return {
    active: sorted.filter((project) => !isArchivedMember(project)),
    archived: sorted.filter(isArchivedMember),
  };
}

/** The access changes that turn one service on or off for the given projects; unchanged ones are left out. */
export function bulkServiceChanges(
  access: ReadonlyArray<GoogleProjectAccess>,
  projectIds: ReadonlyArray<ProjectId>,
  service: GoogleService,
  on: boolean,
): GoogleProjectAccess[] {
  const changes: GoogleProjectAccess[] = [];
  for (const projectId of projectIds) {
    const current = access.find((entry) => entry.projectId === projectId)?.services ?? [];
    if (current.includes(service) === on) continue;
    changes.push({
      projectId,
      services: on ? [...current, service] : current.filter((entry) => entry !== service),
    });
  }
  return changes;
}

/** The access changes that give every project all the granted services it lacks. */
export function enableAllChanges(
  access: ReadonlyArray<GoogleProjectAccess>,
  projectIds: ReadonlyArray<ProjectId>,
  granted: ReadonlyArray<GoogleService>,
): GoogleProjectAccess[] {
  const changes: GoogleProjectAccess[] = [];
  for (const projectId of projectIds) {
    const current = access.find((entry) => entry.projectId === projectId)?.services ?? [];
    const missing = granted.filter((service) => !current.includes(service));
    if (missing.length > 0) changes.push({ projectId, services: [...current, ...missing] });
  }
  return changes;
}
