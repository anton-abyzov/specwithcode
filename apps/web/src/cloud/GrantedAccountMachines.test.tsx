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

/** The component as the reconciler mounts it, with the fleet it reads. */
function Subject() {
  return <GrantedAccountMachines snapshot={state.snapshot as never} />;
}
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
        workers: {
          status: "allowed",
          access: "full-access",
          expiresAt: null,
          renewable: true,
          problem: null,
        },
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
    renderer = create(<Subject />);
  });
  state.refreshing = false;
  await act(async () => renderer!.update(<Subject />));
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
    await act(async () => renderer.update(<Subject />));
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "failed",
      reason: "Could not connect over SpecWithCode Connect.",
      detail: "Relay refused",
    });
    await act(async () => renderer.unmount());
  });

  it("tries a machine whose save never shows up at most once a minute, three times", async () => {
    m5InFleet();
    // Success, but the catalog never lists it (as some registries do).
    state.register.mockResolvedValue({ _tag: "Success" });
    const renderer = await mount();
    for (let pass = 0; pass < 5; pass += 1) await act(async () => renderer.update(<Subject />));
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
    await act(async () => renderer.update(<Subject />));
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
    await act(async () => renderer.update(<Subject />));
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Connect automatically is off.",
    });
    state.refreshing = false;
    await act(async () => renderer.unmount());
  });

  it("saves a linked tailnet machine on Connect itself, keeping the reconciler out", async () => {
    m5InFleet();
    (state.snapshot as { machines: Array<{ url: string }> }).machines[0]!.url =
      "https://m5.tail1234.ts.net:3773";
    state.projects = [{ id: "shared" }];
    const heard: string[][] = [];
    const stop = onConnectRouteRequest((ids) => heard.push([...ids]));
    const renderer = await mount();
    await act(async () => requestAccountMachineConnect(["m5"]));
    // Saved here, with its state published; no second route is asked for.
    expect(heard).toEqual([]);
    expect(state.register).toHaveBeenCalledTimes(1);
    // Its fleet skip stays, so the Tailscale pairing does not race this route.
    const { setFleetEnvironmentSkipped } = await import("../studio/fleetAutoConnect");
    expect(setFleetEnvironmentSkipped).not.toHaveBeenCalledWith("m5", false);
    stop();
    await act(async () => renderer.unmount());
  });

  it("says why a machine is held before the account list is read", async () => {
    m5InFleet();
    state.autoConnect = false;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Subject />);
    });
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "held",
      reason: "Connect automatically is off.",
    });
    await act(async () => renderer!.unmount());
  });

  it("reads the account list once when mounted after the sign-in read, then saves", async () => {
    m5InFleet();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Subject />);
    });
    await act(async () => renderer!.update(<Subject />));
    // The read ends without this component seeing it run: it still counts.
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.register).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
  });

  it("adds no second route while the reconciler's linked path is adding one", async () => {
    m5InFleet();
    const { setConnectRouteAddInFlight } = await import("../studio/grantedAccountMachines");
    setConnectRouteAddInFlight("m5", true);
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    expect(accountAutoConnectStates().get("m5")).toEqual({ phase: "connecting" });
    setConnectRouteAddInFlight("m5", false);
    await act(async () => renderer.unmount());
  });

  it("tells the caller when nothing listens, so Settings pairs instead", () => {
    expect(requestAccountMachineConnect(["m5"])).toBe(false);
  });

  it("reads the list for a granted machine it does not show, mounted after the sign-in read", async () => {
    m5InFleet();
    state.discovered = new Map();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Subject />);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
  });

  it("reads no list for machines it would only hold", async () => {
    m5InFleet();
    state.autoConnect = false;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Subject />);
    });
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });

  it("acts once the reconciler's add for the machine ends without saving it", async () => {
    m5InFleet();
    const { setConnectRouteAddInFlight } = await import("../studio/grantedAccountMachines");
    setConnectRouteAddInFlight("m5", true);
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    await act(async () => setConnectRouteAddInFlight("m5", false));
    expect(state.register).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it("does not take a press for a machine outside this app's fleet", async () => {
    state.snapshot = { machines: [] };
    const renderer = await mount();
    let taken = true;
    await act(async () => {
      taken = requestAccountMachineConnect(["m9"]);
    });
    expect(taken).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("saves nothing for a machine whose grant here was revoked", async () => {
    m5InFleet();
    (state.snapshot as { machines: Array<Record<string, unknown>> }).machines[0]!.workers = {
      status: "revoked",
      access: null,
      expiresAt: null,
      renewable: false,
      problem: null,
    };
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    expect(accountAutoConnectStates().size).toBe(0);
    await act(async () => renderer.unmount());
  });

  it("holds an earlier press to a later removal once its try has run", async () => {
    m5InFleet();
    state.register.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Relay refused")),
    });
    const renderer = await mount();
    await act(async () => renderer.update(<Subject />));
    await act(async () => requestAccountMachineConnect(["m5"]));
    await act(async () => renderer.update(<Subject />));
    expect(state.register).toHaveBeenCalledTimes(2);
    state.skipped = ["m5"];
    state.autoConnect = false;
    for (let pass = 0; pass < 3; pass += 1) await act(async () => renderer.update(<Subject />));
    expect(state.register).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it("saves an account machine outside this fleet when Connect is pressed for it", async () => {
    state.snapshot = { machines: [] };
    state.discovered = new Map([["m6", { environment: { environmentId: "m6", label: "M6" } }]]);
    const renderer = await mount();
    expect(state.register).not.toHaveBeenCalled();
    let taken = false;
    await act(async () => {
      taken = requestAccountMachineConnect(["m6"]);
    });
    expect(taken).toBe(true);
    expect(state.register).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
