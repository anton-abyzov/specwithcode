/**
 * Shared wording for waking a parent thread when delegated tasks finish.
 * Both the orchestrator and the provider continuation path use it, so the
 * parent always gets the same instruction to check the child's result.
 * A project coordinator reads no files and runs no commands, so the sentence
 * tells it to hand verification to a worker instead of checking it itself,
 * except for an answer-only child, whose reply is the deliverable.
 */
export const DELEGATED_RESULT_VERIFY_SENTENCE =
  "Check the child's claim against the actual deliverable and evidence before relying on it. " +
  "Record independently verified delivery with studio_thread_record_delivery for childThreadId. " +
  "Use latestTerminalRunId from task_status, or childRunId for the original result when no later run is reported. " +
  "After a follow-up, confirm the current completed run with studio_thread_read. Record only a current successful result with no newer work pending. Skip already settled threads. " +
  "A project coordinator routes verification to a worker. Reuse the existing independent verifier or include the receipt in work that already needs verification. " +
  "Do not start another worker just to verify a verifier's receipt. " +
  "A child that only answered a question or reported findings needs no verifier when studio_thread_read view activity shows its run changed no files and opened no pull request: its reply is the deliverable. " +
  "Record delivery yourself with kind no_code, the reply as deliverable evidence, that activity check as verification, push, merge and deployment not_applicable (answer only) and no obligations, so its thread resolves.";

export function delegatedCompletionWakeText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  const lead =
    taskIds.length === 1
      ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
      : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
  return `${lead} ${DELEGATED_RESULT_VERIFY_SENTENCE}`;
}
