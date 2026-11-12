import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { visitElements } from "../../test/reactElementTree";
import { fleetInviteCommand } from "../../studio/fleetWorkers";
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
  removeMachine: vi.fn(),
  confirm: vi.fn(),
  environments: [] as Array<{ readonly entry: unknown }>,
  removeSupported: true,
  closeTerminal: vi.fn(),
  nicknames: {} as Record<string, string>,
  cloud: true,
  canAddDeviceWithCode: true,
  deviceCodeAskedFor: [] as Array<string | null>,
}));
vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => runtime.cloud,
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (id: string, label?: string | null) =>
    runtime.nicknames[id] ?? label ?? "",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("../../studio/fleet", () => ({
  addStudioFleetMachine: runtime.addMachine,
  removeStudioFleetMachine: runtime.removeMachine,
  pairStudioFleet: runtime.pair,
  allowStudioFleetWorkers: runtime.allowWorkers,
  stopStudioFleetWorkers: runtime.stopWorkers,
  useFleetRemoveSupported: () => runtime.removeSupported,
  useStudioFleet: () => ({
    snapshot: runtime.snapshot,
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: runtime.confirm }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./AddDeviceWithCodeRow", () => ({
  ADD_DEVICE_WITH_CODE_ROW_ID: "private-machines-device-code",
  AddDeviceWithCodeRow: function AddDeviceWithCodeRow() {
    return null;
  },
  useCanAddDeviceWithCode: (environmentId: string | null) => {
    runtime.deviceCodeAskedFor.push(environmentId);
    return runtime.canAddDeviceWithCode;
  },
}));
vi.mock("./MachineReadinessChecklist", () => ({ MachineReadinessChecklist: () => null }));
vi.mock("./ProvisionMachineSheet", () => ({ ProvisionMachineButton: () => null }));
vi.mock("./MachineTerminal", () => ({
  MachineTerminalButton: function MachineTerminalButton() {
    return null;
  },
  MachineTerminal: function MachineTerminal() {
    return null;
  },
  useCloseMachineTerminal: () => runtime.closeTerminal,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: runtime.environments }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { autoConnectPrivateMachines: boolean }) => unknown) =>
    select({ autoConnectPrivateMachines: runtime.autoConnect }),
  useUpdateClientSettings: () => runtime.updateSettings,
}));
vi.mock("../../lib/machineLastSeen", () => ({
  machineLastSeenAt: () => null,
  useMachineLastSeenVersion: () => 0,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => runtime.connect }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../studio/machineHandoff", () => ({ machineHandoff: { sentSecrets: {} } }));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null, SettingsSection: () => null }));
import { MachineTerminal, MachineTerminalButton } from "./MachineTerminal";
import { SettingHelp } from "./SettingHelp";
import { ConnectDeregisterHint, ConnectDeregisterHintView } from "./ConnectDeregisterHint";
import { OtherAccountJoinFold } from "./OtherAccountJoinFold";
import {
  type FleetMachineCardExtras,
  FleetWorkersRow,
  fleetConnectionReason,
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
describe("why a saved machine can't be reached", () => {
  const raw = (url: string) =>
    `Failed to fetch environment endpoint ${url}/.well-known/studio/environment (HttpClientError: Transport error (GET ${url}/.well-known/studio/environment)).`;
  const m3 = {
    id: "m3",
    environmentId: EnvironmentId.make("env-m3"),
    label: "Mac M3",
    url: "https://m3.tailnet.ts.net",
    connectUrl: "https://prod-m3.example.com",
  };
  const machines = [...snapshot.machines, m3];
  it("names an old relay port on another machine instead of the raw HTTP error", () => {
    expect(
      fleetConnectionReason(raw("https://fixture.tailnet.ts.net:8444"), m3.environmentId, machines),
    ).toBe("No answer from port 8444 on Mac M4 (fixture.tailnet.ts.net:8444).");
  });
  it("names a relay port even when it is the address the fleet lists for the machine", () => {
    expect(
      fleetConnectionReason(raw("https://fixture.tailnet.ts.net:8443"), m1, snapshot.machines),
    ).toBe("No answer from port 8443 on Mac M4 (fixture.tailnet.ts.net:8443).");
  });
  it("names the machine's own Tailscale and Connect addresses", () => {
    expect(fleetConnectionReason(raw(m3.url), m3.environmentId, machines)).toBe(
      "No answer from its Tailscale address (m3.tailnet.ts.net).",
    );
    expect(fleetConnectionReason(raw(m3.connectUrl), m3.environmentId, machines)).toBe(
      "No answer from its SpecWithCode Connect address (prod-m3.example.com).",
    );
  });
  it("leaves other reasons as they are", () => {
    expect(fleetConnectionReason("Approve this device again.", m3.environmentId, machines)).toBe(
      "Approve this device again.",
    );
  });
});
describe("private machine address", () => {
  it("names the relay for a machine reached through another machine's private name", () => {
    expect(fleetMachineAddress(snapshot.machines[1]!, snapshot.machines)).toBe(
      "Through Mac M4, port 8443",
    );
    expect(fleetMachineAddress(snapshot.machines[0]!, snapshot.machines)).toBe(
      "fixture.tailnet.ts.net",
    );
  });
  it("shows the SpecWithCode Connect host when that is the address that answered", () => {
    const viaConnect = {
      id: "m2",
      label: "Mac M2",
      url: "https://m2.tailnet.ts.net",
      connectUrl: "https://prod-0123456789abcdef.spec-weave.com",
      transport: "connect" as const,
    };
    expect(fleetMachineAddress(viaConnect, [viaConnect])).toBe(
      "prod-0123456789abcdef.spec-weave.com",
    );
    expect(fleetMachineAddress({ ...viaConnect, transport: "tailnet" }, [viaConnect])).toBe(
      "m2.tailnet.ts.net",
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
    runtime.removeMachine.mockReset();
    runtime.confirm.mockReset();
    runtime.environments = [];
    runtime.autoConnect = true;
    runtime.removeSupported = true;
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
  it("offers Remove machine on other machines only, with Manage access", () => {
    const onRemove = vi.fn();
    const removeButton = (tree: unknown) =>
      visitElements(tree, (element) => element.props.children === "Remove machine");
    const tree = render({ onRemove, canManageWorkers: true });
    (removeButton(tree)?.props.onClick as () => void)();
    // M4 is this machine: only M1 can be removed.
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(snapshot.machines[1]);
    expect(removeButton(render({ onRemove, canManageWorkers: false }))).toBeNull();
    expect(removeButton(render({ canManageWorkers: true }))).toBeNull();
  });
  it("hands a composed card Remove machine for its header and keeps it out of Connection details", () => {
    const onRemove = vi.fn();
    const removeButton = (tree: unknown) =>
      visitElements(tree, (element) => element.props.children === "Remove machine");
    const cards: Array<{ id: string; controls: unknown; card?: FleetMachineCardExtras }> = [];
    render({
      onRemove,
      canManageWorkers: true,
      renderMachine: (id, controls, _workers, card) => {
        cards.push({ id, controls, ...(card ? { card } : {}) });
        return controls;
      },
    });
    const other = cards.find((entry) => entry.id === m1)!;
    // The controls are what the card folds under Connection details.
    expect(removeButton(other.controls)).toBeNull();
    (removeButton(other.card?.actions)?.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(snapshot.machines[1]);
    // A machine that answers gets no warning line, and this machine no Remove at all.
    expect(other.card?.gone).toBeNull();
    const own = cards.find((entry) => entry.id === m4)!;
    expect(own.card?.actions).toBeNull();
    expect(own.card?.gone).toBeNull();
  });
  it("says a machine no longer answers and removes it from that line while it is unreachable", () => {
    const onRemove = vi.fn();
    const gone = {
      ...snapshot,
      machines: [
        snapshot.machines[0]!,
        { ...snapshot.machines[1]!, status: "unreachable" as const },
      ],
    };
    const line = (tree: unknown) =>
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.startsWith("No longer answers."),
      );
    const removeHere = (tree: unknown) =>
      visitElements(tree, (element) => element.props.children === "Remove");
    let card: FleetMachineCardExtras | undefined;
    render({
      snapshot: gone,
      onRemove,
      canManageWorkers: true,
      renderMachine: (id, controls, _workers, extras) => {
        if (id === m1) card = extras;
        return controls;
      },
    });
    expect(line(card?.gone)?.props.children).toBe(
      "No longer answers. If it was wiped or reinstalled, remove it here; a fresh install joins as a new machine.",
    );
    const button = removeHere(card?.gone);
    expect(button?.props.disabled).toBe(false);
    (button?.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(gone.machines[1]);
    // The plain list on Connections says it too, under the machine.
    expect(line(render({ snapshot: gone, onRemove, canManageWorkers: true }))).not.toBeNull();
    // Without Manage access, or on a server that cannot remove, the line is not offered.
    expect(line(render({ snapshot: gone, onRemove, canManageWorkers: false }))).toBeNull();
    expect(line(render({ snapshot: gone, canManageWorkers: true }))).toBeNull();
    // A machine that answers is never called gone.
    expect(line(render({ onRemove, canManageWorkers: true }))).toBeNull();
  });
  it("says before and after a removal that the machine stays on the Connect account", async () => {
    runtime.connect.mockResolvedValue({ _tag: "Success", value: { entries: [] } });
    runtime.confirm.mockResolvedValue(true);
    runtime.removeMachine.mockResolvedValue({
      id: "m1",
      label: "Mac M1",
      managementToken: "revoked",
      workerAccess: "revoked",
      managementSessionId: null,
    });
    const container = () => {
      hooks.beginRender();
      return StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    };
    const hint = (tree: unknown) =>
      visitElements(tree, (element) => element.type === ConnectDeregisterHint);
    const before = container();
    expect(hint(StudioFleetRoster(before.props))).toBeNull();
    before.props.onRemove(snapshot.machines[1]!);
    await vi.waitFor(() => expect(runtime.removeMachine).toHaveBeenCalledExactlyOnceWith(m4, "m1"));
    expect(runtime.confirm.mock.calls[0]![0]).toContain(
      "If Mac M1 is on your SpecWithCode Connect account, it stays registered there until you deregister it: account menu > Manage account > SpecWithCode Connect > Deregister.",
    );
    await vi.waitFor(() => expect(container().props.removedLabel).toBe("Mac M1"));
    expect(hint(StudioFleetRoster(container().props))?.props.label).toBe("Mac M1");
    // The next change takes the notice down, so it never outlives its removal.
    runtime.stopWorkers.mockResolvedValue({ remoteSessionKept: false });
    container().props.onWorkers(snapshot.machines[0]!, "stop");
    await vi.waitFor(() => expect(container().props.removedLabel).toBeNull());
  });
  it("offers the Connect account page after a removal only when it can be opened", () => {
    const open = vi.fn();
    const button = (tree: unknown) =>
      visitElements(
        tree,
        (element) => element.props.children === "Open SpecWithCode Connect settings",
      );
    const signedIn = ConnectDeregisterHintView({ label: "Mac M1", onOpen: open });
    (button(signedIn)?.props.onClick as () => void)();
    expect(open).toHaveBeenCalledOnce();
    expect(
      visitElements(
        signedIn,
        (element) =>
          element.props.children ===
          "If Mac M1 is on your SpecWithCode Connect account, it is still registered there. Deregister it under account menu > Manage account > SpecWithCode Connect.",
      ),
    ).not.toBeNull();
    expect(button(ConnectDeregisterHintView({ label: "Mac M1", onOpen: null }))).toBeNull();
  });
  it("keeps the list working against a server from before 1.0.58 and says only removal needs an update", () => {
    const removeButton = (tree: unknown) =>
      visitElements(tree, (element) => element.props.children === "Remove machine");
    const note = (tree: unknown) =>
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.startsWith("Removing a machine from this list needs"),
      );
    const roster = () => {
      hooks.beginRender();
      return StudioFleetRoster(
        StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] }).props,
      );
    };
    const current = roster();
    expect(removeButton(current)).not.toBeNull();
    expect(note(current)).toBeNull();
    runtime.removeSupported = false;
    const older = roster();
    expect(removeButton(older)).toBeNull();
    expect(note(older)?.props.children).toBe(
      "Removing a machine from this list needs SpecWithCode 1.0.58 or later on this server. Connecting, workers and everything else here work as is.",
    );
    expect(connectButton(older)?.props.disabled).toBe(false);
    expect(
      note(
        render({
          canManageWorkers: false,
          removeUnavailable: "Removing a machine from this list needs x",
        }),
      ),
    ).toBeNull();
  });
  it("does not announce an empty fleet as an empty composed machine inventory", () => {
    const tree = render({
      snapshot: { ...snapshot, machines: [] },
      renderMachine: (_id, controls) => controls,
      additionalMachines: <li>Connected remote machine</li>,
    });
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.includes("No other machines yet"),
      ),
    ).toBeNull();
    expect(
      visitElements(tree, (element) => element.props.children === "Connected remote machine"),
    ).not.toBeNull();
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
  it("offers Approve again for a saved machine whose server turned down this browser", () => {
    const onPair = vi.fn();
    const tree = render({
      onPair,
      rejectedEnvironmentIds: [m1],
      machineStatuses: {
        [m1]: {
          text: "Connection failed",
          connected: false,
          lastSeen: null,
          reason: "Approve this device again in SpecWithCode.",
          retryable: false,
          tone: "error",
        },
      },
    });
    const button = visitElements(tree, (element) => element.props.children === "Approve again");
    expect(button?.props.disabled).toBe(false);
    (button?.props.onClick as () => void)();
    expect(onPair).toHaveBeenCalledExactlyOnceWith(snapshot.machines[1]);
    // Its row says what failed rather than "Reachable".
    expect(
      visitElements(tree, (element) => element.props.children === "Connection failed"),
    ).not.toBeNull();
  });
  it("offers a terminal on each connected machine and opens it in that row", () => {
    const connectedM1 = {
      [m1]: { text: "Connected", connected: true, lastSeen: null, reason: null },
    } as unknown as NonNullable<Parameters<typeof StudioFleetRoster>[0]["machineStatuses"]>;
    const terminalButtons = (tree: unknown) => {
      const found: Array<{ props: Record<string, unknown> }> = [];
      visitElements(tree, (element) => {
        if (element.type === MachineTerminalButton) found.push(element);
        return false;
      });
      return found;
    };
    hooks.reset();
    hooks.beginRender();
    const tree = render({ savedEnvironmentIds: [m1], machineStatuses: connectedM1 });
    // This machine and the connected M1; an unsaved or offline machine gets none.
    expect(terminalButtons(tree).map((button) => button.props.environmentId)).toEqual([m4, m1]);
    expect(terminalButtons(tree)[1]?.props.environmentLabel).toBe("Mac M1");
    expect(visitElements(tree, (element) => element.type === MachineTerminal)).toBeNull();
    hooks.beginRender();
    expect(
      terminalButtons(render({ environmentId: EnvironmentId.make("env-other") })),
    ).toHaveLength(0);

    hooks.reset();
    hooks.beginRender();
    const first = render({ savedEnvironmentIds: [m1], machineStatuses: connectedM1 });
    (terminalButtons(first)[1]?.props.onOpenChange as (open: boolean) => void)(true);
    hooks.beginRender();
    const opened = render({ savedEnvironmentIds: [m1], machineStatuses: connectedM1 });
    expect(
      visitElements(opened, (element) => element.type === MachineTerminal)?.props.environmentId,
    ).toBe(m1);
    expect(terminalButtons(opened)[1]?.props.open).toBe(true);
    expect(runtime.closeTerminal).not.toHaveBeenCalled();
    // Close ends that machine's shell; only an explicit close does.
    (
      visitElements(opened, (element) => element.type === MachineTerminal)?.props
        .onClose as () => void
    )();
    expect(runtime.closeTerminal).toHaveBeenCalledWith(m1);
  });
  it("shows a saved machine's status as this browser sees it, like the picker and sidebar", () => {
    const tree = render({
      savedEnvironmentIds: [m1],
      machineStatuses: {
        [m1]: {
          text: "Connection failed",
          connected: false,
          lastSeen: "last seen 2h ago",
          reason:
            "Approve this device again in SpecWithCode. Create a new pairing code on the receiving machine and sign in again.",
          retryable: true,
          tone: "error",
        },
      },
    });
    expect(
      visitElements(tree, (element) => element.props.children === "Connection failed"),
    ).not.toBeNull();
    expect(
      visitElements(tree, (element) =>
        [element.props.children]
          .flat()
          .some((child) => typeof child === "string" && child.includes("last seen 2h ago")),
      ),
    ).not.toBeNull();
    // The reason and next step sit on their own wrapped line, not in the cut-off meta line.
    const reason = visitElements(
      tree,
      (element) =>
        typeof element.props.reason === "string" &&
        element.props.reason.startsWith("Approve this device again"),
    );
    expect(reason?.props.retryable).toBe(true);
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.includes("Approve this device again"),
      ),
    ).toBeNull();
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
  it("lists a skipped fleet-file line beside the machines that still loaded", () => {
    const reason = "url must be a private https://<name>.ts.net address.";
    const message = (tree: unknown) =>
      visitElements(
        tree,
        (element) =>
          element.props.role === "alert" &&
          Array.isArray(element.props.children) &&
          element.props.children.includes(`Invalid entry in fleet config: ${reason}`),
      );
    const tree = render({
      snapshot: {
        ...snapshot,
        invalidEntries: [{ kind: "config", index: 2, label: "Linux VPS", reason }],
      },
    });
    expect(message(tree)).not.toBeNull();
    expect(visitElements(tree, (element) => element.props.children === "Linux VPS")).not.toBeNull();
    expect(connectButton(tree)).not.toBeNull();
    // Shown even when no machine line parsed.
    expect(
      message(
        render({
          snapshot: {
            ...snapshot,
            machines: [],
            invalidEntries: [{ kind: "config", index: 0, reason }],
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      message(
        render({
          failed: true,
          snapshot: { ...snapshot, invalidEntries: [{ kind: "config", index: 0, reason }] },
        }),
      ),
    ).toBeNull();
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
    runtime.removeMachine.mockReset();
    runtime.confirm.mockReset();
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

  it("starts the access choice at Full access on the owner's own machines", () => {
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    expect(wrapper.props.defaultWorkerDraft).toEqual({ access: "full-access", pairingCode: "" });
    // The roster's own fallback agrees, with no stale "auto".
    const rows = workersRows(
      render({
        snapshot: withWorkers,
        onWorkers: vi.fn(),
        onWorkerDraftChange: vi.fn(),
        canManageWorkers: true,
      }),
    );
    expect((rows[0]?.draft as { access: string }).access).toBe("full-access");
  });

  it("changes an allowed grant's access by allowing again with the new ceiling", async () => {
    const allowed = {
      ...notAllowed,
      status: "allowed" as const,
      access: "approval-required" as const,
    };
    const machine = { ...withWorkers.machines[1]!, workers: allowed };
    runtime.snapshot = { ...withWorkers, machines: [withWorkers.machines[0]!, machine] };
    runtime.allowWorkers.mockResolvedValue({
      id: "m1",
      workers: { ...allowed, access: "full-access" },
    });
    hooks.beginRender();
    const wrapper = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    // The row starts from the access in force, so nothing is offered until it changes.
    const [row] = workersRows(StudioFleetRoster(wrapper.props));
    expect(row?.draft).toEqual({ access: "approval-required", pairingCode: "" });
    expect(button(FleetWorkersRow(row as never), "Change access")).toBeNull();
    wrapper.props.onWorkerDraftChange("m1", { access: "full-access", pairingCode: "" });
    hooks.beginRender();
    const next = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    const [changedRow] = workersRows(StudioFleetRoster(next.props));
    const change = button(FleetWorkersRow(changedRow as never), "Change access")!;
    expect(change.props.disabled).toBe(false);
    (change.props.onClick as () => void)();
    await vi.waitFor(() => expect(runtime.allowWorkers).toHaveBeenCalledOnce());
    expect(runtime.allowWorkers).toHaveBeenCalledWith(m4, { id: "m1", access: "full-access" });
  });

  it("says when workers there run below Full access, and asks for a code to change it when needed", () => {
    const props = {
      machine: {
        ...withWorkers.machines[1]!,
        // No key on that machine, so this server cannot make the code itself.
        pairingConfigured: false,
        workers: {
          ...notAllowed,
          status: "allowed" as const,
          access: "approval-required" as const,
          renewable: false,
        },
      },
      disabled: false,
      canManage: true,
      draft: { access: "approval-required" as const, pairingCode: "" },
      onDraftChange: vi.fn(),
      onAction: vi.fn(),
    };
    const hint = (tree: unknown) =>
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.startsWith("Workers there run at most at"),
      );
    expect(hint(FleetWorkersRow(props))?.props.children).toContain("Supervised");
    const code = (tree: unknown) =>
      visitElements(
        tree,
        (element) => element.props["aria-label"] === "Pairing code made on Mac M1",
      );
    expect(code(FleetWorkersRow(props))).toBeNull();
    const raised = FleetWorkersRow({ ...props, draft: { access: "full-access", pairingCode: "" } });
    expect(code(raised)).not.toBeNull();
    expect(button(raised, "Change access")?.props.disabled).toBe(true);
    // With a key there the change needs nothing pasted.
    const keyed = FleetWorkersRow({
      ...props,
      machine: { ...props.machine, pairingConfigured: true },
      draft: { access: "full-access", pairingCode: "" },
    });
    expect(code(keyed)).toBeNull();
    expect(button(keyed, "Change access")?.props.disabled).toBe(false);
    const full = FleetWorkersRow({
      ...props,
      machine: { ...props.machine, workers: { ...props.machine.workers, access: "full-access" } },
      draft: { access: "full-access", pairingCode: "" },
    });
    expect(hint(full)).toBeNull();
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

  it("allows without a code on a machine added by a join line", () => {
    // The join line left a key there, but the grant does not renew by itself.
    const props = {
      machine: { ...withWorkers.machines[1]!, workers: { ...notAllowed, renewable: false } },
      disabled: false,
      canManage: true,
      draft: { access: "full-access" as const, pairingCode: "" },
      onDraftChange: vi.fn(),
      onAction: vi.fn(),
    };
    expect(props.machine.pairingConfigured).toBe(true);
    const row = FleetWorkersRow(props);
    expect(
      visitElements(
        row,
        (element) => element.props["aria-label"] === "Pairing code made on Mac M1",
      ),
    ).toBeNull();
    const allow = button(row, "Allow workers")!;
    expect(allow.props.disabled).toBe(false);
    (allow.props.onClick as () => void)();
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith("allow");
    // Once that machine refused the code this server made, a code can be pasted.
    const refused = FleetWorkersRow({
      ...props,
      machine: {
        ...props.machine,
        workers: { ...props.machine.workers, problem: "pairing_unavailable" as const },
      },
    });
    const field = visitElements(
      refused,
      (element) => element.props["aria-label"] === "Pairing code made on Mac M1",
    );
    expect(field?.props.placeholder).toBe("Code made on Mac M1 for this machine");
    expect(button(refused, "Allow workers")?.props.disabled).toBe(true);
  });

  it("needs a pasted code before Allow when this server cannot pair there", () => {
    const props = {
      machine: {
        ...withWorkers.machines[1]!,
        pairingConfigured: false,
        workers: { ...notAllowed, renewable: false },
      },
      disabled: false,
      canManage: true,
      draft: { access: "auto" as const, pairingCode: "" },
      onDraftChange: vi.fn(),
      onAction: vi.fn(),
    };
    expect(button(FleetWorkersRow(props), "Allow workers")?.props.disabled).toBe(true);
    const helpLabels: unknown[] = [];
    visitElements(FleetWorkersRow(props), (element) => {
      if (element.type === SettingHelp) helpLabels.push(element.props.label);
      return false;
    });
    expect(helpLabels).toEqual(["workers", "the most access a worker gets"]);
    const ready = FleetWorkersRow({ ...props, draft: { access: "auto", pairingCode: "code" } });
    const allow = button(ready, "Allow workers")!;
    expect(allow.props.disabled).toBe(false);
    (allow.props.onClick as () => void)();
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith("allow");
  });

  it("offers Stop in the row menu for allowed workers and nothing without a status", () => {
    const onWorkers = vi.fn();
    const allowedSnapshot = {
      ...withWorkers,
      machines: [
        withWorkers.machines[0]!,
        {
          ...withWorkers.machines[1]!,
          workers: { ...notAllowed, status: "allowed" as const, access: "auto" as const },
        },
      ],
    };
    const stop = (tree: unknown) =>
      visitElements(tree, (element) => element.props.children === "Stop workers");
    const tree = render({
      snapshot: allowedSnapshot,
      onWorkers,
      onWorkerDraftChange: vi.fn(),
      canManageWorkers: true,
    });
    (stop(tree)!.props.onClick as () => void)();
    expect(onWorkers).toHaveBeenCalledExactlyOnceWith(allowedSnapshot.machines[1], "stop");
    expect(stop(render({ onWorkers, onWorkerDraftChange: vi.fn() }))).toBeNull();
    expect(
      FleetWorkersRow({
        machine: snapshot.machines[1]!,
        disabled: false,
        canManage: true,
        draft: { access: "auto", pairingCode: "" },
        onDraftChange: vi.fn(),
        onAction: onWorkers,
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
        ["Make a join line", "Manage access required"].includes(label(element)),
    ) as { props: { onClick: () => void; disabled?: boolean; children: unknown } } | null;
  it("offers the invitation to an access manager and opens its dialog", () => {
    const onInvite = vi.fn();
    const dialog = { type: "fleet-invite-dialog", props: {}, key: null };
    const tree = render({ canManageWorkers: true, onInvite, inviteDialog: dialog as never });
    const action = inviteButton(tree)!;
    expect(label(action)).toBe("Make a join line");
    expect(action.props.disabled).toBe(false);
    action.props.onClick();
    expect(onInvite).toHaveBeenCalledOnce();
  });
  it("needs Manage access, like Add a machine and Allow workers", () => {
    const action = inviteButton(render({ canManageWorkers: false, onInvite: vi.fn() }))!;
    expect(label(action)).toBe("Manage access required");
    expect(action.props.disabled).toBe(true);
  });
  it("asks for SpecWithCode Connect before making the line", () => {
    const tree = label(render({ canManageWorkers: true, onInvite: vi.fn() }));
    expect(tree).toContain("Link SpecWithCode Connect here first");
    expect(tree).not.toContain("Tailscale");
  });
  it("says which address reached a machine, and when a bearer-only line needs renewing", () => {
    const viaConnect: StudioFleetSnapshot = {
      ...snapshot,
      machines: [
        {
          ...snapshot.machines[1]!,
          url: "https://m1.tailnet.ts.net",
          connectUrl: "https://prod-0123456789abcdef.spec-weave.com",
          transport: "connect",
          managementBinding: "bearer",
        },
      ],
    };
    const text = label(render({ snapshot: viaConnect }));
    expect(text).toContain("via SpecWithCode Connect");
    expect(text).toContain(
      "On that machine, choose Join a main machine again and add the new line here to use SpecWithCode Connect.",
    );
    const bound = label(
      render({
        snapshot: {
          ...viaConnect,
          machines: [{ ...viaConnect.machines[0]!, managementBinding: "proof" }],
        },
      }),
    );
    expect(bound).toContain("via SpecWithCode Connect");
    expect(bound).not.toContain("Join a main machine again");
    expect(label(render())).toContain("Reachable");
  });
  it("puts SpecWithCode Connect first in the Add a machine steps, with this machine's id", () => {
    const tree = render({
      onAddMachine: vi.fn(),
      onInvitationChange: vi.fn(),
      canManageWorkers: true,
    });
    const hint = label(tree);
    expect(hint).toContain("Open Settings > Machines > SpecWithCode Connect there");
    expect(
      visitElements(tree, (element) => element.props.value === fleetInviteCommand(m4)),
    ).not.toBeNull();
    expect(hint).toContain("This machine does not need to be signed in");
    expect(hint).toContain("choose Join a main machine under Settings > Machines");
    expect(hint).not.toContain("no line needed");
    expect(hint).not.toContain("<main-machine-environment-id>");
    expect(hint).not.toContain("Tailscale");
    expect(hint.indexOf("SpecWithCode Connect")).toBeLessThan(hint.indexOf("Join a main machine"));
  });
  describe("folded under Another account, or no Connect", () => {
    const fold = (tree: unknown) =>
      visitElements(tree, (element) => element.type === OtherAccountJoinFold) as {
        props: { openFor: boolean; targetIds: ReadonlyArray<string>; children: unknown };
      } | null;
    const both = {
      onAddMachine: vi.fn(),
      onInvitationChange: vi.fn(),
      onInvite: vi.fn(),
      canManageWorkers: true,
    };
    it("keeps the join line and the code steps, closed, inside one section", () => {
      const section = fold(render(both))!;
      expect(section.props.openFor).toBe(false);
      // Nothing is removed: both are still there, only inside the fold.
      const inside = label(section.props.children);
      expect(inside).toContain("Add a machine");
      expect(inside).toContain("It works once, within an hour.");
      expect(inside).toContain("Join a main machine");
      expect(inviteButton(section.props.children)).not.toBeNull();
      // Settings search can still jump to either one, which opens the section.
      expect(section.props.targetIds).toEqual(["private-machines-add", "private-machines-invite"]);
      const outside = label(render(both)).replace(inside, "");
      expect(outside).not.toContain("Make a join line");
      expect(outside).not.toContain("It works once, within an hour.");
    });
    it("opens for a typed join line, a running add and the open join dialog", () => {
      expect(fold(render({ ...both, invitation: "swc-machine-abc" }))!.props.openFor).toBe(true);
      expect(fold(render({ ...both, invitation: "   " }))!.props.openFor).toBe(false);
      expect(fold(render({ ...both, pending: "add-machine" }))!.props.openFor).toBe(true);
      expect(fold(render({ ...both, pending: "m1" }))!.props.openFor).toBe(false);
      expect(fold(render({ ...both, inviteOpen: true }))!.props.openFor).toBe(true);
    });
    it("stays open in a build without SpecWithCode Connect, where it is the only way to join", () => {
      runtime.cloud = false;
      try {
        expect(fold(render(both))!.props.openFor).toBe(true);
      } finally {
        runtime.cloud = true;
      }
    });
    it("is left out where neither path is offered", () => {
      expect(fold(render())).toBeNull();
      expect(fold(render({ onInvite: vi.fn() }))).not.toBeNull();
    });
    it("holds the code path as the third way in, also where it is the only one offered", () => {
      const row = <p>Add a device with a code</p>;
      const inside = label(fold(render({ ...both, deviceCodeRow: row }))!.props.children);
      expect(inside).toContain("Add a device with a code");
      // After the join line and the join code: Connect first, the code path last.
      expect(inside.indexOf("Join a main machine")).toBeLessThan(
        inside.indexOf("Add a device with a code"),
      );
      const alone = fold(render({ deviceCodeRow: row }))!;
      expect(label(alone.props.children)).toBe("Add a device with a code");
      expect(alone.props.openFor).toBe(false);
      // A link to the row opens the fold around it, like the two rows above it.
      expect(alone.props.targetIds).toContain("private-machines-device-code");
      const outside = label(render({ ...both, deviceCodeRow: row })).replace(inside, "");
      expect(outside).not.toContain("Add a device with a code");
    });
    it("gets the code row only where this window may offer it, asked about the viewed machine", () => {
      const row = () => {
        hooks.reset();
        runtime.snapshot = snapshot;
        runtime.environments = [];
        runtime.deviceCodeAskedFor = [];
        hooks.beginRender();
        return StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] }).props
          .deviceCodeRow as { type: { name: string } } | null;
      };
      try {
        expect(row()?.type.name).toBe("AddDeviceWithCodeRow");
        expect(runtime.deviceCodeAskedFor).toEqual([m4]);
        runtime.canAddDeviceWithCode = false;
        expect(row()).toBeNull();
      } finally {
        runtime.canAddDeviceWithCode = true;
      }
    });
    it("is told when Make a join line opened its dialog", () => {
      hooks.reset();
      runtime.snapshot = snapshot;
      runtime.environments = [];
      hooks.beginRender();
      const tree = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
      expect(tree.props.inviteOpen).toBe(false);
      (tree.props.onInvite as () => void)();
      hooks.beginRender();
      expect(
        StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] }).props.inviteOpen,
      ).toBe(true);
    });
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
  it("tells the join dialog which machines agents here may start work on, by nickname", () => {
    const workers = (status: "allowed" | "expired") => ({
      status,
      access: null,
      expiresAt: null,
      renewable: true,
      problem: null,
    });
    hooks.reset();
    runtime.snapshot = {
      ...snapshot,
      machines: [
        { ...snapshot.machines[0]!, workers: workers("allowed") },
        { ...snapshot.machines[1]!, workers: workers("allowed") },
        {
          ...snapshot.machines[1]!,
          id: "m3",
          environmentId: EnvironmentId.make("env-m3"),
          label: "Mac M3",
          workers: workers("expired"),
        },
      ],
    };
    runtime.environments = [];
    runtime.nicknames = { "env-m1": "Studio Mac" };
    hooks.beginRender();
    const tree = StudioFleetConnections({ environmentId: m4, savedEnvironmentIds: [] });
    runtime.nicknames = {};
    const dialog = tree.props.inviteDialog as { props: { managedMachines: string[] } };
    // Not this machine, not the expired grant, and the name the person gave it.
    expect(dialog.props.managedMachines).toEqual(["Studio Mac"]);
  });
});
