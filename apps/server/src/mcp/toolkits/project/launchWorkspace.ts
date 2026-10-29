import type { ResolvedProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { ThreadLaunchWorkspaceStrategy } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { readFolderLayout } from "../../../project/FolderLayout.ts";

/**
 * Where a launch that names no workspace starts. The project's "Use worktrees"
 * switch (its own `defaultThreadEnvMode` of "worktree") gives every new thread
 * its own worktree off the project's checked-out branch, as the composer does.
 * Only the project's own choice counts: an environment-wide workspace setting
 * and the composer's Git-aware Automatic leave launched threads in the root.
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
