import { describe, expect, it } from "vite-plus/test";

import {
  activeWorkPhrase,
  classifyRunHealth,
  deriveActiveRunWork,
  RUN_STALL_IDLE_MS,
  RUN_STALL_WAITING_IDLE_MS,
} from "./orchestrationV2PendingBackgroundWork.ts";

const item = (overrides: Record<string, unknown>) =>
  ({
    id: "item",
    type: "command_execution",
    status: "running",
    title: null,
    runId: "run-1",
    input: "pnpm test",
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }) as const;

describe("deriveActiveRunWork", () => {
  it("names the newest unfinished command of the active run", () => {
    const work = deriveActiveRunWork({
      activeRunId: "run-1",
      turnItems: [
        item({ id: "a", input: "pnpm lint", startedAt: 500 }),
        item({ id: "b", input: "pnpm test\n--watch=false", startedAt: 900 }),
        item({ id: "c", status: "completed", input: "ls", startedAt: 950 }),
        item({ id: "d", runId: "run-0", input: "old", startedAt: 990 }),
      ],
      toMillis: (time: number) => time,
    });
    expect(work).toEqual({ label: "pnpm test", kind: "command", startedAt: 900 });
  });

  it("says what kind of step is in flight", () => {
    const kindOf = (overrides: Record<string, unknown>) =>
      deriveActiveRunWork({
        activeRunId: "run-1",
        turnItems: [item(overrides)],
        toMillis: (time: number) => time,
      })?.kind;
    expect(kindOf({})).toBe("command");
    // A command's title is still a command, whatever the title says.
    expect(kindOf({ title: "Ran command · cd /Users/anton" })).toBe("command");
    expect(kindOf({ type: "subagent", prompt: "Review the diff" })).toBe("subagent");
    expect(kindOf({ type: "dynamic_tool", toolName: "mcp__docs__search" })).toBe("tool");
    expect(
      kindOf({
        type: "dynamic_tool",
        toolName: "mcp__studio-code__studio_thread_wait",
        input: { threadId: "worker" },
      }),
    ).toBe("thread");
    expect(kindOf({ type: "dynamic_tool", toolName: "delegate_task" })).toBe("task");
  });

  it("is null between steps or without an active run", () => {
    expect(
      deriveActiveRunWork({
        activeRunId: "run-1",
        turnItems: [item({ status: "completed" })],
        toMillis: (time: number) => time,
      }),
    ).toBeNull();
    expect(
      deriveActiveRunWork({ activeRunId: null, turnItems: [item({})], toMillis: (t: number) => t }),
    ).toBeNull();
  });
});

describe("activeWorkPhrase", () => {
  it("says the step in words and never repeats its label", () => {
    expect(activeWorkPhrase("cd /Users/anton/app && pnpm test", "command")).toBe(
      "Running a command",
    );
    expect(activeWorkPhrase("mcp__docs__search", "tool")).toBe("Using a tool");
    expect(activeWorkPhrase("Review the diff", "subagent")).toBe("Waiting on a subagent");
    expect(activeWorkPhrase("another thread", "thread")).toBe("Waiting on another thread");
    expect(activeWorkPhrase("a delegated task", "task")).toBe("Waiting on a delegated task");
  });

  it("reads the kind from a fixed label when an older server sends none", () => {
    expect(activeWorkPhrase("another thread")).toBe("Waiting on another thread");
    expect(activeWorkPhrase("a delegated task")).toBe("Waiting on a delegated task");
    expect(activeWorkPhrase("a subagent")).toBe("Waiting on a subagent");
    expect(activeWorkPhrase("a tool")).toBe("Using a tool");
    // A command and a tool's title look alike without the kind.
    expect(activeWorkPhrase("W=/Users/anton/work; cd $W")).toBe("Running a step");
    expect(activeWorkPhrase(null)).toBe("Running a step");
  });
});

describe("classifyRunHealth", () => {
  const now = 10 * 60 * 60_000;

  it("is null when nothing runs", () => {
    expect(
      classifyRunHealth({ running: false, lastActivityMs: 0, activeWork: null, nowMs: now }),
    ).toBeNull();
  });

  it("calls a quiet turn with nothing in flight stalled", () => {
    expect(
      classifyRunHealth({
        running: true,
        lastActivityMs: now - RUN_STALL_IDLE_MS,
        activeWork: null,
        nowMs: now,
      }),
    ).toEqual({ state: "stalled", idleMs: RUN_STALL_IDLE_MS, label: null });
  });

  it("lets a long command stay quiet without counting as stalled", () => {
    expect(
      classifyRunHealth({
        running: true,
        lastActivityMs: now - 40 * 60_000,
        activeWork: { label: "pnpm test", startedAtMs: now - 12 * 60_000 },
        nowMs: now,
      }),
    ).toMatchObject({ state: "waiting", label: "pnpm test", waitingMs: 12 * 60_000 });
    expect(
      classifyRunHealth({
        running: true,
        lastActivityMs: now - RUN_STALL_WAITING_IDLE_MS,
        activeWork: { label: "pnpm test", startedAtMs: 0 },
        nowMs: now,
      }),
    ).toMatchObject({ state: "stalled", label: "pnpm test" });
  });
});

describe("waits on other threads", () => {
  it("names a studio_thread_wait as a wait on that thread", () => {
    const work = deriveActiveRunWork({
      activeRunId: "run-1",
      turnItems: [
        item({
          type: "dynamic_tool",
          toolName: "mcp__studio-code__studio_thread_wait",
          input: { threadId: "release-worker" },
          startedAt: 900,
        }),
      ],
      toMillis: (time: number) => time,
    });
    expect(work).toEqual({
      label: "another thread",
      kind: "thread",
      startedAt: 900,
      waitThreadId: "release-worker",
    });
  });

  it("never calls a wait on another thread stalled", () => {
    const health = classifyRunHealth({
      running: true,
      lastActivityMs: 0,
      activeWork: { label: "Release worker", startedAtMs: 0, waitThreadId: "release-worker" },
      nowMs: RUN_STALL_WAITING_IDLE_MS * 2,
    });
    expect(health).toMatchObject({ state: "waiting", waitThreadId: "release-worker" });
  });

  it("waits as long as a command would when the server cannot say what is in flight", () => {
    const quiet = { running: true, lastActivityMs: 0, activeWork: null, activeWorkUnknown: true };
    expect(classifyRunHealth({ ...quiet, nowMs: RUN_STALL_IDLE_MS * 3 })?.state).toBe("working");
    expect(classifyRunHealth({ ...quiet, nowMs: RUN_STALL_WAITING_IDLE_MS })?.state).toBe(
      "stalled",
    );
  });
});

describe("turns waiting on the person", () => {
  const hours = (count: number) => count * 60 * 60_000;

  it("reads a turn blocked on an approval for 15 hours as needing you, not stalled", () => {
    const health = classifyRunHealth({
      running: true,
      lastActivityMs: 0,
      activeWork: { label: "pnpm install", startedAtMs: 0 },
      awaitingPerson: { kind: "approval", sinceMs: hours(1) },
      nowMs: hours(16),
    });
    expect(health).toEqual({
      state: "waiting",
      idleMs: hours(16),
      label: "your approval",
      waitingMs: hours(15),
      awaitingPerson: "approval",
    });
  });

  it("names an open question and a sign-in the same way, with nothing in flight", () => {
    const quiet = { running: true, lastActivityMs: 0, activeWork: null, nowMs: hours(3) };
    expect(
      classifyRunHealth({ ...quiet, awaitingPerson: { kind: "answer", sinceMs: 0 } }),
    ).toMatchObject({ state: "waiting", label: "your answer", awaitingPerson: "answer" });
    expect(
      classifyRunHealth({ ...quiet, awaitingPerson: { kind: "sign-in", sinceMs: Number.NaN } }),
    ).toMatchObject({ state: "waiting", label: "your sign-in", waitingMs: hours(3) });
  });

  it("still stalls the same quiet turn once nothing is asked of the person", () => {
    expect(
      classifyRunHealth({
        running: true,
        lastActivityMs: 0,
        activeWork: null,
        awaitingPerson: null,
        nowMs: hours(3),
      })?.state,
    ).toBe("stalled");
  });
});
