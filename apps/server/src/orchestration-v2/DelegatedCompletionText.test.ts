import { assert, describe, it } from "@effect/vitest";

import { NodeId } from "@specweave-studio/contracts";

import {
  ADVISOR_WAKE_ADVICE_MAX_LENGTH,
  DELEGATED_RESULT_VERIFY_SENTENCE,
  delegatedCompletionWakeText,
} from "./DelegatedCompletionText.ts";
import { SUBAGENT_NO_RESULT_TEXT } from "./SubagentProjection.ts";

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

  it("lets the parent resolve a question-only child itself", () => {
    const text = delegatedCompletionWakeText(["task-1"]);
    assert.include(text, "asked only to answer a question or look something up");
    assert.include(text, "with no change requested");
    assert.include(text, "record delivery yourself with kind no_code");
    assert.include(text, "the app refuses no_code for a run that changed files");
  });

  it("keeps the delegated-task notice unchanged for ordinary task rows", () => {
    const rows = [
      { id: NodeId.make("task-1"), status: "completed" as const, result: "done" },
      { id: NodeId.make("task-2"), status: "failed" as const, result: null },
    ];
    assert.strictEqual(
      delegatedCompletionWakeText(["task-1", "task-2"], rows),
      delegatedCompletionWakeText(["task-1", "task-2"]),
    );
  });
});

describe("delegatedCompletionWakeText for an advisor consult", () => {
  const advisor = (
    id: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string | null,
  ) => ({ id: NodeId.make(id), purpose: "advisor" as const, status, result });

  it("carries the advice as a review to weigh, with no delivery to record", () => {
    const text = delegatedCompletionWakeText(
      ["advice-1"],
      [advisor("advice-1", "completed", "  Test the empty list before you ship.\n")],
    );
    assert.isTrue(
      text.startsWith("The advisor you consulted earlier (task advice-1) has answered."),
    );
    assert.include(text, "not an instruction from the user");
    assert.include(text, "Reconcile it with the evidence this thread holds");
    assert.include(
      text,
      "<advisor-advice>\nTest the empty list before you ship.\n</advisor-advice>",
    );
    assert.notInclude(text, "studio_thread_record_delivery");
    assert.notInclude(text, "task_status");
    assert.notInclude(text, "Check the child's claim");
  });

  it("says plainly that a consult without advice gave none", () => {
    for (const row of [
      advisor("a", "failed", "Provider error: overloaded"),
      advisor("a", "cancelled", null),
      advisor("a", "interrupted", null),
      advisor("a", "completed", "   "),
      advisor("a", "completed", null),
      // What the app records for a completed child that said nothing.
      advisor("a", "completed", SUBAGENT_NO_RESULT_TEXT),
    ]) {
      const text = delegatedCompletionWakeText(["a"], [row]);
      assert.strictEqual(
        text,
        "The advisor you consulted earlier (task a) ended without giving advice; carry on without it.",
      );
    }
  });

  it("trims long advice and names task_status for the rest", () => {
    const long = "x".repeat(ADVISOR_WAKE_ADVICE_MAX_LENGTH + 500);
    const text = delegatedCompletionWakeText(["a"], [advisor("a", "completed", long)]);
    assert.include(
      text,
      `<advisor-advice>\n${"x".repeat(ADVISOR_WAKE_ADVICE_MAX_LENGTH)}\n</advisor-advice>`,
    );
    assert.notInclude(text, "x".repeat(ADVISOR_WAKE_ADVICE_MAX_LENGTH + 1));
    assert.isTrue(
      text.endsWith(
        "The advice was cut at 32,000 characters; call task_status with taskId a to read all of it.",
      ),
    );
    const exact = "y".repeat(ADVISOR_WAKE_ADVICE_MAX_LENGTH);
    assert.notInclude(
      delegatedCompletionWakeText(["a"], [advisor("a", "completed", exact)]),
      "was cut",
    );
  });

  it("gives a mixed cohort the advice and the unchanged notice for the ordinary tasks only", () => {
    const text = delegatedCompletionWakeText(
      ["work-1", "advice-1", "work-2"],
      [
        advisor("advice-1", "completed", "Looks sound."),
        { id: NodeId.make("work-1"), status: "completed", result: "built it" },
      ],
    );
    const [advice, notice, ...rest] = text.split("\n\n");
    assert.deepEqual(rest, []);
    assert.include(advice, "(task advice-1) has answered");
    assert.include(advice, "Looks sound.");
    assert.strictEqual(notice, delegatedCompletionWakeText(["work-1", "work-2"]));
    assert.notInclude(notice, "advice-1");
  });
});
