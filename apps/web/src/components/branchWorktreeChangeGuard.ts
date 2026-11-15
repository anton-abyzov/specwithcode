import type { ThreadRuntimeSummary } from "@specweave-studio/client-runtime/state/shell";

import { deriveCanInterruptRunningThread } from "../session-logic";

export const WORKTREE_CHANGE_BLOCKED_MESSAGE = "Stop the current turn to switch worktrees.";

/**
 * A branch pick that moves the thread to another worktree would stop the turn
 * that is running in the current one. Such a pick is refused until the user
 * stops the turn; a branch change inside the same worktree stays allowed.
 */
export function isWorktreeChangeBlocked(input: {
  runtime: ThreadRuntimeSummary | null;
  currentWorktreePath: string | null;
  nextWorktreePath: string | null;
}): boolean {
  return (
    input.nextWorktreePath !== input.currentWorktreePath &&
    deriveCanInterruptRunningThread(true, input.runtime)
  );
}
