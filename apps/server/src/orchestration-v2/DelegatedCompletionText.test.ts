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

  it("asks the independent verifier to record the exact completed run", () => {
    const text = delegatedCompletionWakeText(["task-1"]);
    assert.include(text, "studio_thread_record_delivery for childThreadId");
    assert.include(text, "latestTerminalRunId from task_status, or childRunId");
    assert.include(text, "confirm the current completed run with studio_thread_read");
    assert.include(text, "Record only a current successful result");
  });

  it("routes verification through the coordinator without a chain of verifiers", () => {
    const text = delegatedCompletionWakeText(["task-1"]);
    assert.include(text, "A project coordinator routes verification to a worker");
    assert.include(text, "Reuse the existing independent verifier");
    assert.include(text, "Do not start another worker just to verify a verifier's receipt");
  });

  it("lets the parent resolve an answer-only child itself", () => {
    const text = delegatedCompletionWakeText(["task-1"]);
    assert.include(text, "only answered a question or reported findings");
    assert.include(text, "record delivery yourself with kind no_code");
    assert.include(text, "so its thread resolves");
  });
});
