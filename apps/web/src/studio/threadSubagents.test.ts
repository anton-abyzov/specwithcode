import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { logicalProjectThreads, requestExecutionLabel } from "./projectDomain";
import {
  isNestedSubagentThread,
  runningSubagentCount,
  subagentEntryLabel,
  subagentHostThread,
  subagentStatusTone,
  threadSubagentEntries,
  withRunningSubagents,
} from "./threadSubagents";

const COORDINATOR = "project-coordinator:p1";

function shell(
  id: string,
  parent: string | null,
  extra: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: "env",
    id,
    projectId: "p1",
    title: id,
    createdBy: "agent",
    deletedAt: null,
    archivedAt: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: COORDINATOR,
    },
    forkedFrom: null,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtime: null,
    latestRun: null,
    ...extra,
  } as unknown as EnvironmentThreadShell;
}

const worker = shell("worker", COORDINATOR);
const native = shell("native", "worker");
const nested = shell("nested", "native", {
  runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
});
const all = [shell(COORDINATOR, null), worker, native, nested];
const lookup = (id: string) => all.find((thread) => thread.id === id);

describe("thread subagents", () => {
  it("keeps a coordinator's workers as threads and hides their subagents", () => {
    expect(isNestedSubagentThread(worker)).toBe(false);
    expect(isNestedSubagentThread(native)).toBe(true);
    expect(
      isNestedSubagentThread(shell("w2", "custom-coordinator"), new Set(["custom-coordinator"])),
    ).toBe(false);
    const listed = logicalProjectThreads(
      all,
      [
        {
          environmentId: "env" as never,
          projectId: "p1" as never,
          coordinatorThreadId: COORDINATOR as never,
        },
      ],
      true,
    ).map((thread) => thread.id);
    expect(listed).toEqual(["worker"]);
  });

  it("finds the thread a nested subagent is shown in", () => {
    expect(subagentHostThread(nested, lookup)?.id).toBe("worker");
    expect(subagentHostThread(worker, lookup)).toBeNull();
  });

  it("lists every subagent once, records first, with nesting depth", () => {
    const entries = threadSubagentEntries({
      parent: worker,
      shells: all,
      projected: [
        {
          id: "node:1",
          childThreadId: "native",
          title: "Research REA",
          prompt: "Research task",
          status: "completed",
          origin: "provider_native",
          providerInstanceId: "claudeAgent",
          model: "claude-sonnet-5-5",
          result: "## Findings\nAll good",
          startedAt: null,
          completedAt: null,
        },
        {
          id: "node:2",
          childThreadId: null,
          title: null,
          prompt: "Pending review\nmore",
          status: "pending",
          origin: "app_owned",
          providerInstanceId: "codex",
          model: null,
          result: null,
          startedAt: null,
          completedAt: null,
        },
      ] as never,
    });
    expect(entries.map((entry) => [entry.title, entry.depth, entry.status])).toEqual([
      ["Research REA", 0, "completed"],
      ["nested", 1, "running"],
      ["Pending review", 0, "pending"],
    ]);
    expect(entries[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("rolls working subagents into the parent's status", () => {
    expect(runningSubagentCount(all, worker)).toBe(1);
    expect(withRunningSubagents(null, 2)).toBe("Working · 2 subagents");
    expect(withRunningSubagents("Blocked", 1)).toBe("Blocked · 1 subagent");
    expect(withRunningSubagents("Blocked", 0)).toBe("Blocked");
  });

  it("shows a delegated task held on an approval as waiting on you, not working", () => {
    const running = { status: "running" } as EnvironmentThreadShell["runtime"];
    const held = shell("held", "native", { runtime: running, hasPendingApprovals: true });
    const asking = shell("asking", "native", { runtime: running, hasPendingUserInput: true });
    const shells = [...all, held, asking];
    const entries = threadSubagentEntries({
      parent: worker,
      shells,
      // The parent's own record still says the task runs.
      projected: [
        {
          id: "node:held",
          childThreadId: "held",
          title: "Install deps",
          prompt: null,
          status: "running",
          origin: "app_owned",
          providerInstanceId: "codex",
          model: "gpt-5.5",
          result: null,
          startedAt: null,
          completedAt: null,
        },
      ] as never,
    });
    const row = (id: string) => entries.find((entry) => entry.childThreadId === id)!;
    expect(row("held")).toMatchObject({ status: "waiting", awaitingPerson: "approval" });
    expect(subagentEntryLabel(row("held"))).toBe("Approval requested");
    expect(subagentStatusTone(row("held").status)).toBe("waiting");
    expect(subagentEntryLabel(row("asking"))).toBe("Answer needed");
    // The task still at work counts; the two waiting on the person do not.
    expect(subagentEntryLabel(row("nested"))).toBe("Working");
    expect(runningSubagentCount(shells, worker)).toBe(1);
  });

  it("shows a child's ended run over the parent's stale running record", () => {
    const run = (status: string) =>
      ({ runId: "run", status, completedAt: "2026-10-15T10:05:00.000Z" }) as never;
    const record = (childThreadId: string) => ({
      id: `node:${childThreadId}`,
      childThreadId,
      title: childThreadId,
      prompt: null,
      status: "running",
      origin: "app_owned",
      providerInstanceId: "codex",
      model: null,
      result: null,
      startedAt: null,
      completedAt: null,
    });
    const stopped = shell("stopped", "native", { latestRun: run("cancelled") });
    const limited = shell("limited", "native", { latestRun: run("interrupted") });
    const live = shell("live", "native", {
      latestRun: run("completed"),
      runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
    });
    const runless = shell("runless", "native");
    const entries = threadSubagentEntries({
      parent: worker,
      shells: [...all, stopped, limited, live, runless],
      projected: [record("stopped"), record("limited"), record("live"), record("runless")] as never,
    });
    const status = (id: string) => entries.find((entry) => entry.childThreadId === id)!.status;
    expect(status("stopped")).toBe("cancelled");
    expect(status("limited")).toBe("interrupted");
    // A child still at work, and a native child with no run of its own, keep the record.
    expect(status("live")).toBe("running");
    expect(status("runless")).toBe("running");
    expect(runningSubagentCount([...all, stopped, limited, live, runless], worker)).toBe(2);
  });

  it("names the thread's model for a task that ran outside any run", () => {
    const model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    expect(requestExecutionLabel({ runId: null }, [], "Mac", undefined, model)).toBe(
      "Mac · Claude Code · Opus 5.5",
    );
    expect(requestExecutionLabel({ runId: "missing" }, [], "Mac", undefined, model)).toBe(
      "Mac · Model not recorded",
    );
  });
});

import { compactDuration } from "../components/chat/MessagesTimeline.logic";

describe("compact turn duration", () => {
  it("drops the seconds once a turn runs a minute", () => {
    expect(compactDuration(45_000)).toBe("45s");
    expect(compactDuration(31 * 60_000 + 18_000)).toBe("31m");
    expect(compactDuration(65 * 60_000)).toBe("1h 5m");
    expect(compactDuration(120 * 60_000)).toBe("2h");
    expect(compactDuration(null)).toBeNull();
  });
});
