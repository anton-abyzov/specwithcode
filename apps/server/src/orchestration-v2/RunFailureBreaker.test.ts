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

it("starts a new streak at a failed run a person's message started", () => {
  type Message = NonNullable<Parameters<typeof trailingFailedRuns>[1]>[number];
  const message = (id: string, creationSource: Message["creationSource"], scheduledTaskId?: string) =>
    ({
      id,
      role: "user",
      creationSource,
      ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
    }) as Message;
  const streak = [
    { ordinal: 1, status: "failed" as const, userMessageId: "scheduled-task-message:t:1" },
    { ordinal: 2, status: "failed" as const, userMessageId: "scheduled-task-message:t:2" },
    { ordinal: 3, status: "failed" as const, userMessageId: "scheduled-task-message:t:3" },
  ] as Parameters<typeof trailingFailedRuns>[0];
  const messages = [
    message("scheduled-task-message:t:1", "server", "t"),
    message("scheduled-task-message:t:2", "server", "t"),
    message("scheduled-task-message:t:3", "server", "t"),
    message("message:person", "web"),
    message("provider-retry:thread:run-4", "server"),
    message("scheduled-task-message:t:manual:c", "server", "t"),
  ];
  const after = (...more: Array<[string, OrchestrationV2Run["status"]]>) => [
    ...streak,
    ...more.map(([userMessageId, status], index) => ({ ordinal: 4 + index, status, userMessageId })),
  ] as Parameters<typeof trailingFailedRuns>[0];
  assert.equal(trailingFailedRuns(streak, messages), 3);
  // The person's message failed to open: its retry may still start.
  const personFailed = after(["message:person", "failed"]);
  assert.equal(trailingFailedRuns(personFailed, messages), 1);
  assert.isNull(failedRunBreakerRefusal(true, personFailed, messages));
  // Its retries count from it, and the third failure pauses again.
  const retriesFailed = after(
    ["message:person", "failed"],
    ["provider-retry:thread:run-4", "failed"],
    ["provider-retry:thread:run-4", "failed"],
  );
  assert.include(failedRunBreakerRefusal(true, retriesFailed, messages), "last 3 runs failed");
  // A routine's Run now resets like a message; an automatic fire does not.
  assert.equal(trailingFailedRuns(after(["scheduled-task-message:t:manual:c", "failed"]), messages), 1);
  assert.equal(trailingFailedRuns(after(["scheduled-task-message:t:3", "failed"]), messages), 4);
  // Without the messages every failure counts.
  assert.equal(trailingFailedRuns(personFailed), 4);
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
  const fire = (messageId: string, scheduledTaskId: string | null = "task:manual") => ({
    commandId: "scheduled-task:x",
    messageId,
    creationSource: "server",
    ...(scheduledTaskId === null ? {} : { scheduledTaskId }),
  });
  const id = (key: string) => `scheduled-task-message:task:manual:${key}`;
  assert.isFalse(isBreakerGuardedRun(fire(id("manual:command:abc"))));
  assert.isFalse(isBreakerGuardedRun(fire(id("7f0c-11aa:manual"))));
  // The task id holds ":manual:", yet these are scheduled and webhook fires.
  assert.isTrue(isBreakerGuardedRun(fire(id("2026-11-19T06:00:00Z:scheduled"))));
  assert.isTrue(isBreakerGuardedRun(fire(id("webhook:delivery-1"))));
  // Without the task id nothing can be read as Run now.
  assert.isTrue(isBreakerGuardedRun(fire(id("manual:command:abc"), null)));
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
