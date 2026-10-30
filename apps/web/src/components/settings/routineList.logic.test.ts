import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ROUTINE_FILTERS,
  filterRoutines,
  groupRoutines,
  routineBucket,
  routineFilterChoices,
  routineProjectKey,
  type RoutineListEntry,
} from "./routineList.logic";

const m4 = EnvironmentId.make("m4");
const ministorm = EnvironmentId.make("ministorm");

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: ScheduledTaskId.make(id),
    title: id,
    prompt: `Prompt for ${id}`,
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("app"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    ...overrides,
  };
}

function entry(
  value: ScheduledTask,
  options: { environmentId?: EnvironmentId; provider?: string; project?: string } = {},
): RoutineListEntry {
  const environmentId = options.environmentId ?? m4;
  return {
    environmentId,
    machineLabel: environmentId === m4 ? "M4" : "ministorm",
    task: value,
    projectLabel: options.project ?? "App",
    providerKey: options.provider ?? "claude",
    providerLabel: options.provider === "codex" ? "Codex" : "Claude",
  };
}

describe("routineBucket", () => {
  it("separates finished one-time runs from paused routines", () => {
    const ranOnce = task("once", {
      enabled: false,
      schedule: { type: "once", at: "2026-10-02T09:00:00.000Z" },
      lastRunAt: "2026-10-02T09:00:01.000Z",
      lastRunStatus: "succeeded",
    });
    expect(routineBucket(ranOnce)).toBe("finished");
    expect(routineBucket({ ...ranOnce, lastRunAt: null })).toBe("paused");
    expect(routineBucket(task("off", { enabled: false }))).toBe("paused");
  });

  it("keeps a one-time routine the server turned off after a failure in attention", () => {
    const failedOnce = task("failed-once", {
      enabled: false,
      schedule: { type: "once", at: "2026-10-02T09:00:00.000Z" },
      lastRunAt: "2026-10-02T09:00:01.000Z",
      lastRunStatus: "failed",
      lastRunError: "The provider stopped. Turned off; turn it on to try again.",
    });
    expect(routineBucket(failedOnce)).toBe("attention");
  });

  it("flags a failed live routine and keeps a running one active", () => {
    expect(routineBucket(task("bad", { lastRunStatus: "failed" }))).toBe("attention");
    expect(routineBucket(task("paused-bad", { enabled: false, lastRunStatus: "failed" }))).toBe(
      "paused",
    );
    expect(routineBucket(task("busy", { enabled: false, lastRunStatus: "running" }))).toBe(
      "active",
    );
    expect(routineBucket(task("ask", { enabled: false, schedule: { type: "manual" } }))).toBe(
      "active",
    );
  });
});

describe("filterRoutines", () => {
  const entries = [
    entry(task("Sentry sweep", { prompt: "Check Sentry issues" })),
    entry(task("Nightly build", { lastRunStatus: "failed" }), {
      environmentId: ministorm,
      provider: "codex",
      project: "Studio",
    }),
    entry(task("Old report", { enabled: false })),
  ];

  it("filters by machine, provider, project and state together", () => {
    const pick = (filters: Partial<typeof DEFAULT_ROUTINE_FILTERS>) =>
      filterRoutines(entries, { ...DEFAULT_ROUTINE_FILTERS, ...filters }).map(
        (value) => value.task.title,
      );
    expect(pick({})).toHaveLength(3);
    expect(pick({ environmentId: ministorm })).toEqual(["Nightly build"]);
    expect(pick({ providerKey: "claude" })).toEqual(["Sentry sweep", "Old report"]);
    expect(pick({ projectKey: routineProjectKey(entries[1]!) })).toEqual(["Nightly build"]);
    expect(pick({ state: "paused" })).toEqual(["Old report"]);
    expect(pick({ state: "attention", providerKey: "claude" })).toEqual([]);
  });

  it("searches title, prompt, project, machine and provider with every word", () => {
    const search = (query: string) =>
      filterRoutines(entries, { ...DEFAULT_ROUTINE_FILTERS, query }).map(
        (value) => value.task.title,
      );
    expect(search("sentry")).toEqual(["Sentry sweep"]);
    expect(search("codex ministorm")).toEqual(["Nightly build"]);
    expect(search("codex m4")).toEqual([]);
  });
});

describe("groupRoutines", () => {
  const entries = [
    entry(task("b-active")),
    entry(task("a-paused", { enabled: false })),
    entry(task("c-failed", { lastRunStatus: "failed" })),
    entry(task("d-other", {}), { environmentId: ministorm, provider: "codex" }),
  ];

  it("puts failed routines first and folds paused ones into the tail", () => {
    const [m4Group, ministormGroup] = groupRoutines(entries, "machine");
    expect(m4Group!.label).toBe("M4");
    expect(m4Group!.live.map((value) => value.task.title)).toEqual(["c-failed", "b-active"]);
    expect(m4Group!.inactive.map((value) => value.task.title)).toEqual(["a-paused"]);
    expect(ministormGroup!.label).toBe("ministorm");
  });

  it("keeps a deep-linked paused routine open, and folds nothing when asked not to", () => {
    const [m4Group] = groupRoutines(entries, "machine", {
      keepOpen: ScheduledTaskId.make("a-paused"),
    });
    expect(m4Group!.live.map((value) => value.task.title)).toContain("a-paused");
    expect(m4Group!.inactive).toEqual([]);
    const [open] = groupRoutines(entries, "machine", { fold: false });
    expect(open!.inactive).toEqual([]);
    expect(open!.live).toHaveLength(3);
  });

  it("does not fold a group whose routines are all paused or finished", () => {
    const [only] = groupRoutines([entry(task("off", { enabled: false }))], "machine");
    expect(only!.live.map((value) => value.task.title)).toEqual(["off"]);
    expect(only!.inactive).toEqual([]);
  });

  it("groups by provider and orders state groups by what needs the reader", () => {
    expect(groupRoutines(entries, "provider").map((group) => group.label)).toEqual([
      "Claude",
      "Codex",
    ]);
    const byState = groupRoutines(entries, "state");
    expect(byState.map((group) => group.label)).toEqual(["Needs attention", "Active", "Paused"]);
    expect(byState.every((group) => group.inactive.length === 0)).toBe(true);
  });
});

describe("routineFilterChoices", () => {
  it("lists each choice once, sorted by label", () => {
    const entries = [
      entry(task("one"), { provider: "codex" }),
      entry(task("two")),
      entry(task("three"), { provider: "codex" }),
    ];
    expect(
      routineFilterChoices(entries, (value) => ({
        key: value.providerKey,
        label: value.providerLabel,
      })),
    ).toEqual([
      { key: "claude", label: "Claude" },
      { key: "codex", label: "Codex" },
    ]);
  });
});
