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
import { rearmReasonText, rearmStatusText } from "./StandbyRearmList";

const state = vi.hoisted(() => ({
  connected: {} as Record<string, boolean>,
  capable: {} as Record<string, boolean>,
  remoteWorkers: [] as Array<{ machineLabel: string; state: string }>,
  disarmed: [] as Array<Record<string, unknown>>,
  handoff: null as Record<string, unknown> | null,
  rearmCapable: [] as string[],
  syncStatus: {} as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) => async (request: { environmentId: string }) => ({
    _tag: "Success",
    value:
      tag === "projectLink.syncStatus"
        ? { pairs: [], ...(state.syncStatus[request.environmentId] ?? {}) }
        : {},
  }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "m4",
  useEnvironments: () => ({
    environments: ["m4", "m1", "m3"].map((environmentId) => ({
      environmentId,
      serverConfig: {
        environment: {
          capabilities: {
            coordinatorStandby: state.capable[environmentId] ?? true,
            coordinatorRearm: state.rearmCapable.includes(environmentId),
          },
        },
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
  saveRearmList: async (_commands: unknown, input: Record<string, unknown>) => {
    state.saved.push(input);
    return new Map();
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
  state.rearmCapable = [];
  state.syncStatus = {};
  state.saved = [];
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
      "If this machine goes quiet",
      "If M4 goes quiet",
      "M3 lets M1 take over.",
      "Ready. M1 can take over.",
      "Not ready. M3 has not allowed M1 yet.",
      "M1 must stay awake. If it is off, this machine pauses its coordinator.",
    ]);
    expect(lines[6]).toMatch(/^M1 took over from M4 at .+\. M4 went quiet\.$/);
    expect(lines.slice(7)).toEqual([
      "3 workers on M3 report here now.",
      "1 worker on M3 reports here now.",
      "M1 took over while this machine was away. This machine now runs workers.",
      "Open M1 and hand the coordinator back.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/[—–]/);
  });
});

describe("CoordinatorStandbyView", () => {
  const props = (overrides: Partial<CoordinatorStandbyViewProps> = {}) => {
    const calls: string[] = [];
    const value: CoordinatorStandbyViewProps = {
      title: "If this machine goes quiet",
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
      warning: "M1 must stay awake. If it is off, this machine pauses its coordinator.",
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
    expect(text()).toContain("If this machine goes quiet");
    expect(text()).toContain("M1");
    expect(text()).toContain("15 minutes");
    expect(text()).toContain("Not ready. M3 has not allowed M1 yet.");
    expect(text()).toContain("Wait a minute before allowing workers on this machine again.");
    expect(text()).toContain(
      "M1 must stay awake. If it is off, this machine pauses its coordinator.",
    );
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
    expect(text()).toContain("If this machine goes quiet");
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
    expect(text()).toContain(
      "M1 took over while this machine was away. This machine now runs workers.",
    );
    await click(button("Make this machine the coordinator again"));
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
    expect(text()).not.toContain("Make this machine the coordinator again");
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

describe("re-arm after a takeover", () => {
  const run = (overrides: Record<string, unknown>) =>
    ({
      state: "pending",
      reason: "unreachable",
      detail: "M3",
      standby: null,
      epoch: 3,
      since: "2026-10-26T14:31:00.000Z",
      ...overrides,
    }) as never;
  const label = (id: string) => ({ m3: "M3", m1: "M1" })[id] ?? "Machine";

  it("says why no standby is armed yet, and whether it waits for the owner", () => {
    expect(rearmStatusText(run({}), label)).toBe(
      "No standby armed yet: M3 did not answer. Trying again.",
    );
    expect(rearmStatusText(run({ reason: "needs_grant" }), label)).toBe(
      "No standby armed yet: This machine needs access to M3. Prepare machines again. Waiting for you.",
    );
    expect(rearmStatusText(run({ state: "verifying", standby: ref("m3", "p3") }), label)).toBe(
      "Checking M3.",
    );
    expect(rearmStatusText(run({ state: "armed", standby: ref("m3", "p3") }), label)).toBe(
      "Armed M3 automatically after taking over.",
    );
    expect(
      rearmStatusText(
        run({ state: "pending", reason: "standby_missing", standby: ref("m3", "p3") }),
        label,
      ),
    ).toBe("M3 is still named as the standby: M3 stopped standing by. Trying again later.");
    expect(rearmStatusText(run({ state: "stopped", reason: "owner_changed" }), label)).toBeNull();
    expect(rearmStatusText(null, label)).toBeNull();
    const reasons = [
      "unreachable",
      "needs_grant",
      "needs_update",
      "not_member",
      "no_consent",
      "team_rules",
      "lease_failed",
      "standby_missing",
      "no_candidates",
    ] as const;
    for (const reason of reasons) expect(rearmReasonText(reason, "M3")).not.toMatch(/[—–]/);
  });

  it("shows the status line on the machine that took over", async () => {
    state.rearmCapable = ["m1", "m3", "m4"];
    state.syncStatus = {
      m1: {
        standbyRearm: {
          consent: {
            chainId: "chain-a",
            members: [ref("m1", "p1"), ref("m3", "p3")],
            afterMinutes: 5,
          },
          run: run({}),
        },
      },
    };
    const coordinator = copy("m1", "p1", {
      epoch: 3,
      state: "active",
      takenOverBy: "auto",
      takenOverAt: "2026-10-26T14:30:00.000Z",
      predecessor: ref("m4", "p4"),
    });
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings
          coordinator={coordinator as never}
          shared={
            [
              coordinator,
              copy("m4", "p4", { epoch: 2, state: "transferred" }),
              copy("m3", "p3", { epoch: 2, state: "transferred" }),
            ] as never
          }
        />,
      ),
    );
    expect(text()).toContain("No standby armed yet: M3 did not answer. Trying again.");
  });

  it("lists the saved order, edits it within the cap, and saves only the consent", async () => {
    state.rearmCapable = ["m1", "m3", "m4"];
    const standby = { member: ref("m1", "p1"), afterMinutes: 5, enabledAt: "2026-10-26T12:00:00Z" };
    state.syncStatus = {
      m1: {
        standbyRearm: {
          consent: {
            chainId: "chain-a",
            members: [ref("m1", "p1"), ref("m3", "p3")],
            afterMinutes: 5,
          },
          run: null,
        },
      },
    };
    const coordinator = copy("m4", "p4", { epoch: 2, state: "active", standby });
    const shared = [
      coordinator,
      copy("m1", "p1", { epoch: 2, state: "transferred" }),
      copy("m3", "p3", { epoch: 2, state: "transferred" }),
    ];
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings coordinator={coordinator as never} shared={shared as never} />,
      ),
    );
    expect(text()).toContain("If it takes over, arm next");
    expect(text()).toContain("only after it gives way");
    const box = (id: string) =>
      document.querySelector<HTMLElement>(`[data-rearm-machine="${id}"] [role="checkbox"]`)!;
    expect(box("m3").getAttribute("aria-checked")).toBe("true");
    expect(box("m4").getAttribute("aria-checked")).toBe("false");
    expect(text()).not.toContain("Save list");
    await click(box("m4"));
    await click(button("Save list"));
    expect(state.saved).toEqual([
      expect.objectContaining({
        logicalProjectId: "logical:1",
        afterMinutes: 5,
        standby: expect.objectContaining({ environmentId: "m1" }),
        plan: expect.objectContaining({
          fromEpoch: 2,
          order: [
            expect.objectContaining({ environmentId: "m3" }),
            expect.objectContaining({ environmentId: "m4" }),
          ],
          previous: [
            expect.objectContaining({ environmentId: "m1" }),
            expect.objectContaining({ environmentId: "m3" }),
          ],
        }),
      }),
    ]);
    expect(text()).toContain("List saved.");
  });

  it("asks to update a standby that cannot hold a list", async () => {
    state.rearmCapable = ["m4", "m3"];
    const standby = { member: ref("m1", "p1"), afterMinutes: 5, enabledAt: "2026-10-26T12:00:00Z" };
    const coordinator = copy("m4", "p4", { epoch: 2, state: "active", standby });
    await act(async () =>
      root.render(
        <CoordinatorStandbySettings
          coordinator={coordinator as never}
          shared={[coordinator, copy("m1", "p1", { epoch: 2, state: "transferred" })] as never}
        />,
      ),
    );
    expect(text()).toContain(
      "Update SpecWithCode on M1 to arm the next machine after it takes over.",
    );
    expect(text()).not.toContain("If it takes over, arm next");
  });
});
