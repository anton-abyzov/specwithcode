import { assert, describe, it } from "@effect/vitest";

import {
  DELEGATED_RESULT_VERIFY_SENTENCE,
  delegatedCompletionWakeText,
} from "./DelegatedCompletionText.ts";

describe("delegatedCompletionWakeText", () => {
  it("names one task and asks the parent to check the result", () => {
    const text = delegatedCompletionWakeText(["task-1"]);
    assert.isTrue(
      text.startsWith(
        "Delegated task task-1 reached a terminal state. Use task_status with taskId task-1 to read the result.",
      ),
    );
    assert.isTrue(text.endsWith(DELEGATED_RESULT_VERIFY_SENTENCE));
  });

  it("names several tasks and asks the parent to check the results", () => {
    const text = delegatedCompletionWakeText(["task-1", "task-2"]);
    assert.isTrue(text.startsWith("Delegated tasks task-1, task-2 reached terminal states."));
    assert.isTrue(text.endsWith(DELEGATED_RESULT_VERIFY_SENTENCE));
  });

  it("leaves verification to a worker when the parent is a project coordinator", () => {
    assert.include(
      DELEGATED_RESULT_VERIFY_SENTENCE,
      "A project coordinator does not check it itself",
    );
    assert.include(DELEGATED_RESULT_VERIFY_SENTENCE, "starts a worker to verify it");
  });
});
