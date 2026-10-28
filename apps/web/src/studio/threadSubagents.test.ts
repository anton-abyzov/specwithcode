import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { logicalProjectThreads, requestExecutionLabel } from "./projectDomain";
import { buildThreadPaneGroups } from "./shellModel";
import {
  isNestedSubagentThread,
  groupSubagentPopupEntries,
  type SubagentEntry,
  listedRunningSubagents,
  runningSubagentCount,
  workingSubagentEntryCount,
  subagentEntryLabel,
  subagentHostThread,
  subagentStatusTone,
  threadSubagentEntries,
  threadWorkflowEntries,
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
    // A child still at work keeps the record; one with no live turn and no run was cut off.
    expect(status("live")).toBe("running");
    expect(status("runless")).toBe("interrupted");
    expect(runningSubagentCount([...all, stopped, limited, live, runless], worker)).toBe(2);
    expect(
      runningSubagentCount([...all, stopped, limited, live, runless], worker, undefined, [
        record("stopped"),
        record("limited"),
        record("live"),
        record("runless"),
      ] as never),
    ).toBe(2);
  });

  describe("one verdict for the list, the group, the header chip and the peek", () => {
    const stale = { status: "running" } as EnvironmentThreadShell["runtime"];
    const record = (
      childThreadId: string,
      status: string,
      origin: "provider_native" | "app_owned" = "provider_native",
    ) => ({
      id: `node:${childThreadId}`,
      childThreadId,
      title: childThreadId,
      prompt: null,
      status,
      origin,
      providerInstanceId: "claudeAgent",
      model: null,
      result: status === "completed" ? "SHIP" : null,
      startedAt: null,
      completedAt: null,
    });
    // Each screenshot parent, with the records T-02 settles and child roots still left running.
    const rows = {
      seo: {
        children: [
          ["seo-review", "completed"],
          ["seo-tenant", "failed"],
          ["seo-calendar", "failed"],
          ["seo-gsc", "failed"],
        ],
        labels: ["Done", "Failed", "Failed", "Failed"],
        word: null,
      },
      cms: { children: [["cms-audit", "completed"]], labels: ["Done"], word: null },
      console: { children: [["light-theme", "completed"]], labels: ["Done"], word: null },
      club: {
        children: [
          ["pr-491", "completed"],
          ["pr-492", "completed"],
        ],
        labels: ["Done", "Done"],
        word: null,
      },
      premierliga: {
        children: [["winter-audit", "interrupted"]],
        labels: ["Interrupted, rerun pending"],
        word: null,
      },
      stopped: { children: [["stopped-child", "cancelled"]], labels: ["Stopped"], word: null },
      remote: {
        children: [["remote-child", "running"]],
        labels: ["Unknown (machine unreachable)"],
        word: null,
      },
      live: {
        children: [["delegated", "running"]],
        labels: ["Working"],
        word: "Working · 1 subagent",
      },
    } as const;
    const unreachable = new Set(["m3"]);

    for (const [name, row] of Object.entries(rows)) {
      it(`${name}: says ${row.labels.join(", ")} in the popover, the peek and the list`, () => {
        const parent = shell(name, COORDINATOR);
        const children = row.children.map(([id]) =>
          shell(id, name, {
            runtime: stale,
            ...(name === "remote" ? { executionMachineId: "m3" as never } : {}),
          }),
        );
        const projected = row.children.map(([id, status]) =>
          record(id, status, name === "live" ? "app_owned" : "provider_native"),
        ) as never;
        const shells = [shell(COORDINATOR, null), parent, ...children];
        const entries = threadSubagentEntries({ parent, shells, projected, unreachable });
        // Popover rows and the peek header use the same label.
        expect(entries.map(subagentEntryLabel)).toEqual(row.labels);
        // The list row and its group count from the same verdict as the popover.
        const count = runningSubagentCount(shells, parent, undefined, projected, unreachable);
        expect(count).toBe(workingSubagentEntryCount(entries));
        expect(withRunningSubagents(null, count)).toBe(row.word);
        const groups = buildThreadPaneGroups(
          [parent],
          "activity",
          "",
          new Map([[`env:${name}`, count]]),
        );
        expect(groups.find((group) => group.threads.length > 0)?.group).toBe(
          count > 0 ? "Working" : "Idle",
        );
      });
    }

    it("counts a CMS parent the same before it is opened, while open and after switching away", () => {
      const native = { source: { creationSource: "provider" }, latestRun: null } as never;
      const settle = (parentRuntime: EnvironmentThreadShell["runtime"], status: string) => {
        const cms = shell("cms", COORDINATOR, {
          runtime: parentRuntime,
          pendingBackgroundTasks: [],
        });
        const other = shell("other", COORDINATOR, { pendingBackgroundTasks: [] });
        const child = shell("cms-audit", "cms", { runtime: stale, ...(native as object) });
        const shells = [shell(COORDINATOR, null), cms, other, child];
        const projected = [record("cms-audit", status)] as never;
        const counts = (selected: EnvironmentThreadShell | null) =>
          Object.fromEntries(
            listedRunningSubagents({
              threads: [cms, other],
              shells,
              coordinatorIds: new Set(),
              selected,
              selectedEntries:
                selected === null
                  ? []
                  : threadSubagentEntries({
                      parent: selected,
                      shells,
                      projected: selected === cms ? projected : [],
                    }),
            }),
          );
        return [counts(null), counts(cms), counts(other)];
      };
      // The parent recorded the child done and its turn ended; the child's root still runs.
      const [before, open, after] = settle(null, "completed");
      expect(before).toEqual({});
      expect(open).toEqual(before);
      expect(after).toEqual(before);
      // Negative control: a parent still at work with a working child counts it everywhere.
      const live = settle({ status: "running" } as EnvironmentThreadShell["runtime"], "running");
      expect(live).toEqual([{ "env:cms": 1 }, { "env:cms": 1 }, { "env:cms": 1 }]);
    });

    it("counts a working parent's finished native child nowhere, open or not", () => {
      // The receipt's write closes the child's runless root, so its streamed
      // shell has no runtime (NativeChildReceiptIngestion.test.ts on the server).
      const parent = shell("cms", COORDINATOR, {
        runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
        pendingBackgroundTasks: [],
      });
      const child = shell("cms-audit", "cms", {
        runtime: null,
        latestRun: null,
        source: { creationSource: "provider" },
      } as never);
      const shells = [shell(COORDINATOR, null), parent, child];
      const entries = threadSubagentEntries({
        parent,
        shells,
        projected: [record("cms-audit", "completed")] as never,
      });
      const count = (selected: EnvironmentThreadShell | null) =>
        listedRunningSubagents({
          threads: [parent],
          shells,
          coordinatorIds: new Set(),
          selected,
          selectedEntries: selected === null ? [] : entries,
        }).get("env:cms") ?? 0;
      expect([count(null), count(parent), count(null)]).toEqual([0, 0, 0]);
      expect(entries.map((entry) => entry.status)).toEqual(["completed"]);
    });

    it("keeps the record running while the child really works, and reads unknown, never dead, when its host is away", () => {
      const parent = shell("p", COORDINATOR);
      const child = shell("c", "p", { runtime: stale });
      const shells = [parent, child];
      const projected = [record("c", "running")] as never;
      expect(threadSubagentEntries({ parent, shells, projected })[0]!.status).toBe("running");
      expect(runningSubagentCount(shells, parent, undefined, projected)).toBe(1);
      const away = new Set(["env"]);
      const [entry] = threadSubagentEntries({ parent, shells, projected, unreachable: away });
      expect(entry!.status).toBe("unknown");
      expect(subagentStatusTone(entry!.status)).toBe("idle");
      expect(runningSubagentCount(shells, parent, undefined, projected, away)).toBe(0);
    });
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

it("does not count queued, dependency waiting, completed or unknown children as working", () => {
  const entries = [
    "pending",
    "waiting",
    "completed",
    "unknown",
    "failed",
    "cancelled",
    "interrupted",
    "running",
  ].map((status) => ({ status, key: status }));
  expect(workingSubagentEntryCount(entries as never)).toBe(1);
});

it("uses a parent's terminal receipt in a child shell while the parent keeps working", () => {
  const parent = shell("parent", COORDINATOR, { runtime: { status: "running" } as never });
  const child = shell("finished", "parent", {
    runtime: { status: "running" } as never,
    source: {
      creationSource: "provider",
      nativeSubagentStatus: "completed",
      pendingRuntimeRequest: null,
    } as never,
  });
  const entries = threadSubagentEntries({ parent, shells: [parent, child], projected: [] });
  expect(entries[0]?.status).toBe("completed");
  expect(runningSubagentCount([parent, child], parent)).toBe(0);
});

it("keeps a native child's newer execution visible after an old terminal receipt", () => {
  const parent = shell("parent", COORDINATOR, { runtime: { status: "running" } as never });
  const child = shell("resumed", "parent", {
    runtime: { status: "running", activityStartedAt: "2026-10-27T10:00:00Z" } as never,
    source: {
      creationSource: "provider",
      nativeSubagentStatus: "completed",
      nativeSubagentCompletedAt: "2026-10-27T09:00:00Z",
      pendingRuntimeRequest: null,
    } as never,
  });
  expect(runningSubagentCount([parent, child], parent)).toBe(1);
});

it("excludes other-thread projection records and duplicate child identities", () => {
  const worker = shell("worker", null);
  const own = shell("own", "worker");
  const other = shell("other", "different");
  const record = (id: string, childThreadId: string | null, threadId = "worker") => ({
    id,
    childThreadId,
    threadId,
    title: id,
    prompt: "",
    status: "completed",
    origin: "provider_native",
    providerInstanceId: "codex",
    model: null,
    result: null,
    startedAt: null,
    completedAt: null,
  });
  const entries = threadSubagentEntries({
    parent: worker,
    shells: [worker, own, other],
    projected: [
      record("own-record", "own"),
      record("foreign", "other", "different"),
      record("conflicting", "other"),
      record("unloaded", "new"),
      record("duplicate", "new"),
      record("runless", null),
      record("runless", null),
    ] as never,
  });
  expect(entries.map((e) => e.key)).toEqual(["own", "unloaded", "runless"]);
});

it("keeps completed ancestors above active descendants and collapses only older whole branches", () => {
  const make = (key: string, status: string, depth = 0, extra = {}) =>
    ({
      key,
      title: key,
      childThreadId: key,
      status,
      depth,
      completedAt: null,
      startedAt: null,
      ...extra,
    }) as SubagentEntry;
  const now = Date.parse("2026-10-27T15:00:00Z");
  const input = [
    make("old", "completed"),
    make("done-parent", "completed"),
    make("live-child", "running", 1),
    make("old-sibling", "completed", 1),
    make("unknown", "unknown"),
    make("recent", "completed", 0, { completedAt: "2026-10-27T14:50:00Z" }),
    make("question", "waiting", 0, { awaitingPerson: "answer" }),
  ];
  const grouped = groupSubagentPopupEntries(input, now);
  expect(grouped.current.map((e) => e.key)).toEqual([
    "question",
    "done-parent",
    "live-child",
    "old-sibling",
    "unknown",
    "recent",
  ]);
  expect(grouped.history.map((e) => e.key)).toEqual(["old"]);
  expect(new Set([...grouped.current, ...grouped.history].map((e) => e.key)).size).toBe(
    input.length,
  );
  const finished = input.map((e) =>
    e.key === "live-child" ? { ...e, status: "completed", completedAt: "2026-10-27T15:00:00Z" } : e,
  ) as never;
  expect(
    groupSubagentPopupEntries(finished, now + 31 * 60_000).history.map((e) => e.key),
  ).toContain("done-parent");
});

it("does not import inherited workflow records into this thread's popup", () => {
  const item = (threadId: string, id: string) => ({
    threadId,
    id,
    type: "dynamic_tool",
    toolName: "mcp__workflow",
    input: { name: id },
    status: "completed",
    updatedAt: null,
    startedAt: null,
  });
  const entries = threadWorkflowEntries({
    parentThreadId: "current",
    turnItems: [item("other", "foreign"), item("current", "own")] as never,
    pendingBackgroundTasks: [],
  });
  expect(entries.map((e) => e.title)).toEqual(["own"]);
});
