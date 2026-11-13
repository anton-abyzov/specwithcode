// @effect-diagnostics nodeBuiltinImport:off - Plain promises over the project folder, like FolderLayout.
import type { ResolvedProjectSettings } from "@specweave-studio/shared/projectSettings";
import type { ThreadLaunchWorkspaceStrategy } from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  repositoriesNamedInTask,
  taskRepositoryNames,
  TASK_REPOSITORIES_MAX,
  type TaskRepositoryMention,
} from "@specweave-studio/shared/taskRepositories";

import { readFolderLayout } from "../../../project/FolderLayout.ts";
import {
  availableRepositories,
  cloneHasCommit,
  discoverProjectRepositories,
  foundRepositoryLines,
  type ProjectRepositoryDiscovery,
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

/** What the launcher is told when a thread starts in its own folder, with the repositories its message names. */
export const EMPTY_THREAD_FOLDER_NOTICE =
  'Use worktrees is on and this project folder holds separate clones, so the thread starts in its own folder on its own branch, with a worktree of each repository its message names by path (with none named, no repository yet). It adds a worktree of any other repository it changes with studio_worktree_add_repository. To choose yourself, pass workspaceStrategy {type:"worktree", baseRef, repositories:[...]} with paths relative to the project folder.';

/** The first line of a thread's notice: what it starts with, and why. */
function startsWithLine(input: {
  readonly workspaceRoot: string;
  readonly picked: ReadonlyArray<TaskRepositoryMention>;
  readonly named: ReadonlyArray<TaskRepositoryMention>;
  readonly noCommit: ReadonlyArray<TaskRepositoryMention>;
}): string {
  const folder = `The project folder is ${input.workspaceRoot}; read anything there.${
    input.noCommit.length === 0
      ? ""
      : ` Its task also names ${taskRepositoryNames(input.noCommit)}, which ${input.noCommit.length === 1 ? "has" : "have"} no commit to start a worktree from, so ${input.noCommit.length === 1 ? "it was" : "they were"} not added.`
  }`;
  const [only] = input.picked;
  if (only !== undefined && input.picked.length === 1)
    return `This thread works in its own folder (its working directory), on its own branch. It starts with a worktree of ${only.name} (${only.relativePath}), because its task names ${only.evidence}. ${folder}`;
  if (input.picked.length > 1)
    return `This thread works in its own folder (its working directory), on its own branch. It starts with a worktree of each repository its task names: ${input.picked
      .map((mention) => `${mention.name} (${mention.relativePath}, named as ${mention.evidence})`)
      .join("; ")}. ${folder}`;
  if (input.named.length > TASK_REPOSITORIES_MAX)
    return `This thread works in its own folder (its working directory), on its own branch, with no repository yet: its task names ${input.named.length} repositories (${taskRepositoryNames(input.named)}), which reads as a list, so add only the ones it changes. ${folder}`;
  return `This thread works in its own folder (its working directory), on its own branch, with no repository yet. ${folder}`;
}

/**
 * What a thread that starts in its own folder reads with its first message:
 * the repositories it started with and why, the ones it can add, and the
 * rules for changing them.
 */
export function emptyThreadFolderNotice(input: {
  readonly workspaceRoot: string;
  /** `foundRepositoryLines` of the project folder. */
  readonly repositories: string;
  /** What `repositoriesNamedInTask` found in the thread's message. */
  readonly picked?: ReadonlyArray<TaskRepositoryMention> | undefined;
  readonly named?: ReadonlyArray<TaskRepositoryMention> | undefined;
  /** Named and available, but with no commit to cut a worktree from. */
  readonly noCommit?: ReadonlyArray<TaskRepositoryMention> | undefined;
}): string {
  const picked = input.picked ?? [];
  return [
    startsWithLine({
      workspaceRoot: input.workspaceRoot,
      picked,
      named: input.named ?? [],
      noCommit: input.noCommit ?? [],
    }),
    `Before changing ${picked.length > 0 ? "any other" : "a"} repository, add it with studio_worktree_add_repository, naming it by its path relative to the project folder. Its worktree then sits at the same relative path inside this thread's folder; edit and commit there. Adding a repository installs no dependencies: run that repository's normal install in its worktree only when you build or test there, and never link another checkout's node_modules.`,
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
  const [sources, rootEntries, layout] = await Promise.all([
    readIncrementRepositorySources(input.increment),
    NodeFSP.readdir(root).catch((): Array<string> => []),
    readFolderLayout(root),
  ]);
  // Clones of their own (a `.git` folder) own the task files under them, in any layout.
  const clones = (layout?.repositories ?? [])
    .map((relative) => NodePath.join(root, ...relative.split("/")))
    .filter((folder) => {
      try {
        return NodeFS.statSync(NodePath.join(folder, ".git")).isDirectory();
      } catch {
        return false;
      }
    });
  const candidates = incrementRepositoryCandidates({
    projectRoot: root,
    checkouts: input.checkouts,
    clones,
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
 * The repositories a thread's task names among the clones it can get a
 * worktree of here. Only clones inside the project folder count, named by
 * their relative path, so a path written on another machine names the same
 * clone on this one. A clone with no commit (a fresh `git init`) is left out
 * of `picked` and listed in `noCommit`: a worktree could not start from it,
 * and the thread would fail instead of starting.
 */
export async function taskRepositoryPick(
  discovery: ProjectRepositoryDiscovery | null,
  text: string,
) {
  const available = availableRepositories(discovery);
  const { picked, named } = repositoriesNamedInTask(text, available);
  const checked = await Promise.all(
    picked.map(async (mention) => {
      const row = available.find((repository) => repository.relativePath === mention.relativePath);
      return { mention, usable: row !== undefined && (await cloneHasCommit(row.path)) };
    }),
  );
  return {
    picked: checked.filter((entry) => entry.usable).map((entry) => entry.mention),
    named,
    noCommit: checked.filter((entry) => !entry.usable).map((entry) => entry.mention),
  };
}

/**
 * A worktree launch that names no repository, in a project folder of separate
 * clones, starts in its own folder with a worktree of each repository its
 * message names (`taskRepositoryPick`), else none (`repositories: []`), and
 * its first message carries `notice`. Anywhere else an empty list is dropped:
 * it means a single worktree, as before. Every other strategy is returned as
 * it came.
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
  /** The thread's first message, which may name the repositories it changes. */
  taskText = "",
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
  const { picked, named, noCommit } = await taskRepositoryPick(found, taskText);
  return {
    workspaceStrategy: { ...single, repositories: picked.map((mention) => mention.relativePath) },
    notice: emptyThreadFolderNotice({
      workspaceRoot: project.workspaceRoot,
      repositories: foundRepositoryLines(found),
      picked,
      named,
      noCommit,
    }),
  };
}
