// @effect-diagnostics nodeBuiltinImport:off - Plain promises over the project folder, like FolderLayout.
import type { ResolvedProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { ThreadLaunchWorkspaceStrategy } from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readFolderLayout } from "../../../project/FolderLayout.ts";
import {
  discoverProjectRepositories,
  foundRepositoryLines,
  type SavedRepositoryEntry,
} from "../../../project/ProjectRepositoryDiscovery.ts";
import {
  incrementRepositoryCandidates,
  readIncrementRepositorySources,
} from "../../../project/incrementRepositories.ts";
import type { LaunchRepositoryCheckout } from "../../../orchestration-v2/ThreadLaunchService.ts";

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

/** What the launcher is told when a thread starts in its own folder with no repository yet. */
export const EMPTY_THREAD_FOLDER_NOTICE =
  'Use worktrees is on and this project folder holds separate clones, so the thread starts in its own folder on its own branch with no repository yet. It adds a worktree of each repository it changes with studio_worktree_add_repository. To start with some, pass workspaceStrategy {type:"worktree", baseRef, repositories:[...]} with paths relative to the project folder.';

/**
 * What a thread that starts in its own empty folder reads with its first
 * message: the repositories it can add and the rules for changing them.
 */
export function emptyThreadFolderNotice(input: {
  readonly workspaceRoot: string;
  /** `foundRepositoryLines` of the project folder. */
  readonly repositories: string;
}): string {
  return [
    `This thread works in its own folder (its working directory), on its own branch, with no repository yet. The project folder is ${input.workspaceRoot}; read anything there.`,
    "Before changing a repository, add it with studio_worktree_add_repository, naming it by its path relative to the project folder. Its worktree then sits at the same relative path inside this thread's folder; edit and commit there. Adding a repository installs no dependencies: run that repository's normal install in its worktree only when you build or test there, and never link another checkout's node_modules.",
    "Do not edit or commit in the project folder's clones. SpecWeave planning stays in the project folder: run specweave there.",
    ...(input.repositories === ""
      ? []
      : [
          `Repositories in the project folder (name: path, origin, branch):\n${input.repositories}`,
        ]),
  ].join("\n");
}
/** Why a launch for an increment got a worktree set, and where its planning stays. */
export function worktreeSetNotice(input: {
  readonly incrementId: string;
  readonly repositories: ReadonlyArray<string>;
  readonly workspaceRoot: string;
}): string {
  return `Use worktrees is on and increment ${input.incrementId} changes ${input.repositories.length === 1 ? "repository" : "repositories"} ${input.repositories.join(", ")}, so the thread gets one folder with a worktree of each, on one branch, at each repository's path relative to the project folder. SpecWeave planning stays in the project folder (${input.workspaceRoot}): run specweave there. Each repository with commits gets its own pull request; link the others and the increment in each.`;
}

/**
 * The repositories a worktree set for `increment` holds, as launch entries
 * (environment repository ids, else paths relative to the project root, "."
 * for the root): its `metadata.json` `repositories`, else the owners of its
 * task files. Only folders that are a repository's own checkout count. Null
 * when there are none.
 */
export async function incrementWorktreeSetRepositories(input: {
  readonly workspaceRoot: string;
  readonly checkouts: ReadonlyArray<LaunchRepositoryCheckout>;
  readonly increment: { readonly root: string; readonly incrementId: string };
}): Promise<ReadonlyArray<string> | null> {
  const root = NodePath.resolve(input.workspaceRoot);
  const [sources, rootEntries] = await Promise.all([
    readIncrementRepositorySources(input.increment),
    NodeFSP.readdir(root).catch((): Array<string> => []),
  ]);
  const candidates = incrementRepositoryCandidates({
    projectRoot: root,
    checkouts: input.checkouts,
    sources,
    rootEntries: new Set(rootEntries),
  });
  const entries = candidates.flatMap((candidate) => {
    if (!NodeFS.existsSync(NodePath.join(candidate.path, ".git"))) return [];
    if (candidate.id !== undefined) return [candidate.id];
    const relative = NodePath.relative(root, candidate.path);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return [];
    return [relative === "" ? "." : relative.split(NodePath.sep).join("/")];
  });
  return entries.length === 0 ? null : entries;
}

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

/**
 * A worktree launch that names no repository, in a project folder of separate
 * clones, starts in its own empty folder (`repositories: []`), and its first
 * message carries `notice`. Anywhere else an empty list is dropped: it means a
 * single worktree, as before. Every other strategy is returned as it came.
 */
export async function emptyThreadFolderLaunch(
  strategy: ThreadLaunchWorkspaceStrategy,
  project:
    | {
        readonly id: string;
        readonly workspaceRoot: string;
        readonly workspaceSettings?:
          | {
              readonly environment?:
                | { readonly repositories: ReadonlyArray<SavedRepositoryEntry> }
                | undefined;
            }
          | undefined;
      }
    | undefined,
): Promise<{
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly notice: string | null;
}> {
  if (
    strategy.type !== "worktree" ||
    strategy.repository !== undefined ||
    (strategy.repositories?.length ?? 0) > 0
  )
    return { workspaceStrategy: strategy, notice: null };
  const { repositories: _none, ...single } = strategy;
  const found =
    project === undefined
      ? null
      : await discoverProjectRepositories({
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          saved: project.workspaceSettings?.environment?.repositories,
        });
  if (project === undefined || found?.separateClones !== true)
    return { workspaceStrategy: single, notice: null };
  return {
    workspaceStrategy: { ...single, repositories: [] },
    notice: emptyThreadFolderNotice({
      workspaceRoot: project.workspaceRoot,
      repositories: foundRepositoryLines(found),
    }),
  };
}
