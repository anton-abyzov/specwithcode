import { Cause } from "effect";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: string }>,
  discovered: new Map<string, { environment: { environmentId: string; label: string } }>(),
  refreshing: false,
  autoConnect: true,
  snapshot: null as unknown,
  register: vi.fn(),
  refresh: vi.fn(),
  skipped: [] as string[],
  declined: [] as string[],
  projects: [] as unknown[],
  discoveryKey: "",
  discoveryValue: null as unknown,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => "m4",
  // One object per change, as the atom gives.
  useRelayEnvironmentDiscovery: () => {
    const key = `${state.refreshing}`;
    if (state.discoveryKey !== key || state.discoveryValue === null) {
      state.discoveryKey = key;
      state.discoveryValue = {
        environments: state.discovered,
        refreshing: state.refreshing,
        error: { _tag: "None" },
        offline: false,
      };
    }
    return state.discoveryValue;
  },
}));
vi.mock("../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { autoConnectPrivateMachines: boolean }) => boolean) =>
    select({ autoConnectPrivateMachines: state.autoConnect }),
}));
vi.mock("../studio/fleet", () => ({ usePrimaryFleetSnapshot: () => state.snapshot }));
vi.mock("../state/relay", () => ({ relayEnvironmentDiscovery: { refresh: "refresh" } }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { register: "register" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "register" ? state.register : state.refresh),
}));
vi.mock("../studio/fleetAutoConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../studio/fleetAutoConnect")>()),
  readSkippedFleetEnvironments: () => new Set(state.skipped),
  setFleetEnvironmentSkipped: vi.fn(),
}));
vi.mock("./connectRoutePlan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectRoutePlan")>()),
  readDeclinedConnectRoutes: () => new Set(state.declined),
  setConnectRouteDeclined: vi.fn(),
}));
vi.mock("../studio/linkedMachines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../studio/linkedMachines")>()),
  linkedMachineIds: () => new Set(state.projects.length > 0 ? ["m5"] : []),
}));

const { GrantedAccountMachines } = await import("./GrantedAccountMachines");
const { onConnectRouteRequest } = await import("./connectRoutePlan");
const { accountAutoConnectStates, requestAccountMachineConnect } =
  await import("../studio/grantedAccountMachines");

/** The M5 after it allowed m4: same account, Connect-only, no shared project, never saved here. */
function m5InFleet() {
  state.snapshot = {
    machines: [
      {
        id: "fleet-m5",
        label: "M5",
        environmentId: "m5",
        url: "https://relay.specwithcode.com/e/m5",
        status: "reachable",
        pairingConfigured: false,
      },
    ],
  };
  state.discovered = new Map([["m5", { environment: { environmentId: "m5", label: "M5" } }]]);
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  // The account list counts as this account's once a refresh has been seen.
  state.refreshing = true;
  await act(async () => {
    renderer = create(<GrantedAccountMachines />);
  });
  state.refreshing = false;
  await act(async () => renderer!.update(<GrantedAccountMachines />));
  return renderer!;
}

beforeEach(() => {
  state.environments = [{ environmentId: "m4" }];
  state.autoConnect = true;
  state.skipped = [];
  state.declined = [];
  state.projects = [];
  state.snapshot = null;
  state.discovered = new Map();
  state.discoveryValue = null;
  // A saved machine joins the catalog, as the real register does.
  state.register
    .mockReset()
    .mockImplementation(async (registration: { target: { environmentId: string } }) => {
      state.environments = [
        ...state.environments,
        { environmentId: registration.target.environmentId },
      ];
      return { _tag: "Success" };
    });
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
});

describe("GrantedAccountMachines", () => {
  it("saves a Connect-only machine that allowed this one, with nothing pressed here", async () => {
    m5InFleet();
    const renderer = await mount();
    expect(state.register).toHaveBeenCalledTimes(1);
    const registration = state.register.mock.calls[0]?.[0] as {
      target: { environmentId: string; label: string };
    };
    expect(registration.target.environmentId).toBe("m5");
    expect(registration.target.label).toBe("M5");
    await act(async () => renderer.unmount());
    expect(accountAutoConnectStates().size).toBe(0);
  });

  it("holds it with the reason when Connect automatically is off, and saves it on Connect", async () => {
    m5InFleet();
    state.autoConnect = false;
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Connect automatically is off.",
    });
    await act(async () => requestAccountMachineConnect(["m5"]));
    expect(state.register).toHaveBeenCalledTimes(1);
    // A press reads no list again: other machine lists stay put.
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("leaves a machine removed here alone until it is connected by hand", async () => {
    m5InFleet();
    state.skipped = ["m5"];
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Removed from this app.",
    });
    await act(async () => renderer.unmount());
  });

  it("publishes the failure reason so the move dialog can offer Connect", async () => {
    m5InFleet();
    state.register.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Relay refused")),
    });
    const renderer = await mount();
    // The failure lands after the register promise settles.
    await act(async () => renderer.update(<GrantedAccountMachines />));
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "failed",
      reason: "Relay refused",
    });
    await act(async () => renderer.unmount());
  });

  it("tries a machine whose save never shows up at most once a minute, three times", async () => {
    m5InFleet();
    // Success, but the catalog never lists it (as some registries do).
    state.register.mockResolvedValue({ _tag: "Success" });
    const renderer = await mount();
    for (let pass = 0; pass < 5; pass += 1)
      await act(async () => renderer.update(<GrantedAccountMachines />));
    expect(state.register).toHaveBeenCalledTimes(1);
    expect(accountAutoConnectStates().get("m5")).toEqual({ phase: "connecting" });
    await act(async () => renderer.unmount());
  });

  it("does nothing for an account machine that never allowed this one", async () => {
    state.snapshot = { machines: [] };
    state.discovered = new Map([["m7", { environment: { environmentId: "m7", label: "M7" } }]]);
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    expect(accountAutoConnectStates().size).toBe(0);
    await act(async () => renderer.unmount());
  });

  it("saves a machine a shared project names even with Connect automatically off", async () => {
    m5InFleet();
    state.autoConnect = false;
    state.projects = [{ id: "shared" }];
    const renderer = await mount();
    expect(state.register).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it("retries a failed machine at once when Connect is pressed", async () => {
    m5InFleet();
    state.register.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Relay refused")),
    });
    const renderer = await mount();
    await act(async () => renderer.update(<GrantedAccountMachines />));
    expect(state.register).toHaveBeenCalledTimes(1);
    await act(async () => requestAccountMachineConnect(["m5"]));
    expect(state.register).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it("keeps what it published while the account list is read again", async () => {
    m5InFleet();
    state.autoConnect = false;
    const renderer = await mount();
    state.refreshing = true;
    state.discovered = new Map();
    await act(async () => renderer.update(<GrantedAccountMachines />));
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Connect automatically is off.",
    });
    state.refreshing = false;
    await act(async () => renderer.unmount());
  });

  it("sends a press for a linked tailnet machine to the reconciler's linked path", async () => {
    m5InFleet();
    (state.snapshot as { machines: Array<{ url: string }> }).machines[0]!.url =
      "https://m5.tail1234.ts.net:3773";
    state.projects = [{ id: "shared" }];
    const heard: string[][] = [];
    const stop = onConnectRouteRequest((ids) => heard.push([...ids]));
    const renderer = await mount();
    await act(async () => requestAccountMachineConnect(["m5"]));
    expect(heard).toEqual([["m5"]]);
    expect(state.register).not.toHaveBeenCalled();
    stop();
    await act(async () => renderer.unmount());
  });

  it("says why a machine is held before the account list is read", async () => {
    m5InFleet();
    state.autoConnect = false;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<GrantedAccountMachines />);
    });
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Connect automatically is off.",
    });
    await act(async () => renderer!.unmount());
  });

  it("reads the account list once when mounted after the sign-in read", async () => {
    m5InFleet();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<GrantedAccountMachines />);
    });
    await act(async () => renderer!.update(<GrantedAccountMachines />));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.register).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });
});
