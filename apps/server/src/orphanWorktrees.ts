/**
 * Worktrees no thread owns: agents create them with `git worktree add` for a PR,
 * a review or a merge check, and nothing removed them once that work finished.
 * On one Mac they reached 171 GB (about 6 GB each with dependencies). The
 * "Delete merged worktrees" rule removes them as well, under stricter terms
 * than a thread's worktree, because no thread can recreate them.
 *
 * @module orphanWorktrees
 */

/** A day without a commit or checkout change, so an agent still finishing up keeps its folder. */
export const ORPHAN_WORKTREE_IDLE_MS = 86_400_000;

/** The orphan pass runs at most hourly: each candidate can cost a pull request lookup. */
export const ORPHAN_SWEEP_INTERVAL_MS = 3_600_000;

export type OrphanWorktreeFacts = {
  /** Null for a detached HEAD (review and merge-check checkouts). */
  readonly branch: string | null;
  readonly hasWorkingTreeChanges: boolean;
  /** Ignored files other than dependency installs can hold secrets or local data. */
  readonly onlyDependencyIgnores: boolean;
  /** Commits on HEAD that no remote-tracking ref contains. */
  readonly unpushedCommits: number;
  readonly pullRequestState: "open" | "closed" | "merged" | null;
  /** HEAD's content is already in the refreshed default branch (ancestor or squash-merged). */
  readonly integratedInDefault: boolean;
  readonly idleMs: number;
};

/**
 * True when removing the folder loses nothing: no changes, nothing unpushed (or a
 * merged PR whose content is on the default branch), finished work, and idle a day.
 * A branch with an open PR or no PR is kept, since it may still be in progress.
 */
export function orphanWorktreeRemovable(
  facts: OrphanWorktreeFacts,
  idleMs: number = ORPHAN_WORKTREE_IDLE_MS,
): boolean {
  // An unknown idle time (NaN) is never idle enough.
  if (
    facts.hasWorkingTreeChanges ||
    !facts.onlyDependencyIgnores ||
    !Number.isFinite(facts.idleMs) ||
    facts.idleMs < idleMs
  )
    return false;
  if (facts.branch === null) return facts.unpushedCommits === 0;
  if (facts.pullRequestState === "merged")
    return facts.unpushedCommits === 0 || facts.integratedInDefault;
  return facts.pullRequestState === "closed" && facts.unpushedCommits === 0;
}

/** `git ls-files --others --ignored --directory -z` output holds only dependency installs. */
export function onlyDependencyIgnores(stdout: string): boolean {
  return stdout.split("\0").every((entry) => entry === "" || /(^|\/)node_modules\/$/.test(entry));
}

/** The gitdir a linked worktree's `.git` file points at, or null for anything else. */
export function linkedWorktreeGitDir(dotGitFile: string): string | null {
  const match = /^gitdir: (.+)$/m.exec(dotGitFile);
  const gitDir = match?.[1]?.trim() ?? "";
  return /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) ? gitDir : null;
}
