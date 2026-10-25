/**
 * What a project's design board knows about its owner: where new design systems
 * go, whether the project still takes new work, and which of the list's problems
 * are its own.
 */
import type { DesignOwnerInput, ProjectId } from "@specweave-studio/contracts";

import type { OwnerProject } from "../systems/reviewModel";
import type { GalleryProject } from "./DesignActions";
import type { GalleryScope } from "./galleryModel";

/** Settings > Design systems, defaulting new systems to the board's project when it takes them. */
export const designSystemsHref = (project: GalleryProject | null) =>
  project === null || project.unavailable !== undefined
    ? "/settings/design-systems"
    : `/settings/design-systems?project=${encodeURIComponent(project.id)}`;

/** What a picker says beside a project whose folder is gone. */
export const FOLDER_MISSING = "Folder missing";

export interface OwnerProblem {
  readonly ownerLabel: string;
  readonly detail: string;
  /** The exact owner, from servers that send it; older servers send only the label. */
  readonly owner?: DesignOwnerInput | undefined;
}

/** Whether a problem is about this project: by id when the server names it, else by title. */
export const problemIsAbout = (
  problem: OwnerProblem,
  project: { readonly id: ProjectId; readonly title: string },
) =>
  problem.owner === undefined
    ? problem.ownerLabel === project.title
    : problem.owner.kind === "project" && problem.owner.projectId === project.id;

/** A list key for a problem that stays unique when project titles repeat. */
export function problemKey(problem: OwnerProblem): string {
  const owner =
    problem.owner === undefined
      ? problem.ownerLabel
      : problem.owner.kind === "project"
        ? problem.owner.projectId
        : "playground";
  return `${owner}:${problem.detail}`;
}

const MISSING_FOLDER = /^The folder(?: (.+))? is missing\.$/;

/** The folder a "The folder … is missing." problem names, "" when it names none, else null. */
export function missingFolderOf(detail: string): string | null {
  const match = MISSING_FOLDER.exec(detail.trim());
  return match === null ? null : (match[1] ?? "");
}

/**
 * Projects whose folder the design list could not find, by id, with the folder's
 * path: the one the server names, else the project's own record of it, else "".
 */
export function missingFolderProjects(
  problems: readonly OwnerProblem[],
  projects: readonly {
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot?: string | undefined;
  }[],
): ReadonlyMap<ProjectId, string> {
  const missing = new Map<ProjectId, string>();
  for (const problem of problems) {
    const path = missingFolderOf(problem.detail);
    if (path === null) continue;
    const project = projects.find((candidate) => problemIsAbout(problem, candidate));
    if (project !== undefined) missing.set(project.id, path || project.workspaceRoot || "");
  }
  return missing;
}

/** "its folder /Users/me/app is missing." */
export const missingFolderText = (path: string) =>
  path === "" ? "its folder is missing." : `its folder ${path} is missing.`;

/**
 * The list problems a scope shows: a project's board shows only that project's,
 * the Playground only its own, Projects every project's, All everything.
 */
export function problemsInScope<P extends OwnerProblem>(
  problems: readonly P[],
  scope: GalleryScope,
  label: string,
): P[] {
  switch (scope.kind) {
    case "all":
      return [...problems];
    case "projects":
      return problems.filter((problem) =>
        problem.owner === undefined
          ? problem.ownerLabel !== "Playground"
          : problem.owner.kind === "project",
      );
    case "playground":
      return problems.filter((problem) =>
        problem.owner === undefined
          ? problem.ownerLabel === label
          : problem.owner.kind === "playground",
      );
    case "project":
      return problems.filter((problem) =>
        problemIsAbout(problem, { id: scope.projectId, title: label }),
      );
  }
}

/** Why a board makes nothing new: its project is archived, automated or has lost its folder. */
export function creationOffReason(project: GalleryProject | null): string | null {
  if (project === null || project.unavailable === undefined) return null;
  if (project.missingFolder !== undefined)
    return `${project.title}: ${missingFolderText(project.missingFolder)} New designs are off until it is back.`;
  if (project.unavailable.startsWith("Archived"))
    return `${project.title} is archived, so new designs are off. Restore it to add designs here.`;
  if (project.unavailable.startsWith("Automated"))
    return `${project.title} is an automated project, so new designs are off here.`;
  return `New designs are off in ${project.title}.`;
}

/** Marks projects whose folder is gone as not available, as archived ones are. */
export function withMissingFolders<P extends OwnerProject>(
  projects: readonly P[],
  missing: { has: (id: ProjectId) => boolean },
): P[] {
  return projects.map((project) =>
    project.unavailable === undefined && missing.has(project.id)
      ? { ...project, unavailable: FOLDER_MISSING }
      : project,
  );
}

/** Leaves out projects whose folder the design list could not find. */
export function withoutMissingFolders<
  P extends { readonly id: ProjectId; readonly title: string; readonly workspaceRoot?: string },
>(projects: readonly P[], problems: readonly OwnerProblem[]): P[] {
  const missing = missingFolderProjects(problems, projects);
  return projects.filter((project) => !missing.has(project.id));
}
