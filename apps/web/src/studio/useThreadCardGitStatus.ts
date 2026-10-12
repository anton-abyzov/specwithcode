import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { VcsStatusResult } from "@specweave-studio/contracts";

import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

/**
 * The source control status of a thread's checkout, for its card's quick actions.
 * Read the way the sidebar reads it: only for a thread on a branch or worktree of
 * its own, and without polling the remote, so a long chat of cards stays cheap.
 */
export function useThreadCardGitStatus(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "branch" | "worktreePath">,
  projectRoot: string | null,
): VcsStatusResult | null {
  const cwd = thread.worktreePath ?? projectRoot;
  const query = useEnvironmentQuery(
    cwd !== null && (thread.branch !== null || thread.worktreePath !== null)
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd, includeRemote: false },
        })
      : null,
  );
  return query.data ?? null;
}
