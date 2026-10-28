import type { ProjectWorktree, ProjectWorktreesRemoval } from "@specweave-studio/contracts";

import { formatBytes } from "../../studio/folderCopy";

/** What the person ticked in the delete dialog. */
export interface ProjectWorktreeChoice {
  /** Remove the worktrees that hold nothing but committed work. */
  readonly removeClean: boolean;
  /** Also remove the ones with uncommitted files, losing those files. */
  readonly discardChanges: boolean;
}

export interface ProjectWorktreeSummary {
  readonly removable: ReadonlyArray<ProjectWorktree>;
  readonly localChanges: ReadonlyArray<ProjectWorktree>;
  /** In use elsewhere or not a removable worktree: always kept. */
  readonly kept: ReadonlyArray<ProjectWorktree>;
  readonly removableBytes: number;
  readonly localChangesBytes: number;
  /** Worktrees whose branch has commits no remote has. The branch keeps them. */
  readonly localCommitBranches: number;
}

export interface ProjectWorktreeRemovalRequest {
  readonly paths: ReadonlyArray<string>;
  readonly discardLocalChanges: ReadonlyArray<string>;
}

const totalBytes = (worktrees: ReadonlyArray<ProjectWorktree>) =>
  worktrees.reduce((sum, worktree) => sum + (worktree.sizeBytes ?? 0), 0);

export function summarizeProjectWorktrees(
  worktrees: ReadonlyArray<ProjectWorktree>,
): ProjectWorktreeSummary {
  const removable = worktrees.filter((worktree) => worktree.status === "removable");
  const localChanges = worktrees.filter((worktree) => worktree.status === "local_changes");
  return {
    removable,
    localChanges,
    kept: worktrees.filter(
      (worktree) => worktree.status === "in_use" || worktree.status === "not_removable",
    ),
    removableBytes: totalBytes(removable),
    localChangesBytes: totalBytes(localChanges),
    localCommitBranches: [...removable, ...localChanges].filter(
      (worktree) => (worktree.localCommits ?? 0) > 0,
    ).length,
  };
}

/** Clean worktrees lose nothing, so they are ticked; uncommitted files never are. */
export function defaultProjectWorktreeChoice(
  summary: ProjectWorktreeSummary,
): ProjectWorktreeChoice {
  return { removeClean: summary.removable.length > 0, discardChanges: false };
}

export function projectWorktreeRemovalRequest(
  summary: ProjectWorktreeSummary,
  choice: ProjectWorktreeChoice,
): ProjectWorktreeRemovalRequest | null {
  const clean = choice.removeClean ? summary.removable.map((worktree) => worktree.path) : [];
  const discard = choice.discardChanges
    ? summary.localChanges.map((worktree) => worktree.path)
    : [];
  if (clean.length === 0 && discard.length === 0) return null;
  return { paths: [...clean, ...discard], discardLocalChanges: discard };
}

export function worktreeCount(count: number): string {
  return count === 1 ? "1 worktree" : `${count} worktrees`;
}

/** "3 worktrees (12.4 GB)", leaving out an unknown size. */
export function worktreeCountWithSize(count: number, bytes: number): string {
  return bytes > 0 ? `${worktreeCount(count)} (${formatBytes(bytes)})` : worktreeCount(count);
}

export function projectWorktreeRemovalToast(
  result: ProjectWorktreesRemoval,
  sizes: ReadonlyMap<string, number | null>,
): { type: "success" | "warning"; title: string; description?: string } {
  const freed = result.removed.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
  const title =
    result.removed.length === 0
      ? "No worktrees were removed"
      : `Removed ${worktreeCount(result.removed.length)}${freed > 0 ? `, freed ${formatBytes(freed)}` : ""}`;
  if (result.kept.length === 0) return { type: "success", title };
  return {
    type: "warning",
    title,
    description: `Kept ${worktreeCount(result.kept.length)}: ${result.kept
      .map((entry) => `${entry.path} (${entry.reason})`)
      .join("; ")}`,
  };
}
