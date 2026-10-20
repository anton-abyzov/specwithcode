// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type ProjectPlanSnapshot,
  type ProjectPlanTask,
  ThreadId,
} from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
  }>,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
import { claimMachine, PlanTaskClaim, usePlanClaimMachines } from "./PlanTaskClaim";

const here = EnvironmentId.make("env-here");
const peer = EnvironmentId.make("env-peer");
const at = "2026-05-01T10:00:00.000Z";
const task = (overrides: Partial<ProjectPlanTask> = {}): ProjectPlanTask => ({
  id: "T-001",
  title: "Ship it",
  criterionIds: [],
  status: "in_progress",
  owner: null,
  note: "",
  verification: null,
  evidence: [],
  ...overrides,
});
const snapshot = {
  projectId: "project",
  environmentId: here,
  revision: 1,
  authority: { kind: "native" },
  native: {
    title: "",
    spec: "",
    criteria: [],
    tasks: [],
    contentRevision: 1,
    machines: [{ environmentId: peer, label: "Saved Mac" }],
  },
  external: null,
} as unknown as ProjectPlanSnapshot;

let root: Root;
let host: HTMLDivElement;
const opened = vi.fn();

function Harness({ value }: { value: ProjectPlanTask }) {
  const machines = usePlanClaimMachines(snapshot);
  return <PlanTaskClaim task={value} here={here} machines={machines} onOpenThread={opened} />;
}
function render(value: ProjectPlanTask) {
  act(() => root.render(<Harness value={value} />));
  return host.textContent ?? "";
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  state.environments = [];
  opened.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("PlanTaskClaim", () => {
  it("names the machine that holds a claim made elsewhere", () => {
    state.environments = [
      { environmentId: peer, label: "Mac Studio", connection: { phase: "connected" } },
    ];
    const text = render(
      task({
        owner: { kind: "thread", threadId: ThreadId.make("worker"), environmentId: peer },
        claimedAt: at,
      }),
    );
    expect(text).toContain("Claimed on Mac Studio · thread worker");
    expect(text).not.toContain("Stale");
    expect(host.querySelector("button")).toBeNull();
  });

  it("marks a claim stale when its machine is unreachable and only the user can release it", () => {
    state.environments = [
      { environmentId: peer, label: "Mac Studio", connection: { phase: "disconnected" } },
    ];
    const text = render(
      task({ owner: { kind: "thread", threadId: ThreadId.make("worker"), environmentId: peer } }),
    );
    expect(text).toContain(
      "Claimed on Mac Studio · thread worker · Stale · Mac Studio unreachable · only you can release it",
    );
    expect(host.querySelector(".project-plan-claim-stale")).not.toBeNull();
  });

  it("falls back to the name saved with the plan for a machine this app does not know", () => {
    const text = render(
      task({ owner: { kind: "thread", threadId: ThreadId.make("worker"), environmentId: peer } }),
    );
    expect(text).toContain("Claimed on Saved Mac");
    expect(text).toContain("Stale · Saved Mac unreachable · only you can release it");
  });

  it("keeps a local thread claim as a link to its thread", () => {
    const text = render(
      task({ owner: { kind: "thread", threadId: ThreadId.make("local"), environmentId: here } }),
    );
    expect(text).toBe("Assigned thread: local");
    act(() => host.querySelector("button")?.click());
    expect(opened).toHaveBeenCalledWith("local");
    expect(render(task({ owner: { kind: "user" } }))).toBe("Assigned to you");
    expect(render(task())).toBe("Unassigned");
  });

  it("shows the losing claim of a conflict on both machines", () => {
    state.environments = [
      { environmentId: peer, label: "Mac Studio", connection: { phase: "connected" } },
    ];
    const winner = {
      kind: "thread" as const,
      threadId: ThreadId.make("first"),
      environmentId: here,
    };
    const text = render(
      task({
        owner: winner,
        claimedAt: at,
        claimConflict: {
          owner: { kind: "thread", threadId: ThreadId.make("second"), environmentId: peer },
          claimedAt: "2026-05-01T10:00:05.000Z",
        },
      }),
    );
    expect(text).toContain("Assigned thread: first");
    expect(text).toContain(
      "Conflict · thread second on Mac Studio also claimed it while the machines were apart; the earlier claim stands",
    );
    const local = render(
      task({
        owner: { kind: "thread", threadId: ThreadId.make("second"), environmentId: peer },
        claimConflict: { owner: { kind: "user" } },
      }),
    );
    expect(local).toContain("Conflict · you also claimed it");
  });

  it("treats a thread without a machine as this machine's", () => {
    expect(claimMachine({ kind: "thread", threadId: ThreadId.make("a") }, here)).toBeNull();
    expect(claimMachine({ kind: "user" }, here)).toBeNull();
    expect(claimMachine(null, here)).toBeNull();
    expect(
      claimMachine({ kind: "thread", threadId: ThreadId.make("a"), environmentId: peer }, here),
    ).toBe(peer);
  });
});
