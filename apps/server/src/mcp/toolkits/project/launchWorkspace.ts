import type { ResolvedProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { ThreadLaunchWorkspaceStrategy } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { readFolderLayout } from "../../../project/FolderLayout.ts";

/**
 * Where a launch that names no workspace starts. The project's "Use worktrees"
 * switch (its own `defaultThreadEnvMode` of "worktree") gives every new thread
 * its own worktree off the project's checked-out branch, as the composer does.
 * Only the project's own choice counts; there is no environment-wide
 * workspace default above it.
 */
export function launchWorkspaceDefault(input: {
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  /** The branch checked out in the project root; null for detached or non-Git roots. */
  readonly currentBranch: string | null;
}): ThreadLaunchWorkspaceStrategy {
  if (!projectUsesWorktrees(input.resolved) || input.currentBranch === null) {
    return { type: "root" };
  }
  return {
    type: "worktree",
    baseRef: input.currentBranch,
    startFromOrigin: input.resolved.settings.newWorktreesStartFromOrigin,
  };
}

export function projectUsesWorktrees(
  resolved: Pick<ResolvedProjectSettings, "settings" | "sources">,
): boolean {
  return (
    resolved.sources.defaultThreadEnvMode === "project" &&
    resolved.settings.defaultThreadEnvMode === "worktree"
  );
}

/**
 * Why an agent's request for a new worktree started the thread in the project
 * folder instead: the project's Use worktrees switch is off, and only the user
 * turning it on in the project's settings changes that.
 */
export const WORKTREE_OFF_NOTICE =
  "Use worktrees is off for this project, so the thread works in the project folder on whatever branch is checked out there; ask it to create or switch to its branch itself (for a nested repository, by that repository's path). For a separate worktree the user must first turn on Use worktrees in the project's settings.";

/** Why a project with Use worktrees on still started a thread in its folder. */
export const UMBRELLA_WORKTREE_NOTICE =
  'Use worktrees is on, but this project folder holds separate clones of other repositories, which a worktree of the folder would leave out, so the thread works in the project folder. For a worktree of one of them, pass workspaceStrategy {type:"worktree", repository, baseRef}.';
export const NO_BRANCH_WORKTREE_NOTICE =
  "Use worktrees is on, but the project folder has no branch checked out (a detached HEAD or no Git repository), so the thread works in the project folder.";

/**
 * Separate clones inside the project folder, such as an umbrella's
 * `repositories/<owner>/<repo>`. A submodule or worktree (a `.git` file) is
 * not one: a worktree of the folder brings submodules along.
 */
export async function holdsSeparateClones(workspaceRoot: string): Promise<boolean> {
  return (await readFolderLayout(workspaceRoot))?.separateClones === true;
}
