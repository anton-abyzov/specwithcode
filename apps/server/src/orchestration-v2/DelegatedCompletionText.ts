/**
 * Shared wording for waking a parent thread when delegated tasks finish.
 * Both the orchestrator and the provider continuation path use it, so the
 * parent always gets the same instruction to check the child's result.
 * A project coordinator reads no files and runs no commands, so the sentence
 * tells it to hand verification to a worker instead of checking it itself.
 */
export const DELEGATED_RESULT_VERIFY_SENTENCE =
  "The result is the child's claim: check it against the real state (git diff or commits, test output, the files named) before you rely on it or report it. A project coordinator does not check it itself: only when it will act on the result, it starts a worker to verify it.";

export function delegatedCompletionWakeText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  const lead =
    taskIds.length === 1
      ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
      : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
  return `${lead} ${DELEGATED_RESULT_VERIFY_SENTENCE}`;
}
