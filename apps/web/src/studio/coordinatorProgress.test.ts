import { describe, expect, it } from "vite-plus/test";

import { coordinatorProgress, formatProgressElapsed, latestWorkStep } from "./coordinatorProgress";

const requestedAt = "2026-10-11T16:11:44.994Z";
const run = (status: string, ordinal = 1, id = `run-${ordinal}`) => ({
  id,
  ordinal,
  status,
  requestedAt,
});
const item = (ordinal: number, type: string, toolName?: string, runId = "run-1") => ({
  runId,
  ordinal,
  type,
  status: "completed",
  ...(toolName === undefined ? {} : { toolName }),
});

describe("coordinatorProgress", () => {
  it("names an automatic continuation after a limit instead of a new message", () => {
    const continued = (status: string, userMessageId: string) =>
      coordinatorProgress({ runs: [{ ...run(status), userMessageId }] })?.label;
    expect(continued("queued", "limit-fallback:coordinator:run-0")).toBe(
      "Usage limit reached, continuing on the next model",
    );
    expect(continued("running", "limit-fallback:coordinator:run-0")).toBe(
      "Usage limit reached, continuing on the next model",
    );
    expect(continued("starting", "provider-fallback:coordinator:run-0")).toBe(
      "Provider could not start, continuing on the next model",
    );
    expect(continued("starting", "limit-return:coordinator:run-0")).toBe(
      "Usage limit reset, continuing",
    );
    expect(continued("starting", "message:typed")).toBe("Starting the coordinator");
    // Once the provider works, its own step says more.
    expect(
      coordinatorProgress({
        runs: [{ ...run("running"), userMessageId: "limit-fallback:coordinator:run-0" }],
        turnItems: [item(2, "reasoning")],
      })?.label,
    ).toBe("Thinking");
  });

  it("says nothing while the coordinator is idle", () => {
    expect(coordinatorProgress({ runs: [] })).toBeNull();
    expect(coordinatorProgress({ runs: [run("completed")] })).toBeNull();
    expect(coordinatorProgress({})).toBeNull();
  });

  it("answers a send at once, before the provider has written anything", () => {
    expect(coordinatorProgress({ runs: [run("queued")] })).toEqual({
      label: "Starting the coordinator",
      since: requestedAt,
      waiting: false,
    });
    expect(coordinatorProgress({ runs: [run("starting")] })?.label).toBe(
      "Starting the coordinator",
    );
    expect(
      coordinatorProgress({ runs: [run("running")], turnItems: [item(1, "user_message")] })?.label,
    ).toBe("Reading the new message");
  });

  it("says when the turn is blocked on an answer, and hides a count it cannot know", () => {
    expect(
      coordinatorProgress({
        runs: [run("running")],
        turnItems: [item(2, "reasoning"), item(3, "approval_request")],
      }),
    ).toEqual({
      label: "Waiting for an answer",
      since: requestedAt,
      waiting: true,
    });
    expect(
      coordinatorProgress({
        runs: [{ id: "run-1", ordinal: 1, status: "running", requestedAt: null }],
      })?.since,
    ).toBeNull();
  });

  it("names what the latest step of the running turn is doing", () => {
    const at = (...items: ReturnType<typeof item>[]) =>
      coordinatorProgress({ runs: [run("running")], turnItems: items })?.label;
    expect(at(item(1, "user_message"), item(2, "reasoning"))).toBe("Thinking");
    expect(at(item(2, "dynamic_tool", "ToolSearch"))).toBe("Loading its tools");
    expect(at(item(3, "dynamic_tool", "mcp__studio-code__studio_thread_list"))).toBe(
      "Checking the project's threads",
    );
    expect(at(item(4, "dynamic_tool", "mcp__studio-code__delegate_task"))).toBe(
      "Starting a worker",
    );
    expect(at(item(4, "dynamic_tool", "mcp__studio-code__task_status"))).toBe(
      "Checking the project's threads",
    );
    expect(at(item(5, "dynamic_tool", "mcp__studio-code__studio_thread_send"))).toBe(
      "Passing your message to a worker",
    );
    expect(at(item(6, "dynamic_tool", "mcp__studio-code__studio_project_memory_write"))).toBe(
      "Saving to project memory",
    );
    expect(at(item(7, "dynamic_tool", "Bash"))).toBe("Running a command");
    expect(at(item(7, "dynamic_tool", "SomethingNew"))).toBe("Working");
    expect(at(item(8, "assistant_message"))).toBe("Replying");
    // The latest step wins, whatever order the items arrived in.
    expect(at(item(9, "assistant_message"), item(3, "reasoning"))).toBe("Replying");
  });

  it("follows the turn that is executing, not one queued behind it or an earlier turn", () => {
    const progress = coordinatorProgress({
      runs: [run("completed", 1), run("running", 2), run("queued", 3)],
      turnItems: [
        item(1, "assistant_message", undefined, "run-1"),
        item(2, "reasoning", undefined, "run-2"),
      ],
    });
    expect(progress?.label).toBe("Thinking");
    expect(coordinatorProgress({ runs: [run("queued", 3), run("queued", 2, "run-2")] })).toEqual({
      label: "Starting the coordinator",
      since: requestedAt,
      waiting: false,
    });
  });

  it("names the previous turn's checkpoint as what a queued message waits on", () => {
    const sentAt = "2026-10-11T16:12:30.000Z";
    // The previous turn has replied and is saving its checkpoint; the new message waits on it.
    expect(
      coordinatorProgress({
        runs: [
          run("completed", 1),
          run("waiting", 2),
          { id: "run-3", ordinal: 3, status: "queued", requestedAt: sentAt },
        ],
        turnItems: [item(5, "assistant_message", undefined, "run-2")],
      }),
    ).toEqual({ label: "Finishing the previous turn", since: sentAt, waiting: false });
    // Nothing queued behind it: the turn is only finishing, and nobody is asked anything.
    expect(
      coordinatorProgress({ runs: [run("waiting")], turnItems: [item(2, "reasoning")] }),
    ).toEqual({ label: "Finishing the turn", since: requestedAt, waiting: false });
    // A queued message with nothing ahead of it is about to start.
    expect(coordinatorProgress({ runs: [run("completed", 1), run("queued", 2)] })?.label).toBe(
      "Starting the coordinator",
    );
  });
});

describe("latestWorkStep", () => {
  it("names a subagent's latest step and skips items that say nothing", () => {
    const step = (ordinal: number, type: string, toolName?: string) =>
      item(ordinal, type, toolName, null as unknown as string);
    expect(latestWorkStep([])).toBeNull();
    expect(latestWorkStep([step(1, "user_message")])).toBeNull();
    expect(latestWorkStep([step(1, "command_execution"), step(2, "system_notice")])).toBe(
      "Running a command",
    );
    expect(latestWorkStep([step(3, "dynamic_tool", "Grep"), step(2, "file_change")])).toBe(
      "Reading files",
    );
    expect(latestWorkStep([step(4, "dynamic_tool", "WebFetch")])).toBe("Searching the web");
    expect(latestWorkStep([step(5, "dynamic_tool", "Edit")])).toBe("Editing files");
  });
});

describe("formatProgressElapsed", () => {
  it("counts seconds, then minutes", () => {
    const start = Date.parse(requestedAt);
    expect(formatProgressElapsed(requestedAt, start + 8_400)).toBe("8s");
    expect(formatProgressElapsed(requestedAt, start + 65_000)).toBe("1m 05s");
    expect(formatProgressElapsed("not a date", start)).toBe("0s");
  });
});
