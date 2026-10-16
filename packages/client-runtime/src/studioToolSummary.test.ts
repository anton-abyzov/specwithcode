import { describe, expect, it } from "vite-plus/test";

import { summarizeStudioToolCalls, type StudioToolSummaryCall } from "./studioToolSummary.ts";

function completed(input: unknown, output?: unknown): StudioToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeStudioToolCalls", () => {
  it("counts registered projects, repository destinations, and accepted thread launches", () => {
    expect(
      summarizeStudioToolCalls("project-create", [
        completed({}, { id: "project-1" }),
        completed({}, { id: "project-1" }),
        completed({}, { id: "project-2" }),
      ]).label,
    ).toBe("Registered 2 projects");
    expect(
      summarizeStudioToolCalls("project-clone", [
        completed({}, { cwd: "/tmp/first" }),
        completed({}, { cwd: "/tmp/second" }),
      ]).label,
    ).toBe("Cloned 2 repositories");
    expect(
      summarizeStudioToolCalls("thread-create", [
        completed({}, { threadId: "launched-thread", status: "preparing" }),
      ]).label,
    ).toBe("Created 1 thread");
  });

  it.each([
    ["queue-read", "Read 1 queued message"],
    ["queue-edit", "Edited 1 queued message"],
    ["queue-cancel", "Requested cancellation of 1 queued run"],
    ["queue-reorder", "Reordered 1 queued run"],
    ["queue-steer", "Requested steering with 1 queued message"],
  ] as const)("deduplicates the queued run target for %s", (action, label) => {
    expect(
      summarizeStudioToolCalls(action, [
        completed({ queuedRunId: "queued-1" }),
        completed({ queuedRunId: "queued-1" }),
        { input: { queuedRunId: "queued-2" }, output: undefined, outcome: "unfinished" },
      ]),
    ).toEqual({ label, failedCount: 0 });
  });

  it("counts answered requests rather than pretending every request contains one question", () => {
    expect(
      summarizeStudioToolCalls("question-respond", [
        completed({ requestId: "request-1", answers: { one: ["Yes"], two: ["No"] } }),
        completed({ requestId: "request-1" }),
        completed({ requestId: "request-2" }),
      ]).label,
    ).toBe("Answered 2 pending question requests");
  });

  it("counts attachments in distinct messages and falls back when attachment counts are missing", () => {
    const first = completed(
      { threadId: "thread-1", attachments: [{ id: "one" }, { id: "two" }] },
      { messageId: "message-1", threadId: "thread-1" },
    );
    const second = completed(
      { threadId: "thread-2", attachments: [{ id: "one" }] },
      { messageId: "message-2", threadId: "thread-2" },
    );
    expect(summarizeStudioToolCalls("attachment-send", [first, first, second])).toEqual({
      label: "Sent 3 attachments to 2 threads",
      failedCount: 0,
    });
    expect(
      summarizeStudioToolCalls("attachment-send", [first, completed({ threadId: "thread-1" })])
        .label,
    ).toBe("Sent attachments to 1 thread 2 times");
  });

  it("keeps repeated manual runs separate and describes asynchronous controls as requests", () => {
    expect(
      summarizeStudioToolCalls("schedule-run", [
        completed({ taskId: "schedule-1" }, { lastRunStatus: "running" }),
        completed({ taskId: "schedule-1" }, { lastRunStatus: "skipped" }),
      ]).label,
    ).toBe("Requested 2 scheduled task runs");
    expect(
      summarizeStudioToolCalls("thread-fork", [
        completed({}, { targetThreadId: "fork", sequence: 3 }),
      ]).label,
    ).toBe("Requested 1 thread fork");
    expect(
      summarizeStudioToolCalls("thread-merge", [
        completed({ targetThreadId: "parent" }, { sequence: 4 }),
      ]).label,
    ).toBe("Requested 1 context merge");
  });

  it.each([
    "WorktreeMcpFailure",
    "DeviceOperationError",
    "PreviewAutomationExecutionError",
    "PullRequestOperationError",
  ])("treats a returned %s as a failed call even if the provider says completed", (_tag) => {
    const output = [
      {
        type: "content",
        content: { type: "text", text: JSON.stringify({ _tag, message: "Unavailable" }) },
      },
    ];
    expect(summarizeStudioToolCalls("browser", [completed({}, output)])).toEqual({
      label: "Tried to use browser 1 time",
      failedCount: 1,
    });
  });
  it("counts messages and distinct destinations across delivery modes, deduplicating retries", () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      completed(
        { threadId: `thread-${i % 2}`, mode: ["auto", "queue", "steer", "restart"][i % 4] },
        { messageId: `message-${i}`, threadId: `thread-${i % 2}` },
      ),
    );
    expect(summarizeStudioToolCalls("thread-send", [...calls, calls[0]!])).toEqual({
      label: "Sent 5 messages to 2 threads",
      failedCount: 0,
    });
  });

  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "studio_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeStudioToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 thread");
    expect(
      summarizeStudioToolCalls("thread-send", [
        completed({ toolName: "studio_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 thread");
  });

  it("falls back to message counts when a destination is missing or a result is malformed", () => {
    expect(
      summarizeStudioToolCalls("thread-send", [
        completed({ threadId: "known" }),
        completed({ message: '{"threadId":"not-a-destination"}' }, "{truncated"),
        completed(undefined, "Message sent"),
      ]).label,
    ).toBe("Sent 3 messages");
  });

  it("counts batch-created threads, excludes rollbacks, and deduplicates returned thread IDs", () => {
    const threads = Array.from({ length: 4 }, (_, i) => ({
      threadId: `thread-${i}`,
      status: "running",
    }));
    expect(
      summarizeStudioToolCalls("thread-create", [
        completed(
          {},
          { threads: [...threads, { threadId: "rolled-back", status: "rolled_back" }] },
        ),
        completed({}, { threadId: "thread-0", status: "running" }),
      ]).label,
    ).toBe("Created 4 threads");
    expect(
      summarizeStudioToolCalls("thread-create", [
        completed({ threads: [{ title: "Requested, not confirmed" }] }),
      ]).label,
    ).toBe("Requested thread creation 1 time");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: StudioToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeStudioToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 thread",
      failedCount: 2,
    });
    expect(summarizeStudioToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 thread",
      failedCount: 1,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeStudioToolCalls("delegate", [
        completed({}, failedChild),
        completed({}, failedChild),
      ]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
    });
    expect(
      summarizeStudioToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeStudioToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 thread",
      failedCount: 0,
    });
  });

  it("describes control requests without claiming that a thread stopped or a task was deleted", () => {
    expect(
      summarizeStudioToolCalls("thread-interrupt", [
        completed(
          { threadId: "thread-1" },
          { threadId: "thread-1", status: "interrupt_requested" },
        ),
      ]).label,
    ).toBe("Requested interrupts for 1 thread");
    expect(
      summarizeStudioToolCalls("thread-stop-all", [
        completed({}, { projectId: "project-1", count: 3, threads: [] }),
      ]).label,
    ).toBe("Requested stops for 3 threads");
    expect(
      summarizeStudioToolCalls("thread-continue-all", [
        completed({}, { projectId: "project-1", count: 1, threads: [] }),
      ]).label,
    ).toBe("Continued 1 thread");
    expect(
      summarizeStudioToolCalls("task-cancel", [
        completed({ taskId: "task-1" }, { taskId: "task-1", status: "cancel_requested" }),
      ]).label,
    ).toBe("Requested cancellation of 1 task");
    expect(
      summarizeStudioToolCalls("schedule-delete", [
        completed(
          { scheduledTaskId: "schedule-1" },
          { scheduledTaskId: "schedule-1", deleted: false },
        ),
      ]).label,
    ).toBe("Requested deletion of 1 scheduled task");
  });
});
