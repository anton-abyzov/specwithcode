// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CoordinatorStandbySettings,
  CoordinatorStandbyView,
  type CoordinatorStandbyViewProps,
  handBackHint,
  returnedText,
  standbyRowText,
  standbySectionTitle,
  standbyWarningText,
  tookOverText,
  workersReportHereText,
} from "./CoordinatorStandbySettings";

const state = vi.hoisted(() => ({
  connected: {} as Record<string, boolean>,
  capable: {} as Record<string, boolean>,
  remoteWorkers: [] as Array<{ machineLabel: string; state: string }>,
  disarmed: [] as Array<Record<string, unknown>>,
  handoff: null as Record<string, unknown> | null,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "m4",
  useEnvironments: () => ({
    environments: ["m4", "m1", "m3"].map((environmentId) => ({
      environmentId,
      serverConfig: {
        environment: { capabilities: { coordinatorStandby: state.capable[environmentId] ?? true } },
      },
    })),
  }),
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (id: string) => ({ m4: "M4", m1: "M1", m3: "M3" })[id] ?? "Machine",
    state: (id: string) => (state.connected[id] === false ? "offline" : "ready"),
    problem: () => null,
    connected: (id: string) => state.connected[id] !== false,
    takeoverReady: () => true,
    startReady: () => true,
  }),
}));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: null, loading: false, failed: false, refresh: () => {} }),
  useProjectRemoteWorkers: () => ({
    workers: state.remoteWorkers,
    available: true,
    refresh: () => {},
  }),
}));
vi.mock("../../studio/standbyArmingCommands", () => ({
  hasFullAccess: () => true,
  liveStandbyArmingCommands: {},
}));
vi.mock("../../studio/standbyArming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../studio/standbyArming")>()),
  disarmStandby: async (_commands: unknown, input: Record<string, unknown>) => {
    state.disarmed.push(input);
  },
}));
vi.mock("./ProjectMachineHandoff", () => ({
  ProjectMachineHandoff: (props: Record<string, unknown>) => {
    state.handoff = props;
    return null;
  },
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "7307ab55-fc59-4e07-abeb-de54be69215f",
}));

const ref = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const identity = {
  id: "logical:1",
  title: "EasyChamp",
  coordinatorId: "coordinator:logical:1",
  members: [ref("m4", "p4"), ref("m1", "p1"), ref("m3", "p3")],
};
const copy = (environmentId: string, id: string, binding: Record<string, unknown>) => ({
  environmentId,
  id,
  title: "EasyChamp",
  workspaceRoot: `/${environmentId}/EasyChamp`,
  workspaceSettings: { kind: "code", logicalProject: identity, coordinatorBinding: binding },
});

let root: Root, container: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${text()}`);
  return element;
};
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.connected = {};
  state.capable = {};
  state.remoteWorkers = [];
  state.disarmed = [];
  state.handoff = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("copy", () => {
  it("speaks in short plain sentences without dashes", () => {
    const lines = [
      standbySectionTitle("M4", true),
      standbySectionTitle("M4", false),
      standbyRowText("M3", "M1", "unknown"),
      standbyRowText("M3", "M1", "ready"),
      standbyRowText("M3", "M1", "failed"),
      standbyWarningText("M1", "M4", true),
      tookOverText("M1", "M4", "2026-10-26T14:30:00.000Z"),
      workersReportHereText(3, "M3"),
      workersReportHereText(1, "M3"),
      returnedText("M1", "M4", true),
      handBackHint("M1"),
    ];
    expect(lines.slice(0, 6)).toEqual([
      "If this Mac goes quiet",
      "If M4 goes quiet",
      "M3 lets M1 take over.",
      "Ready. M1 can take over.",
      "Not ready. M3 has not allowed M1 yet.",
      "M1 must stay awake. If it is off, this Mac pauses its coordinator.",
    ]);
    expect(lines[6]).toMatch(/^M1 took over from M4 at .+\. M4 went quiet\.$/);
    expect(lines.slice(7)).toEqual([
      "3 workers on M3 report here now.",
      "1 worker on M3 reports here now.",
      "M1 took over while this Mac was away. This Mac now runs workers.",
      "Open M1 and hand the coordinator back.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/[—–]/);
  });
});

describe("CoordinatorStandbyView", () => {
  const props = (overrides: Partial<CoordinatorStandbyViewProps> = {}) => {
    const calls: string[] = [];
    const value: CoordinatorStandbyViewProps = {
      title: "If this Mac goes quiet",
      choices: [
        { environmentId: "m1" as never, label: "M1" },
        { environmentId: "m3" as never, label: "M3" },
      ],
      standby: "m1" as never,
      afterMinutes: 15,
      rows: [
        {
          environmentId: "m3" as never,
          text: "Not ready. M3 has not allowed M1 yet.",
          state: "failed",
          error: "Wait a minute before allowing workers on this machine again.",
        },
      ],
      warning: "M1 must stay awake. If it is off, this Mac pauses its coordinator.",
      problem: null,
      fenceNote: null,
      pending: false,
      message: null,
      canChangeAnyway: false,
      onStandby: (id) => calls.push(`standby ${id}`),
      onAfter: (minutes) => calls.push(`after ${minutes}`),
      onAllow: () => calls.push("allow"),
      onChangeAnyway: () => calls.push("change anyway"),
      onRunHereAnyway: () => calls.push("run here"),
      ...overrides,
    };
    return { value, calls };
  };

  it("shows the choice, delay, arming rows with their errors and the warning", async () => {
    const { value, calls } = props();
    await act(async () => root.render(<CoordinatorStandbyView {...value} />));
    expect(text()).toContain("If this Mac goes quiet");
    expect(text()).toContain("M1");
    expect(text()).toContain("15 minutes");
    expect(text()).toContain("Not ready. M3 has not allowed M1 yet.");
    expect(text()).toContain("Wait a minute before allowing workers on this machine again.");
    expect(text()).toContain("M1 must stay awake. If it is off, this Mac pauses its coordinator.");
    await click(button("Allow"));
    expect(calls).toEqual(["allow"]);
  });

  it("hides the delay and rows while off, and says why arming cannot start here", async () => {
    const { value } = props({
      standby: null,
      rows: [],
      warning: null,
      problem: "Set this up in the SpecWithCode desktop app.",
    });
    await act(async () => root.render(<CoordinatorStandbyView {...value} />));
    expect(text()).toContain("Off");
    expect(text()).toContain("Set this up in the SpecWithCode desktop app.");
    expect(text()).not.toContain("minutes");
  });

  it("offers Change anyway and Run here anyway", async () => {
    const { value, calls } = props({
      rows: [],
      fenceNote: "Checking with M1 before running.",
      message: {
        text: "The Mac that takes over automatically did not answer. Choose Change anyway to go ahead without it.",
        error: true,
      },
      canChangeAnyway: true,
    });
    await act(async () => root.render(<CoordinatorStandbyView {...value} />));
    expect(text()).toContain("Checking with M1 before running.");
    expect(text()).toContain("This turns off automatic takeover.");
    await click(button("Change anyway"));
    await click(button("Run here anyway"));
    expect(calls).toEqual(["change anyway", "run here"]);
  });
});

describe("CoordinatorStandbySettings", () => {
  const standby = { member: ref("m1", "p1"), afterMinutes: 30, enabledAt: "2026-10-26T12:00:00Z" };

  it("shows nothing for a coordinator too old to lease", async () => {
    state.capable = { m4: false };
    const coordinator = copy("m4", "p4", { epoch: 2, state: "active" });
    const shared = [coordinator, copy("m1", "p1", { epoch: 2, state: "transferred" })];
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings coordinator={coordinator as never} shared={shared as never} />,
      ),
    );
    expect(text()).toBe("");
  });

  it("lets the owner run here anyway when the standby is gone, which turns it off", async () => {
    state.connected = { m1: false };
    const coordinator = copy("m4", "p4", { epoch: 2, state: "active", standby });
    const shared = [coordinator, copy("m1", "p1", { epoch: 2, state: "transferred" })];
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings coordinator={coordinator as never} shared={shared as never} />,
      ),
    );
    expect(text()).toContain("If this Mac goes quiet");
    expect(text()).toContain("30 minutes");
    expect(text()).toContain("Checking with M1 before running.");
    await click(button("Run here anyway"));
    expect(state.disarmed).toEqual([
      expect.objectContaining({
        logicalProjectId: "logical:1",
        changeAnyway: true,
        coordinator: expect.objectContaining({ environmentId: "m4", projectId: "p4" }),
        standby: expect.objectContaining({ environmentId: "m1", projectId: "p1" }),
      }),
    ]);
    expect(text()).toContain("Automatic takeover is off.");
  });

  it("on the machine that took over, says so and counts the workers that report there", async () => {
    state.remoteWorkers = [
      { machineLabel: "M3", state: "following" },
      { machineLabel: "M3", state: "wake_pending" },
      { machineLabel: "M3", state: "idle" },
      { machineLabel: "M3", state: "stopped" },
    ];
    const coordinator = copy("m1", "p1", {
      epoch: 3,
      state: "active",
      takenOverBy: "auto",
      takenOverAt: "2026-10-26T14:30:00.000Z",
      predecessor: ref("m4", "p4"),
    });
    const returned = copy("m4", "p4", {
      epoch: 2,
      state: "transferred",
      successor: ref("m1", "p1"),
      takenOverAt: "2026-10-26T14:30:00.000Z",
    });
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings
          coordinator={coordinator as never}
          shared={[coordinator, returned] as never}
        />,
      ),
    );
    expect(text()).toMatch(/M1 took over from M4 at .+\. M4 went quiet\./);
    expect(text()).toContain("3 workers on M3 report here now.");
    expect(text()).toContain("M1 took over while this Mac was away. This Mac now runs workers.");
    await click(button("Make this Mac the coordinator again"));
    expect(state.handoff).toMatchObject({ requestedTarget: "m4:p4" });
  });

  it("asks the owner to open the new coordinator when this app cannot reach it", async () => {
    state.connected = { m1: false };
    const coordinator = copy("m1", "p1", {
      epoch: 3,
      state: "active",
      takenOverBy: "auto",
      takenOverAt: "2026-10-26T14:30:00.000Z",
      predecessor: ref("m4", "p4"),
    });
    const returned = copy("m4", "p4", { epoch: 2, state: "transferred" });
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings
          coordinator={coordinator as never}
          shared={[coordinator, returned] as never}
        />,
      ),
    );
    expect(text()).toContain("Open M1 and hand the coordinator back.");
    expect(text()).not.toContain("Make this Mac the coordinator again");
  });

  it("says nothing about a takeover the owner made by hand", async () => {
    const coordinator = copy("m1", "p1", {
      epoch: 3,
      state: "active",
      takenOverBy: "person",
      takenOverAt: "2026-10-26T14:30:00.000Z",
      predecessor: ref("m4", "p4"),
    });
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings
          coordinator={coordinator as never}
          shared={[coordinator, copy("m4", "p4", { epoch: 2, state: "transferred" })] as never}
        />,
      ),
    );
    expect(text()).not.toContain("went quiet");
  });
});
