// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  progress: new Map<string, { incrementId: string }>(),
  answered: true,
  plans: new Map<string, { label: string }>(),
  elsewhere: [] as string[],
}));
vi.mock("../../../studio/useThreadIncrementProgress", () => ({
  useProjectThreadIncrementProgress: () => ({
    progress: runtime.progress,
    unplanned: new Set(),
    answered: runtime.answered,
  }),
}));
vi.mock("../../sidebar/SidebarPlanProgress", () => ({
  useSidebarThreadPlans: (threads: ReadonlyArray<{ id: string }>) => {
    runtime.elsewhere = threads.map((thread) => thread.id);
    return { plans: runtime.plans, loaders: null };
  },
}));
const ENVIRONMENTS = {
  environments: [
    { environmentId: "host", label: "Desk" },
    { environmentId: "other", label: "Rack" },
  ],
};
vi.mock("../../../state/environments", () => ({ useEnvironments: () => ENVIRONMENTS }));
const NONE = new Set<string>();
vi.mock("../../../studio/unreachableHosts", () => ({ useUnreachableHosts: () => NONE }));
const nickname = (id: string, label?: string | null) => label ?? id;
vi.mock("../../../studio/machineNickname", () => ({ useMachineNicknames: () => nickname }));
const identity = (id: string) => ({ color: id === "host" ? "violet" : "teal" });
vi.mock("../../../studio/machineIdentity", () => ({ useMachineIdentities: () => identity }));

const { useBoardThreads } = await import("./BoardThreads");

const thread = (id: string, environmentId: string, extra: object = {}) =>
  ({
    id,
    environmentId,
    projectId: "atlas",
    title: `Thread ${id}`,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-11-14T08:00:00Z",
    updatedAt: "2026-11-14T09:00:00Z",
    ...extra,
  }) as unknown as EnvironmentThreadShell;

describe("useBoardThreads", () => {
  let root: Root;
  let container: HTMLDivElement;
  let seen: ReturnType<typeof useBoardThreads>;
  function Probe({ threads }: { threads: EnvironmentThreadShell[] }) {
    seen = useBoardThreads({ environmentId: "host" as EnvironmentId, threads });
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.progress = new Map();
    runtime.plans = new Map();
    runtime.answered = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const key = (environmentId: string, id: string) =>
    scopedThreadKey(scopeThreadRef(environmentId as EnvironmentId, id as never));

  it("joins threads on this machine and on others to their increment, by folder name", async () => {
    runtime.progress = new Map([
      ["a", { incrementId: "0002-build" }],
      ["moved", { incrementId: "0002-build" }],
      ["gone", { incrementId: "0002-build" }],
    ]);
    runtime.plans = new Map([[key("other", "b"), { label: "0002-build" }]]);
    const threads = [
      thread("a", "host", { runtime: { status: "running" } }),
      thread("moved", "host", {
        hasPendingUserInput: true,
        source: { ownerMachineId: "host", executionMachineId: "other", executionMachineLabel: "Rack" },
      }),
      thread("b", "other"),
      thread("free", "host"),
      thread("gone", "host", { archivedAt: "2026-11-14T09:30:00Z" }),
    ];
    await act(async () => root.render(<Probe threads={threads} />));
    // Only another machine's threads are read through the per-machine plans.
    expect(runtime.elsewhere).toEqual(["b"]);
    expect([...seen.byIncrement.keys()]).toEqual(["0002-build"]);
    const lines = seen.byIncrement.get("0002-build")!;
    // The one that needs the person leads; the archived and the unlinked are left out.
    expect(lines.map((line) => line.thread.id)).toEqual(["moved", "a", "b"]);
    expect(lines[0]).toMatchObject({ tone: "waiting", color: "teal" });
    expect(lines[0]!.machine).toMatchObject({ moved: true, label: "Desk → Rack" });
    expect(lines[1]).toMatchObject({ color: "violet" });
    expect(lines[1]!.machine.moved).toBe(false);
    expect(lines[2]).toMatchObject({ color: "teal" });
    expect(seen.multiMachine).toBe(true);
    expect(seen.answered).toBe(true);
  });

  it("stays on one machine's quiet look and passes on that the read has not answered", async () => {
    runtime.answered = false;
    await act(async () => root.render(<Probe threads={[thread("a", "host")]} />));
    expect(seen.byIncrement.size).toBe(0);
    expect(seen.multiMachine).toBe(false);
    expect(seen.answered).toBe(false);
  });
});
