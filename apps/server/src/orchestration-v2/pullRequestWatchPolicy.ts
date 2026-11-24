/**
 * Whether a thread defers pull request watching to its parent.
 *
 * A subagent or delegated task reports to its parent thread, which owns the
 * pull request: its own watch would wake it on every change of a pull request
 * it was not asked to babysit. A project coordinator's worker is the
 * exception. It opens and owns its pull requests, and the coordinator never
 * watches for it, so it watches its own (`watch_pull_request` says so).
 */
export function defersPullRequestWatchToParent(thread: {
  readonly projectId: string;
  readonly lineage: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: string | null;
  };
}): boolean {
  if (thread.lineage.relationshipToParent !== "subagent") return false;
  return thread.lineage.parentThreadId !== `project-coordinator:${thread.projectId}`;
}
