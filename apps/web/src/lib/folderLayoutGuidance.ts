/**
 * Which workspace new threads should use for what a project folder holds. A
 * folder of separate clones, such as an umbrella's `repositories/<owner>/<repo>`
 * or sibling microservice checkouts, gives each thread its own folder with a
 * worktree of only the repositories it changes. One Git repository works best
 * with a worktree per thread. This only advises; it never changes a setting.
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
 * The recommended workspace, or null when nothing in the folder suggests one
 * (no Git repository, or a walk that stopped early before finding any). A
 * folder of separate clones and one Git repository both work best with
 * worktrees: each thread gets a folder of its own.
 */
export function recommendedWorkspace(layout: FolderLayout): ThreadEnvMode | null {
  if (holdsSeparateClones(layout)) return "worktree";
  if (layout.truncated) return null;
  return layout.rootIsRepository ? "worktree" : null;
}

function repositoriesPhrase(layout: FolderLayout): string {
  const count = layout.repositoryCount;
  const more = layout.truncated ? " or more" : "";
  return `${count}${more} ${count === 1 ? "repository" : "repositories"}`;
}

/** What "on" means in a folder of separate clones. */
export const SEPARATE_CLONES_DETAIL =
  "Each thread gets its own folder and a worktree of only the repositories it changes.";
export const NO_REPOSITORY_DETAIL =
  "This folder holds no Git repository, so threads work in the folder.";

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
  if (!holdsSeparateClones(layout)) {
    return {
      recommended,
      title: "One Git repository: worktrees recommended",
      detail:
        "Each thread gets its own worktree and branch, so parallel threads do not share one checkout.",
    };
  }
  return {
    recommended,
    title: "Several repositories: worktrees recommended",
    detail: `This folder holds ${repositoriesPhrase(layout)}. ${SEPARATE_CLONES_DETAIL}`,
  };
}

/** What the Use worktrees switch acts on in this folder. */
export function worktreesCutFromLayout(layout: FolderLayout): string {
  if (holdsSeparateClones(layout) || (!layout.rootIsRepository && layout.repositoryCount > 0))
    return layout.repositoryCount === 1
      ? "Worktrees are cut from the repository in this folder."
      : `Worktrees are cut from the ${repositoriesPhrase(layout)} in this folder.`;
  return layout.rootIsRepository
    ? "Worktrees are cut from this folder's repository."
    : NO_REPOSITORY_DETAIL;
}

/**
 * The Use worktrees recommendation for this folder, as "Recommended for this
 * folder: on." with what on means in a folder of separate clones.
 */
export function worktreesSettingRecommendation(
  layout: FolderLayout,
): { readonly on: boolean; readonly detail: string | null; readonly text: string } | null {
  const recommended = recommendedWorkspace(layout);
  if (recommended === null) return null;
  const on = recommended === "worktree";
  const detail = !on ? null : holdsSeparateClones(layout) ? SEPARATE_CLONES_DETAIL : null;
  return {
    on,
    detail,
    text: `Recommended for this folder: ${on ? "on" : "off"}.${detail === null ? "" : ` ${detail}`}`,
  };
}

/** "Use worktrees is on. Recommended for this folder: off.", or null when they agree. */
export function worktreesSwitchDiffers(
  layout: FolderLayout,
  switchOn: boolean,
): { readonly recommendedOn: boolean; readonly text: string; readonly offer: string } | null {
  const recommended = recommendedWorkspace(layout);
  if (recommended === null || (recommended === "worktree") === switchOn) return null;
  const to = recommended === "worktree" ? "on" : "off";
  return {
    recommendedOn: recommended === "worktree",
    text: `Use worktrees is ${switchOn ? "on" : "off"}. Recommended for this folder: ${to}.`,
    offer: `Also turn Use worktrees ${to}`,
  };
}
