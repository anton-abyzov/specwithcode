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
  assert.isTrue(isBreakerGuardedRun(command("scheduled-task-message:task:2026-11-19T06:00", "web")));
  assert.isTrue(isBreakerGuardedRun(command("provider-retry:run-1")));
  assert.isTrue(isBreakerGuardedRun(command("provider-fallback:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("limit-fallback:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("limit-resume:run-1")));
  assert.isFalse(isBreakerGuardedRun(command("provider-retry:run-1", "web")));
  assert.isFalse(isBreakerGuardedRun(command("message:web:abc", "web")));
});

it("lets a person's Run now of a routine through", () => {
  const fire = (messageId: string) => ({ commandId: "scheduled-task:x", messageId, creationSource: "server" });
  assert.isFalse(isBreakerGuardedRun(fire("scheduled-task-message:task-1:manual:command:abc")));
  assert.isFalse(isBreakerGuardedRun(fire("scheduled-task-message:task-1:7f0c:manual")));
  assert.isTrue(isBreakerGuardedRun(fire("scheduled-task-message:task-1:webhook:delivery-1")));
});

it("judges a queued run by its message id", () => {
  assert.isTrue(isBreakerGuardedQueuedMessage("scheduled-task-message:task-1:2026-11-19T06:00", "thread-1"));
  assert.isFalse(isBreakerGuardedQueuedMessage("scheduled-task-message:task-1:manual:command:abc", "thread-1"));
  assert.isTrue(isBreakerGuardedQueuedMessage("provider-retry:thread-1:run-3", "thread-1"));
  assert.isTrue(isBreakerGuardedQueuedMessage("provider-fallback:thread-1:run-3", "thread-1"));
  assert.isFalse(isBreakerGuardedQueuedMessage("provider-retry:thread-2:run-3", "thread-1"));
  assert.isFalse(isBreakerGuardedQueuedMessage("message:web:abc", "thread-1"));
});
