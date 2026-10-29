/**
 * Which workspace new threads should use for what a project folder holds. A
 * folder of separate clones, such as an umbrella's `repositories/<owner>/<repo>`
 * or sibling microservice checkouts, works best in its current checkout: a
 * worktree of the folder holds none of their code. One Git repository works
 * best with a worktree per thread. This only advises; it never changes a setting.
 *
 * @module folderLayoutGuidance
 */
import type { ProjectFolderCheck, ThreadEnvMode } from "@specweave-studio/contracts";

export type FolderLayout = NonNullable<ProjectFolderCheck["layout"]>;

/**
 * The folder holds clones of other repositories. In a Git repository a single
 * stray clone (an editable pip install, a vendored checkout) does not make it
 * multi-repository: that takes an umbrella layout or at least two checkouts.
 * Older servers send no `separateClones` and count submodules as checkouts, so
 * for them only the umbrella layout counts.
 */
export function holdsSeparateClones(layout: FolderLayout): boolean {
  if (layout.separateClones === undefined) return layout.kind === "umbrella";
  if (!layout.separateClones) return false;
  return !layout.rootIsRepository || layout.kind === "umbrella" || layout.repositoryCount >= 2;
}

/**
 * The recommended workspace, or null when nothing in the folder suggests one,
 * including a walk that stopped early before finding any clone.
 */
export function recommendedWorkspace(layout: FolderLayout): ThreadEnvMode | null {
  if (holdsSeparateClones(layout)) return "local";
  if (layout.truncated) return null;
  return layout.rootIsRepository ? "worktree" : null;
}

function repositoriesPhrase(layout: FolderLayout): string {
  const count = layout.repositoryCount;
  const more = layout.truncated ? " or more" : "";
  return `${count}${more} ${count === 1 ? "repository" : "repositories"}`;
}

export interface WorkspaceGuidance {
  readonly recommended: ThreadEnvMode;
  /** Short heading, such as for a toast title. */
  readonly title: string;
  /** Why, in a sentence or two. */
  readonly detail: string;
}

export function workspaceGuidance(layout: FolderLayout): WorkspaceGuidance | null {
  const recommended = recommendedWorkspace(layout);
  if (recommended === null) return null;
  if (recommended === "worktree") {
    return {
      recommended,
      title: "One Git repository: worktrees recommended",
      detail:
        "Each thread gets its own worktree and branch, so parallel threads do not share one checkout.",
    };
  }
  const kind = layout.kind === "umbrella" ? "an umbrella" : "a multi-repository folder";
  const why = layout.rootIsRepository
    ? "A worktree of the folder would hold none of their code, so threads are best kept in the current checkout."
    : "It is not a Git repository itself, so threads work in the folder.";
  return {
    recommended,
    title: "Multi-repository folder: current checkout recommended",
    detail: `This folder is ${kind} holding ${repositoriesPhrase(layout)}. ${why} To isolate a thread, give it a worktree of one repository.`,
  };
}

/** One line for the Use worktrees setting: the recommendation and why. */
export function worktreesSettingRecommendation(layout: FolderLayout): string | null {
  const guidance = workspaceGuidance(layout);
  if (guidance === null) return null;
  return `Recommended for this folder: ${guidance.recommended === "worktree" ? "on" : "off"}. ${guidance.detail}`;
}
