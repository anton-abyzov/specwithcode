import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
const runtime = vi.hoisted(() => ({
  snapshot: null as StudioFleetSnapshot | null,
  pair: vi.fn(),
  connect: vi.fn(),
  autoConnect: true,
  updateSettings: vi.fn(),
  allowWorkers: vi.fn(),
  stopWorkers: vi.fn(),
  addMachine: vi.fn(),
  environments: [] as Array<{ readonly entry: unknown }>,
  defaultRuntimeMode: "approval-required",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("../../studio/fleet", () => ({
  addStudioFleetMachine: runtime.addMachine,
  pairStudioFleet: runtime.pair,
  allowStudioFleetWorkers: runtime.allowWorkers,
  stopStudioFleetWorkers: runtime.stopWorkers,
  useStudioFleet: () => ({
    snapshot: runtime.snapshot,
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: runtime.environments }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { autoConnectPrivateMachines: boolean }) => unknown) =>
    select({ autoConnectPrivateMachines: runtime.autoConnect }),
  useUpdateClientSettings: () => runtime.updateSettings,
  useEnvironmentSettings: (
    _environmentId: string,
    select: (settings: { defaultRuntimeMode: string }) => unknown,
  ) => select({ defaultRuntimeMode: runtime.defaultRuntimeMode }),
}));
vi.mock("../../lib/machineLastSeen", () => ({
  machineLastSeenAt: () => null,
  useMachineLastSeenVersion: () => 0,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => runtime.connect }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null, SettingsSection: () => null }));
import {
  FleetWorkersRow,
  fleetMachineAddress,
  StudioFleetConnections,
  StudioFleetRoster,
  StudioListenerRow,
} from "./StudioFleetConnections";
const m4 = EnvironmentId.make("env-m4"),
  m1 = EnvironmentId.make("env-m1");
const snapshot: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-10-08T12:00:00Z",
  listener: "loopback",
  machines: [
    {
      id: "m4",
      environmentId: m4,
      label: "Mac M4",
      url: "https://fixture.tailnet.ts.net",
      status: "reachable",
      pairingConfigured: false,
    },
    {
      id: "m1",
      environmentId: m1,
      label: "Mac M1",
      url: "https://fixture.tailnet.ts.net:8443",
      status: "reachable",
      pairingConfigured: true,
    },
  ],
};
function render(overrides: Partial<Parameters<typeof StudioFleetRoster>[0]> = {}) {
  return StudioFleetRoster({
    snapshot,
    loading: false,
    failed: false,
    canPair: true,
    environmentId: m4,
    savedEnvironmentIds: [],
    pending: null,
    error: null,
    onRefresh: vi.fn(),
    onPair: vi.fn(),
    ...overrides,
  });
}
const connectButton = (tree: unknown) =>
  visitElements(tree, (element) => element.props.children === "Connect machine");
const autoConnectSwitch = (tree: unknown) =>
  visitElements(
    tree,
    (element) => element.props["aria-label"] === "Connect private machines automatically",
  );
describe("private machine address", () => {
  it("names the relay for a machine reached through another machine's private name", () => {
    expect(fleetMachineAddress(snapshot.machines[1]!, snapshot.machines)).toBe(
      "Through Mac M4, port 8443",
    );
    expect(fleetMachineAddress(snapshot.machines[0]!, snapshot.machines)).toBe(
      "fixture.tailnet.ts.net",
    );
  });
  it("shows a machine's own host and port when no configured machine owns that name", () => {
    const own = { id: "m3", label: "Mac M3", url: "https://m3.tailnet.ts.net:8444" };
    expect(fleetMachineAddress(own, [...snapshot.machines, own])).toBe("m3.tailnet.ts.net:8444");
  });
});
describe("private machine roster", () => {
  beforeEach(() => {
    hooks.reset();
    runtime.snapshot = snapshot;
    runtime.pair.mockReset();
    runtime.connect.mockReset();
    runtime.updateSettings.mockReset();
    runtime.addMachine.mockReset();
    runtime.environments = [];
    runtime.autoConnect = true;
  });
  it("shows Connect again after pairing and removal from the authoritative browser catalog without remounting", async () => {
    runtime.pair.mockResolvedValue({
      host: snapshot.machines[1]!.url,
      environmentId: m1,
      pairingCode: "synthetic-one-time",
    });
    runtime.connect.mockResolvedValue({ _tag: "Success", value: m1 });
    const connected = (savedEnvironmentIds: ReadonlyArray<typeof m1>) => {
      hooks.beginRender();
      return StudioFleetConnections({ environmentId: m4, savedEnvironmentIds });
    };
    const initial = connected([]);
    initial.props.onPair(snapshot.machines[1]!);
    await vi.waitFor(() => expect(runtime.connect).toHaveBeenCalledOnce());
    expect(runtime.connect).toHaveBeenCalledWith({
      host: snapshot.machines[1]!.url,
      pairingCode: "synthetic-one-time",
      expectedEnvironmentId: m1,
    });
    expect(connectButton(StudioFleetRoster(connected([m1]).props))).toBeNull();
    const removed = connected([]);
    expect(connectButton(StudioFleetRoster(removed.props))?.props.disabled).toBe(false);
  });
  it("shows an unpaired M1 in a fresh browser and calls pairing only on an explicit click", () => {
    const onPair = vi.fn();
    const tree = render({ onPair });
    expect(onPair).not.toHaveBeenCalled();
    const button = connectButton(tree);
    expect(button?.props.disabled).toBe(false);
    (button?.props.onClick as () => void)();
    expect(onPair).toHaveBeenCalledExactlyOnceWith(snapshot.machines[1]);
  });
  it("does not offer pairing for saved/current machines, missing permission, offline, or identity mismatch", () => {
    expect(connectButton(render({ savedEnvironmentIds: [m1] }))).toBeNull();
    expect(connectButton(render({ canPair: false }))).toBeNull();
    for (const status of ["unreachable", "identity-mismatch"] as const) {
      const tree = render({
        snapshot: { ...snapshot, machines: [{ ...snapshot.machines[1]!, status }] },
      });
      expect(connectButton(tree)?.props.disabled).toBe(true);
    }
    expect(connectButton(render({ pending: "m1" }))).toBeNull();
  });
  it("shows a saved machine's status as this browser sees it, like the picker and sidebar", () => {
    const tree = render({
      savedEnvironmentIds: [m1],
      machineStatuses: {
        [m1]: {
          text: "Can't reach. Retrying automatically",
          connected: false,
          detail: "last seen 2h ago",
        },
      },
    });
    expect(
      visitElements(
        tree,
        (element) => element.props.children === "Can't reach. Retrying automatically",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.includes("last seen 2h ago"),
      ),
    ).not.toBeNull();
    // A machine this browser has not saved still says whether its route answers.
    expect(
      visitElements(render(), (element) => element.props.children === "Reachable"),
    ).not.toBeNull();
  });
  it("offers automatic connection on by default and saves the switch as a device setting", () => {
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect(wrapper.props.autoConnect).toBe(true);
    const toggle = autoConnectSwitch(StudioFleetRoster(wrapper.props));
    expect(toggle?.props.checked).toBe(true);
    (toggle?.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(runtime.updateSettings).toHaveBeenCalledExactlyOnceWith({
      autoConnectPrivateMachines: false,
    });
    runtime.autoConnect = false;
    hooks.beginRender();
    const off = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect(autoConnectSwitch(StudioFleetRoster(off.props))?.props.checked).toBe(false);
  });
  it("hides the automatic switch when this server lists no private machines", () => {
    const tree = render({
      snapshot: { ...snapshot, machines: [] },
      autoConnect: true,
      onAutoConnectChange: vi.fn(),
    });
    expect(autoConnectSwitch(tree)).toBeNull();
  });
  it("does not misrepresent loopback as having no remote access or expose a disabled network toggle", () => {
    const row = StudioListenerRow({ policy: "loopback-browser", desktop: false });
    expect(row.props.description).toContain(
      "Private HTTPS and SSH tunnels can still provide remote access",
    );
    expect(row.props.control).toBeUndefined();
  });
});

describe("adding a machine", () => {
  beforeEach(() => {
    hooks.reset();
    runtime.snapshot = snapshot;
    runtime.addMachine.mockReset();
    runtime.environments = [];
  });
  const addForm = (tree: unknown) =>
    visitElements(tree, (element) => element.type === "form") as {
      props: { onSubmit: (event: { preventDefault: () => void }) => void };
    } | null;
  it("sends the pasted line, then forgets it and says what happens next", async () => {
    runtime.addMachine.mockResolvedValue({
      id: "m1",
      label: "Mac M1",
      url: "https://m1.tailnet.ts.net",
      environmentId: m1,
      change: "updated",
      previousUrl: "https://fixture.tailnet.ts.net:8443",
    });
    hooks.beginRender();
    const first = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    first.props.onInvitationChange("  swc-machine-synthetic  ");
    hooks.beginRender();
    const typed = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect(typed.props.invitation).toBe("  swc-machine-synthetic  ");
    addForm(StudioFleetRoster(typed.props))!.props.onSubmit({ preventDefault: vi.fn() });
    await vi.waitFor(() =>
      expect(runtime.addMachine).toHaveBeenCalledExactlyOnceWith(m4, "swc-machine-synthetic"),
    );
    await vi.waitFor(() => {
      hooks.beginRender();
      const after = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
      expect(after.props.invitation).toBe("");
      expect(after.props.added).toContain("new address");
    });
  });
  it("offers Connect machine again for a machine saved here only at an address it left", () => {
    runtime.snapshot = {
      ...snapshot,
      machines: [
        snapshot.machines[0]!,
        { ...snapshot.machines[1]!, url: "https://m1.tailnet.ts.net" },
      ],
    };
    runtime.environments = [
      {
        entry: {
          target: {
            _tag: "BearerConnectionTarget",
            environmentId: m1,
            connectionId: "c1",
            label: "M1",
          },
          profile: {
            _tag: "Some",
            value: {
              _tag: "BearerConnectionProfile",
              httpBaseUrl: "https://fixture.tailnet.ts.net:8443/",
            },
          },
        },
      },
    ];
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [m1] });
    expect(wrapper.props.savedEnvironmentIds).toEqual([]);
    expect(connectButton(StudioFleetRoster(wrapper.props))?.props.disabled).toBe(false);
  });
});

describe("workers on private machines", () => {
  const notAllowed = {
    status: "not_allowed" as const,
    access: null,
    expiresAt: null,
    renewable: true,
    problem: null,
  };
  const withWorkers: StudioFleetSnapshot = {
    ...snapshot,
    machines: snapshot.machines.map((machine) => ({ ...machine, workers: notAllowed })),
  };
  const workersRows = (tree: unknown) => {
    const rows: Array<Record<string, unknown>> = [];
    visitElements(tree, (element) => {
      if (element.type === FleetWorkersRow) rows.push(element.props);
      return false;
    });
    return rows;
  };
  const button = (tree: unknown, label: string) =>
    visitElements(tree, (element) => element.props.children === label);
  beforeEach(() => {
    hooks.reset();
    runtime.snapshot = withWorkers;
    runtime.allowWorkers.mockReset();
    runtime.stopWorkers.mockReset();
  });

  it("offers workers only for other machines, through this server", () => {
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    const rows = workersRows(StudioFleetRoster(wrapper.props));
    expect(rows.map((row) => (row.machine as { id: string }).id)).toEqual(["m1"]);
    expect(rows[0]?.canManage).toBe(true);
  });

  it("allows workers with the chosen access ceiling, sending a pasted code once", async () => {
    runtime.allowWorkers.mockResolvedValue({ id: "m1", workers: notAllowed });
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    wrapper.props.onWorkerDraftChange("m1", { access: "auto-accept-edits", pairingCode: " code " });
    hooks.beginRender();
    const next = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    next.props.onWorkers(withWorkers.machines[1], "allow");
    await vi.waitFor(() => expect(runtime.allowWorkers).toHaveBeenCalledOnce());
    expect(runtime.allowWorkers).toHaveBeenCalledWith(m4, {
      id: "m1",
      access: "auto-accept-edits",
      pairingCode: "code",
    });
    await vi.waitFor(() => {
      hooks.beginRender();
      const after = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
      expect(after.props.workerDrafts.m1).toEqual({ access: "auto-accept-edits", pairingCode: "" });
    });
  });

  it("starts the access choice at this server's default, not above it", () => {
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect(wrapper.props.defaultWorkerDraft).toEqual({
      access: "approval-required",
      pairingCode: "",
    });
  });

  it("says when Stop could not end the session on the other machine", async () => {
    runtime.stopWorkers.mockResolvedValue({
      id: "m1",
      workers: notAllowed,
      remoteSessionKept: true,
    });
    hooks.beginRender();
    StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] }).props.onWorkers(
      withWorkers.machines[1],
      "stop",
    );
    await vi.waitFor(() => {
      hooks.beginRender();
      const after = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
      expect(after.props.notice).toContain("until it expires");
      expect(after.props.error).toBeNull();
    });
  });

  it("needs a pasted code before Allow when this server cannot pair there", () => {
    const props = {
      machine: { ...withWorkers.machines[1]!, workers: { ...notAllowed, renewable: false } },
      disabled: false,
      canManage: true,
      draft: { access: "auto" as const, pairingCode: "" },
      onDraftChange: vi.fn(),
      onAction: vi.fn(),
    };
    expect(button(FleetWorkersRow(props), "Allow workers")?.props.disabled).toBe(true);
    const ready = FleetWorkersRow({ ...props, draft: { access: "auto", pairingCode: "code" } });
    const allow = button(ready, "Allow workers")!;
    expect(allow.props.disabled).toBe(false);
    (allow.props.onClick as () => void)();
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith("allow");
  });

  it("offers Stop for allowed workers and nothing without a status", () => {
    const onAction = vi.fn();
    const allowed = FleetWorkersRow({
      machine: {
        ...withWorkers.machines[1]!,
        workers: { ...notAllowed, status: "allowed", access: "auto" },
      },
      disabled: false,
      canManage: true,
      draft: { access: "auto", pairingCode: "" },
      onDraftChange: vi.fn(),
      onAction,
    });
    (button(allowed, "Stop workers")!.props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledExactlyOnceWith("stop");
    expect(
      FleetWorkersRow({
        machine: snapshot.machines[1]!,
        disabled: false,
        canManage: true,
        draft: { access: "auto", pairingCode: "" },
        onDraftChange: vi.fn(),
        onAction,
      }),
    ).toBeNull();
  });
});
describe("inviting this machine from its own roster", () => {
  const label = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(label).join("")
        : node && typeof node === "object" && "props" in node
          ? label((node as { props: { children?: unknown } }).props.children)
          : "";
  const inviteButton = (tree: unknown) =>
    visitElements(
      tree,
      (element) =>
        element.props.onClick !== undefined &&
        ["Invite this machine", "Manage access required"].includes(label(element)),
    ) as { props: { onClick: () => void; disabled?: boolean; children: unknown } } | null;
  it("offers the invitation to an access manager and opens its dialog", () => {
    const onInvite = vi.fn();
    const dialog = { type: "fleet-invite-dialog", props: {}, key: null };
    const tree = render({ canManageWorkers: true, onInvite, inviteDialog: dialog as never });
    const action = inviteButton(tree)!;
    expect(label(action)).toBe("Invite this machine");
    expect(action.props.disabled).toBe(false);
    action.props.onClick();
    expect(onInvite).toHaveBeenCalledOnce();
  });
  it("needs Manage access, like Add a machine and Allow workers", () => {
    const action = inviteButton(render({ canManageWorkers: false, onInvite: vi.fn() }))!;
    expect(label(action)).toBe("Manage access required");
    expect(action.props.disabled).toBe(true);
  });
  it("names the in-app invitation before the command in the Add a machine hint", () => {
    const hint = label(
      render({ onAddMachine: vi.fn(), onInvitationChange: vi.fn(), canManageWorkers: true }),
    );
    expect(hint).toContain("choose Invite this machine under Settings > Connections");
    expect(hint.indexOf("Invite this machine")).toBeLessThan(
      hint.indexOf("specwithcode fleet invite"),
    );
  });
  it("hands the dialog to the roster with this machine's name and permission", () => {
    hooks.reset();
    runtime.snapshot = snapshot;
    runtime.environments = [];
    hooks.beginRender();
    const tree = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    const dialog = tree.props.inviteDialog as {
      props: { environmentId: string; canManage: boolean; open: boolean };
    };
    expect(dialog.props).toMatchObject({ environmentId: m4, canManage: true, open: false });
    (tree.props.onInvite as () => void)();
    hooks.beginRender();
    const opened = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect((opened.props.inviteDialog as { props: { open: boolean } }).props.open).toBe(true);
  });
});
