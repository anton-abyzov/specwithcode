import type { EnvironmentId } from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";

import {
  isArchivedMember,
  isAutomatedMember,
  isScratchMember,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";

/**
 * The projects whose handoff mode can be set on one machine. The list shows only the
 * person's own active projects; archived ones and ones a check or agent made for itself
 * (handoff proofs, release checks) are kept apart, as the sidebar keeps them. A machine's
 * "No project" folder is not a project, and a personal assistant stays on its machine,
 * so neither has a mode to set.
 */
export function partitionHandoffModeProjects<P extends ProjectListMember>(
  projects: ReadonlyArray<P>,
  environmentId: EnvironmentId,
  scratchRootFor: ScratchRootLookup,
): { readonly active: P[]; readonly automated: P[]; readonly archived: P[] } {
  const settable = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !isPersonalAssistantProject(project) &&
      !isScratchMember(project, scratchRootFor),
  );
  const archived = settable.filter(isArchivedMember);
  const current = settable.filter((project) => !isArchivedMember(project));
  return {
    active: current.filter((project) => !isAutomatedMember(project)),
    automated: current.filter(isAutomatedMember),
    archived,
  };
}

interface TitledProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot?: string | undefined;
}

/**
 * Tells apart projects with the same name on one machine, usually one repository in
 * several folders: each gets the shortest end of its folder path that no other
 * same-named project shares.
 */
export function sameTitleFolderHints(projects: ReadonlyArray<TitledProject>): Map<string, string> {
  const byTitle = new Map<string, TitledProject[]>();
  for (const project of projects) {
    const key = project.title.trim().toLocaleLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), project]);
  }
  const hints = new Map<string, string>();
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    const segments = same.map((project) =>
      (project.workspaceRoot ?? "").split(/[\\/]/).filter(Boolean),
    );
    same.forEach((project, index) => {
      const own = segments[index]!;
      for (let depth = 1; depth <= own.length; depth += 1) {
        const tail = own.slice(-depth).join("/");
        const shared = segments.some(
          (other, otherIndex) => otherIndex !== index && other.slice(-depth).join("/") === tail,
        );
        if (!shared || depth === own.length) {
          hints.set(project.id, depth === own.length ? (project.workspaceRoot ?? tail) : tail);
          break;
        }
      }
    });
  }
  return hints;
}
