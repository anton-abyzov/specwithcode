import { assert, it } from "@effect/vitest";
import type { OrchestrationV2Run } from "@specweave-studio/contracts";
import {
  FAILED_RUN_BREAKER_LIMIT,
  failedRunBreakerRefusal,
  isBreakerGuardedQueuedMessage,
  isBreakerGuardedRun,
  trailingFailedRuns,
} from "./RunFailureBreaker.ts";

const runs = (...statuses: Array<OrchestrationV2Run["status"]>) =>
  statuses.map((status, index) => ({ ordinal: index + 1, status }));

it("counts the failed runs at the end of a thread, newest first", () => {
  assert.equal(trailingFailedRuns(runs()), 0);
  assert.equal(trailingFailedRuns(runs("completed", "failed", "failed")), 2);
  assert.equal(trailingFailedRuns(runs("failed", "failed", "completed")), 0);
  assert.equal(trailingFailedRuns(runs("failed", "cancelled", "failed")), 1);
  // A run still going does not end or extend the streak.
  assert.equal(trailingFailedRuns(runs("failed", "failed", "failed", "running")), 3);
  // Order comes from the ordinal, not the array.
  assert.equal(
    trailingFailedRuns([
      { ordinal: 3, status: "failed" },
      { ordinal: 1, status: "failed" },
      { ordinal: 4, status: "completed" },
      { ordinal: 2, status: "failed" },
    ]),
    0,
  );
});

it("pauses automatic runs after three failures in a row and never a person's message", () => {
  assert.equal(FAILED_RUN_BREAKER_LIMIT, 3);
  const streak = runs("completed", "failed", "failed", "failed");
  assert.include(failedRunBreakerRefusal(true, streak), "last 3 runs failed");
  assert.isNull(failedRunBreakerRefusal(false, streak));
  assert.isNull(failedRunBreakerRefusal(true, runs("failed", "failed")));
  // A successful run after the streak starts the count again.
  assert.isNull(failedRunBreakerRefusal(true, [...streak, { ordinal: 5, status: "completed" }]));
});

it("guards routine fires and provider-open retries, not limit recovery or people", () => {
  const command = (messageId: string, creationSource = "server") => ({
    commandId: `command:${messageId}`,
    messageId,
    creationSource,
  });
  const scheduled = command("scheduled-task-message:task:2026-11-19T06:00", "web");
  assert.isTrue(isBreakerGuardedRun(scheduled));
  assert.isTrue(isBreakerGuardedRun(command("provider-retry:run-1")));
  assert.isTrue(isBreakerGuardedRun(command("provider-fallback:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("limit-fallback:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("limit-resume:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("provider-retry:run-1", "web")));
  assert.isFalse(isBreakerGuardedRun(command("message:web:abc", "web")));
});

it("lets a person's Run now of a routine through, judged after the task id", () => {
  const fire = (messageId: string, scheduledTaskId: string | undefined = "task:manual") => ({
    commandId: "scheduled-task:x",
    messageId,
    creationSource: "server",
    scheduledTaskId,
  });
  const id = (key: string) => `scheduled-task-message:task:manual:${key}`;
  assert.isFalse(isBreakerGuardedRun(fire(id("manual:command:abc"))));
  assert.isFalse(isBreakerGuardedRun(fire(id("7f0c-11aa:manual"))));
  // The task id holds ":manual:", yet these are scheduled and webhook fires.
  assert.isTrue(isBreakerGuardedRun(fire(id("2026-11-19T06:00:00Z:scheduled"))));
  assert.isTrue(isBreakerGuardedRun(fire(id("webhook:delivery-1"))));
  // Without the task id nothing can be read as Run now.
  assert.isTrue(isBreakerGuardedRun(fire(id("manual:command:abc"), undefined)));
});

it("judges a queued run by its message id and task", () => {
  const guarded = (messageId: string, task?: string) =>
    isBreakerGuardedQueuedMessage(messageId, "thread-1", task);
  assert.isTrue(guarded("scheduled-task-message:task-1:2026-11-19T06:00", "task-1"));
  assert.isFalse(guarded("scheduled-task-message:task-1:manual:command:abc", "task-1"));
  assert.isTrue(guarded("provider-retry:thread-1:run-3"));
  assert.isTrue(guarded("provider-fallback:thread-1:run-3"));
  assert.isFalse(guarded("provider-retry:thread-2:run-3"));
  assert.isFalse(guarded("message:web:abc"));
});
