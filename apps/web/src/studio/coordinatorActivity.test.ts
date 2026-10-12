import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorConversationView,
  runActivity,
  summarizeRunItems,
  withFoldedReplies,
  type ActivityItem,
  type ActivityMessage,
} from "./coordinatorActivity";

let ordinal = 0;
const item = (fields: Partial<ActivityItem> & Pick<ActivityItem, "type">): ActivityItem => {
  ordinal += 1;
  return {
    id: `item-${ordinal}`,
    runId: "run-1",
    ordinal,
    status: "completed",
    ...fields,
  };
};
const message = (
  id: string,
  role: ActivityMessage["role"],
  runId: string | null,
  notice = false,
): ActivityMessage => ({ id, role, runId, notice });

describe("summarizeRunItems", () => {
  it("counts each kind of step in past tense", () => {
    expect(
      summarizeRunItems([
        item({ type: "subagent" }),
        item({ type: "dynamic_tool", toolName: "mcp__studio__delegate_task" }),
        item({ type: "command_execution", input: "npm test" }),
        item({ type: "command_execution", input: "npm run build" }),
        item({ type: "dynamic_tool", toolName: "Bash" }),
        item({ type: "file_search", pattern: "TODO" }),
        item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "a.md" } }),
        item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "b.md" } }),
        item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "a.md" } }),
        item({ type: "dynamic_tool", toolName: "Grep" }),
        item({ type: "dynamic_tool", toolName: "Glob" }),
      ]),
    ).toBe("Started 2 workers, ran 3 commands, read 2 files and searched code 3 times");
  });

  it("uses singular wording for one step", () => {
    expect(summarizeRunItems([item({ type: "command_execution", input: "ls" })])).toBe(
      "Ran 1 command",
    );
    expect(
      summarizeRunItems([
        item({ type: "subagent" }),
        item({ type: "file_change", fileName: "a.ts" }),
        item({ type: "web_search" }),
        item({ type: "dynamic_tool", toolName: "mcp__studio__studio_project_memory_read" }),
        item({ type: "dynamic_tool", toolName: "mcp__other__lookup" }),
      ]),
    ).toBe(
      "Started 1 worker, changed 1 file, searched the web, used project memory and used 1 other tool",
    );
  });

  it("names the coordinator's thread checks and messages to workers", () => {
    expect(
      summarizeRunItems([
        item({ type: "dynamic_tool", toolName: "mcp__studio__studio_thread_list" }),
        item({ type: "dynamic_tool", toolName: "mcp__studio__studio_thread_read" }),
        item({ type: "dynamic_tool", toolName: "mcp__studio__studio_thread_send" }),
      ]),
    ).toBe("Checked threads 2 times and sent 1 message to a worker");
  });

  it("says Thought for thinking alone and nothing for no work", () => {
    expect(summarizeRunItems([item({ type: "reasoning", text: "Plan" })])).toBe("Thought");
    expect(summarizeRunItems([item({ type: "assistant_message" })])).toBeNull();
  });

  it("leaves out a worker's own items", () => {
    expect(
      summarizeRunItems([
        item({ type: "command_execution", input: "ls" }),
        item({ type: "command_execution", input: "pwd", parentItemId: "item-x" }),
      ]),
    ).toBe("Ran 1 command");
  });
});

describe("runActivity", () => {
  // As the client receives it: the Studio tool call with its compact result, then
  // the worker the host recorded for that call.
  const delegated = (taskId: string) => [
    item({
      type: "dynamic_tool",
      toolName: "mcp__studio-code__delegate_task",
      input: { title: "Smoke check", task: "Reply with the word OK." },
      output: { taskId },
    }),
    item({
      type: "subagent",
      subagentId: taskId,
      childThreadId: `thread:${taskId}`,
      prompt: "Reply with the word OK.",
    }),
  ];

  it("counts a worker started through a Studio tool once", () => {
    const activity = runActivity("run-1", [
      ...delegated("node:smoke"),
      item({ type: "dynamic_tool", toolName: "mcp__studio-code__task_status", input: {} }),
    ]);
    expect(activity?.summary).toBe("Started 1 worker and checked threads");
    expect(activity?.steps.map(({ label, detail }) => [label, detail])).toEqual([
      ["Started a worker", "Smoke check"],
      ["Checked the project's threads", undefined],
    ]);
  });

  it("keeps a worker the tool call did not start", () => {
    const activity = runActivity("run-1", [
      ...delegated("node:smoke").slice(0, 1),
      item({ type: "subagent", subagentId: "node:other", prompt: "Review the docs" }),
      item({ type: "subagent", prompt: "Native subagent" }),
    ]);
    expect(activity?.summary).toBe("Started 3 workers");
  });

  it("lists steps in order with a short detail and failures marked", () => {
    const long = "x".repeat(400);
    const activity = runActivity("run-1", [
      item({ type: "reasoning", text: "Look   at\nthe repo", ordinal: 1 }),
      item({
        type: "command_execution",
        input: "npm test\n--watch=false",
        ordinal: 2,
        exitCode: 1,
      }),
      item({ type: "file_change", fileName: "src/a.ts", ordinal: 3 }),
      item({ type: "command_execution", input: long, ordinal: 4 }),
      item({ type: "command_execution", input: "ls", runId: "run-2", ordinal: 5 }),
      item({ type: "assistant_message", ordinal: 6 }),
    ]);
    expect(activity?.summary).toBe("Ran 2 commands and changed 1 file");
    expect(activity?.steps.map(({ label, detail, failed }) => ({ label, detail, failed }))).toEqual(
      [
        { label: "Thought", detail: "Look at the repo", failed: false },
        { label: "Ran a command", detail: "npm test", failed: true },
        { label: "Edited a file", detail: "src/a.ts", failed: false },
        { label: "Ran a command", detail: `${"x".repeat(199)}…`, failed: false },
      ],
    );
  });

  it("marks a thought's detail as prose", () => {
    const activity = runActivity("run-1", [
      item({ type: "reasoning", text: "Two threads wait" }),
      item({ type: "command_execution", input: "ls" }),
    ]);
    expect(activity?.steps.map(({ prose }) => prose)).toEqual([true, undefined]);
  });

  it("details a tool call by what it worked on", () => {
    const activity = runActivity("run-1", [
      item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "CHANGELOG.md" } }),
      item({
        type: "dynamic_tool",
        toolName: "mcp__studio__delegate_task",
        input: { title: "Record the tutorials", prompt: "Record four episodes" },
      }),
      item({ type: "dynamic_tool", toolName: "Bash", input: { command: "git log -3\n--stat" } }),
      item({ type: "dynamic_tool", toolName: "mcp__studio__studio_thread_list", input: {} }),
      item({ type: "dynamic_tool", toolName: "mcp__linear__search", input: { limit: 3 } }),
    ]);
    expect(activity?.steps.map(({ detail }) => detail)).toEqual([
      "CHANGELOG.md",
      "Record the tutorials",
      "git log -3",
      undefined,
      "search",
    ]);
  });

  it("words finished steps in the past and running ones in the present", () => {
    const activity = runActivity("run-1", [
      item({ type: "dynamic_tool", toolName: "mcp__studio__delegate_task", ordinal: 1 }),
      item({ type: "dynamic_tool", toolName: "mcp__studio__studio_thread_list", ordinal: 2 }),
      item({ type: "dynamic_tool", toolName: "Read", ordinal: 3 }),
      item({ type: "command_execution", input: "pnpm fmt", ordinal: 4, status: "running" }),
      item({
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "CHANGELOG.md" },
        ordinal: 5,
        status: "running",
      }),
      item({ type: "dynamic_tool", toolName: "Grep", input: { pattern: "TODO" }, ordinal: 6 }),
    ]);
    expect(activity?.steps.map(({ label }) => label)).toEqual([
      "Started a worker",
      "Checked the project's threads",
      "Read files",
      "Running a command",
      "Reading a file",
      "Searched code",
    ]);
  });
});

describe("coordinatorConversationView", () => {
  const messages = [
    message("user-1", "user", "run-1"),
    message("note-1", "assistant", "run-1"),
    message("report", "assistant", "run-1", true),
    message("answer-1", "assistant", "run-1"),
    message("user-2", "user", "run-2"),
    message("note-2", "assistant", "run-2"),
    message("latest-2", "assistant", "run-2"),
    message("old", "assistant", null),
  ];
  const turnItems = [
    item({ type: "command_execution", input: "npm test", runId: "run-1" }),
    item({ type: "dynamic_tool", toolName: "Read", runId: "run-2" }),
  ];
  const finished = [
    { id: "run-1", status: "completed" },
    { id: "run-2", status: "completed" },
  ];

  it("changes nothing in normal", () => {
    const view = coordinatorConversationView({
      messages,
      turnItems,
      runs: finished,
      detail: "normal",
    });
    expect(view.hiddenMessageIds.size).toBe(0);
    expect(view.activityByMessageId.size).toBe(0);
    expect(view.liveActivity).toBeNull();
  });

  it("keeps each run's last reply, every user message and every notice in concise", () => {
    const view = coordinatorConversationView({
      messages,
      turnItems,
      runs: [finished[0]!, { id: "run-2", status: "running" }],
      detail: "concise",
    });
    expect([...view.hiddenMessageIds]).toEqual(["note-1", "note-2"]);
    expect(Object.fromEntries(view.foldedIntoMessageId)).toEqual({
      "answer-1": ["note-1"],
      "latest-2": ["note-2"],
    });
    // The running turn keeps its latest message.
    expect(view.hiddenMessageIds.has("latest-2")).toBe(false);
    expect(view.liveActivity).toBeNull();
  });

  it("attaches a finished run's steps to its last reply in verbose", () => {
    const view = coordinatorConversationView({
      messages,
      turnItems,
      runs: finished,
      detail: "verbose",
    });
    expect(view.hiddenMessageIds.size).toBe(0);
    expect(view.activityByMessageId.get("answer-1")?.summary).toBe("Ran 1 command");
    expect(view.activityByMessageId.get("latest-2")?.summary).toBe("Read 1 file");
    expect(view.liveActivity).toBeNull();
  });

  it("shows the running turn's steps as live activity in verbose", () => {
    const view = coordinatorConversationView({
      messages,
      turnItems,
      runs: [finished[0]!, { id: "run-2", status: "running" }],
      detail: "verbose",
    });
    expect(view.liveActivity?.runId).toBe("run-2");
    expect(view.activityByMessageId.has("latest-2")).toBe(false);
    expect(view.activityByMessageId.has("answer-1")).toBe(true);
  });
});

describe("withFoldedReplies", () => {
  const view = coordinatorConversationView({
    messages: [
      message("user-1", "user", "run-1"),
      message("note-1", "assistant", "run-1"),
      message("note-2", "assistant", "run-1"),
      message("answer-1", "assistant", "run-1"),
    ],
    turnItems: [],
    runs: [{ id: "run-1", status: "completed" }],
    detail: "concise",
  });
  const cards: Record<string, string[]> = {
    "note-1": ["skills"],
    "note-2": ["tutorials", "skills"],
    "answer-1": ["review"],
  };
  const of = (id: string) => cards[id] ?? [];

  it("moves the thread cards a hidden reply announced onto the reply that shows", () => {
    expect(withFoldedReplies(view, "answer-1", of("answer-1"), of)).toEqual([
      "skills",
      "tutorials",
      "review",
    ]);
  });

  it("leaves a reply that stands in for nothing as it is", () => {
    expect(withFoldedReplies(view, "user-1", ["a"], of)).toEqual(["a"]);
    const normal = coordinatorConversationView({
      messages: [],
      turnItems: [],
      runs: [],
      detail: "normal",
    });
    expect(withFoldedReplies(normal, "answer-1", of("answer-1"), of)).toEqual(["review"]);
  });
});

describe("coordinatorConversationView cost", () => {
  it("reads turn items a bounded number of times however many runs there are", () => {
    const runs = Array.from({ length: 300 }, (_, index) => ({
      id: `run-${index}`,
      status: "completed",
    }));
    const messages = runs.map((run) => message(`answer-${run.id}`, "assistant", run.id));
    let reads = 0;
    const turnItems = runs.flatMap((run) =>
      Array.from({ length: 40 }, (_, index) => {
        const value = item({ type: "command_execution", input: "ls", runId: run.id });
        return new Proxy(value, {
          get(target, key, receiver) {
            if (key === "runId" && index === 0) reads += 1;
            return Reflect.get(target, key, receiver);
          },
        });
      }),
    );
    const view = coordinatorConversationView({ messages, turnItems, runs, detail: "verbose" });
    expect(view.activityByMessageId.size).toBe(300);
    // Grouping reads each item's run a few times; filtering per run would read it
    // 300 times each, 90,000 in all.
    expect(reads).toBeLessThan(300 * 10);
  });
});
