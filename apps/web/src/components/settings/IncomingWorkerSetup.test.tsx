import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
} from "@specweave-studio/contracts";
import type {
  StudioFleetAddResult,
  StudioFleetWorkersResult,
} from "@specweave-studio/contracts/studioFleet";
vi.mock("../../studio/fleet", () => ({
  addVisibleMachineToStudioFleet: vi.fn(),
  allowIncomingStudioFleetWorkers: vi.fn(),
  allowStudioFleetWorkers: vi.fn(),
  joinAccountMachineForWorkers: vi.fn(),
  readStudioFleetMachines: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: vi.fn(),
  useRelayEnvironmentDiscovery: vi.fn(),
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { register: "register" } }));
vi.mock("../../state/relay", () => ({ relayEnvironmentDiscovery: { refresh: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("../../studio/machineNickname", () => ({ useMachineNicknames: vi.fn() }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: true }));
import * as Cause from "effect/Cause";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  addVisibleMachineToStudioFleet,
  allowIncomingStudioFleetWorkers,
  allowStudioFleetWorkers,
  joinAccountMachineForWorkers,
  readStudioFleetMachines,
} from "../../studio/fleet";
import {
  accountMachinesToOffer,
  IncomingWorkerAction,
  IncomingWorkerSaved,
  IncomingWorkerSetup,
  setUpIncomingWorkers,
} from "./IncomingWorkerSetup";
const here = EnvironmentId.make("m4");
const coordinator = EnvironmentId.make("m1");
const input = { here, coordinator, hereLabel: "M4", access: "full-access" as const };
const added = { id: "m4", environmentId: here } as StudioFleetAddResult;
const allowed = {
  id: "m4",
  workers: {
    status: "allowed",
    access: "full-access",
    expiresAt: null,
    renewable: true,
    problem: null,
  },
} as StudioFleetWorkersResult;
function operations() {
  return {
    add: vi.fn().mockResolvedValue(added),
    allow: vi.fn().mockResolvedValue(allowed),
    read: vi.fn().mockResolvedValue([]),
  };
}
describe("incoming worker setup", () => {
  it("adds this destination on the selected coordinator and grants that direction", async () => {
    const ops = operations();
    await setUpIncomingWorkers(input, ops);
    expect(ops.add).toHaveBeenCalledExactlyOnceWith(coordinator, here, "M4");
    expect(ops.allow).toHaveBeenCalledExactlyOnceWith(coordinator, {
      id: "m4",
      access: "full-access",
    });
  });
  it("preserves the user's selected access", async () => {
    const ops = operations();
    await setUpIncomingWorkers({ ...input, access: "approval-required" }, ops);
    expect(ops.allow).toHaveBeenCalledWith(coordinator, { id: "m4", access: "approval-required" });
  });
  it("does not grant after an authentication or invitation failure", async () => {
    const ops = operations();
    ops.add.mockRejectedValue(new Error("Manage access required"));
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow("Manage access required");
    expect(ops.allow).not.toHaveBeenCalled();
  });
  it("explains a management key may remain when adding fails after redemption", async () => {
    const ops = operations();
    ops.add.mockRejectedValue(new Error("Could not save machine configuration"));
    const failure = await setUpIncomingWorkers(input, ops).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "A management key may already have been issued on M4",
    );
    expect((failure as Error).message).toContain("Settings > Machines > Authorized clients on M4");
    expect((failure as Error).message).toContain("Could not save machine configuration");
    expect(ops.allow).not.toHaveBeenCalled();
  });
  it("refuses a destination identity mismatch", async () => {
    const ops = operations();
    ops.add.mockResolvedValue({ ...added, environmentId: coordinator });
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow("identity did not match");
    expect(ops.allow).not.toHaveBeenCalled();
  });
  it("reports partial setup if granting fails", async () => {
    const ops = operations();
    ops.allow.mockRejectedValue(new Error("Revoked on M4"));
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow(
      "is listed on that machine, but worker access was not confirmed",
    );
  });
  it("does not issue another key when the machine is already listed", async () => {
    const ops = operations();
    ops.read.mockResolvedValue([
      { id: "m4-line", environmentId: here, status: "reachable", pairingConfigured: true },
    ]);
    await setUpIncomingWorkers(input, ops);
    expect(ops.add).not.toHaveBeenCalled();
    expect(ops.allow).toHaveBeenCalledExactlyOnceWith(coordinator, {
      id: "m4-line",
      access: "full-access",
    });
  });
  it("retries a failed grant without a second key", async () => {
    const ops = operations();
    ops.allow.mockRejectedValueOnce(new Error("offline"));
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow("not confirmed");
    ops.read.mockResolvedValue([
      { id: "m4", environmentId: here, status: "reachable", pairingConfigured: true },
    ]);
    await setUpIncomingWorkers(input, ops);
    expect(ops.add).toHaveBeenCalledTimes(1);
    expect(ops.allow).toHaveBeenCalledTimes(2);
  });
  it("changes nothing when the machine list cannot be read", async () => {
    const ops = operations();
    ops.read.mockRejectedValue(new Error("down"));
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow("nothing was changed");
    expect(ops.add).not.toHaveBeenCalled();
    expect(ops.allow).not.toHaveBeenCalled();
  });
  it("refuses an already listed machine that answers as another", async () => {
    const ops = operations();
    ops.read.mockResolvedValue([{ id: "m4", environmentId: here, status: "identity-mismatch" }]);
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow("different machine");
    expect(ops.add).not.toHaveBeenCalled();
    expect(ops.allow).not.toHaveBeenCalled();
  });
  it("does not replace a freshly issued key on a quick second retry", async () => {
    const stale = {
      id: "m4-stale",
      environmentId: here,
      status: "reachable",
      pairingConfigured: true,
      workers: { ...allowed.workers, status: "not_allowed", problem: "pairing_unavailable" },
    };
    const other = EnvironmentId.make("m2");
    const ops = operations();
    ops.read.mockResolvedValue([stale]);
    ops.allow.mockRejectedValueOnce(new Error("rate limited"));
    await expect(setUpIncomingWorkers({ ...input, coordinator: other }, ops)).rejects.toThrow();
    await setUpIncomingWorkers({ ...input, coordinator: other }, ops);
    expect(ops.add).toHaveBeenCalledTimes(1);
    expect(ops.allow).toHaveBeenCalledTimes(2);
  });
  it("adds again when the listed line cannot mint a grant", async () => {
    const rows = [
      { coordinator: EnvironmentId.make("m5"), pairingConfigured: false },
      {
        coordinator: EnvironmentId.make("m6"),
        pairingConfigured: true,
        workers: { ...allowed.workers, status: "not_allowed", problem: "pairing_unavailable" },
      },
    ];
    for (const { coordinator, ...row } of rows) {
      const input = { here, coordinator, hereLabel: "M4", access: "full-access" as const };
      const ops = operations();
      ops.read.mockResolvedValue([
        { id: "m4-old", environmentId: here, status: "reachable", ...row },
      ]);
      await setUpIncomingWorkers(input, ops);
      expect(ops.add).toHaveBeenCalledExactlyOnceWith(coordinator, here, "M4");
      expect(ops.allow).toHaveBeenCalledExactlyOnceWith(coordinator, {
        id: "m4",
        access: "full-access",
      });
    }
  });
  it("does not report success for an unconfirmed grant", async () => {
    const ops = operations();
    ops.allow.mockResolvedValue({
      ...allowed,
      workers: { ...allowed.workers, status: "not_allowed" },
    });
    await expect(setUpIncomingWorkers(input, ops)).rejects.toThrow(
      "Worker access was not confirmed",
    );
  });
  it("refuses a self grant without issuing a credential", async () => {
    const ops = operations();
    await expect(setUpIncomingWorkers({ ...input, coordinator: here }, ops)).rejects.toThrow(
      "Choose another machine",
    );
    expect(ops.add).not.toHaveBeenCalled();
  });
});

describe("the account's machines the card offers", () => {
  const record = (id: string) => ({ environmentId: EnvironmentId.make(id), label: id });
  it("lists machines this app has not opened, never this one or one already known", () => {
    expect(
      accountMachinesToOffer({
        discovered: [record("m4"), record("m1"), record("m3"), record("m5")],
        here,
        known: [coordinator, EnvironmentId.make("m3")],
      }),
    ).toEqual([record("m5")]);
  });
  it("offers nothing when the account has no other machine", () => {
    expect(accountMachinesToOffer({ discovered: [record("m4")], here, known: [] })).toEqual([]);
  });
});
describe("choosing a machine of the account on the card", () => {
  const m5 = EnvironmentId.make("m5");
  async function card(open: ReturnType<typeof vi.fn>) {
    vi.mocked(useEnvironments).mockReturnValue({
      environments: [{ environmentId: here, label: "M4", connection: { phase: "connected" } }],
    } as never);
    vi.mocked(useRelayEnvironmentDiscovery).mockReturnValue({
      environments: new Map([[m5, { environment: { environmentId: m5, label: "M5" } }]]),
      refreshing: false,
      offline: false,
    } as never);
    vi.mocked(useMachineNicknames).mockReturnValue(
      ((_id: string, label?: string | null) => label ?? "") as never,
    );
    const refresh = vi.fn(async () => ({ _tag: "Success" }));
    vi.mocked(useAtomCommand).mockImplementation(((command: unknown) =>
      command === "register" ? open : refresh) as never);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <IncomingWorkerSetup
          environmentId={here}
          snapshot={{ grants: [], projects: [], accounts: [] } as never}
          onGranted={vi.fn()}
        />,
      );
    });
    const select = () => renderer!.root.findByProps({ "aria-label": "Machine sending work" });
    return { renderer: renderer!, select, refresh };
  }
  it("lists the account's machine and opens it through Connect when chosen", async () => {
    const open = vi.fn(async () => ({ _tag: "Success" }));
    const view = await card(open);
    expect(view.refresh).toHaveBeenCalled();
    expect(
      view
        .select()
        .findAllByType("option")
        .map((option) => option.props.value),
    ).toEqual(["", "m5"]);
    await act(async () => view.select().props.onChange({ target: { value: "m5" } }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: expect.objectContaining({ environmentId: m5, label: "M5" }),
      }),
    );
    expect(view.select().props.value).toBe("m5");
    expect(view.renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    await act(async () => view.renderer.unmount());
  });
  it("goes back to no choice when the machine cannot be opened, so it can be chosen again", async () => {
    const open = vi.fn(async () => ({ _tag: "Failure", cause: Cause.fail("offline") }));
    const view = await card(open);
    await act(async () => view.select().props.onChange({ target: { value: "m5" } }));
    expect(view.select().props.value).toBe("");
    expect(view.renderer.root.findByProps({ role: "alert" }).props.children).toContain(
      "Could not open M5 through SpecWithCode Connect",
    );
    await act(async () => view.select().props.onChange({ target: { value: "m5" } }));
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => view.renderer.unmount());
  });
});
describe("incoming worker setup view", () => {
  const action = (connected = true, coordinatorFleetId?: string, accountJoin?: boolean) =>
    renderToStaticMarkup(
      <IncomingWorkerAction
        here={here}
        coordinator={coordinator}
        hereLabel="m4"
        coordinatorLabel="m1"
        connected={connected}
        coordinatorFleetId={coordinatorFleetId}
        accountJoin={accountJoin}
        onGranted={vi.fn()}
      />,
    );
  /** This app manages access here and holds only a SpecWithCode Connect sign-in on m1. */
  const connectSignInThere = (environmentId: EnvironmentId, scope: string) =>
    environmentId === here || scope === AuthOrchestrationOperateScope;
  it("enables Allow through the shared Connect account when m1 takes its line that way", () => {
    vi.mocked(useEnvironmentScope).mockImplementation(connectSignInThere as never);
    const html = action(true, undefined, true);
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Allow m1<\/button>/);
    expect(html).not.toContain("Join a main machine");
  });
  it("keeps the join line path for an older m1 or a sign-in that cannot operate there", () => {
    vi.mocked(useEnvironmentScope).mockImplementation(connectSignInThere as never);
    expect(action(true, undefined, false)).toContain("Join a main machine");
    vi.mocked(useEnvironmentScope).mockImplementation(
      ((environmentId: EnvironmentId, scope: string) =>
        environmentId === here && scope === AuthAccessWriteScope) as never,
    );
    const html = action(true, undefined, true);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Allow m1<\/button>/);
    expect(html).toContain("Join a main machine");
  });
  it("hands this machine's line to m1 through the Connect sign-in after one confirmation", async () => {
    vi.mocked(useEnvironmentScope).mockImplementation(connectSignInThere as never);
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(addVisibleMachineToStudioFleet).mockClear();
    vi.mocked(allowStudioFleetWorkers).mockClear();
    vi.mocked(allowIncomingStudioFleetWorkers).mockClear();
    vi.mocked(joinAccountMachineForWorkers).mockResolvedValue(allowed);
    const onGranted = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <IncomingWorkerAction
          here={here}
          coordinator={coordinator}
          hereLabel="m4"
          coordinatorLabel="m1"
          connected
          accountJoin
          onGranted={onGranted}
        />,
      );
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(joinAccountMachineForWorkers).toHaveBeenCalledExactlyOnceWith({
      here,
      coordinator,
      coordinatorLabel: "m1",
      access: "full-access",
    });
    expect(addVisibleMachineToStudioFleet).not.toHaveBeenCalled();
    expect(allowStudioFleetWorkers).not.toHaveBeenCalled();
    expect(allowIncomingStudioFleetWorkers).not.toHaveBeenCalled();
    expect(onGranted).toHaveBeenCalledExactlyOnceWith({ access: "full-access", expiresAt: null });
    await act(async () => renderer!.unmount());
  });
  it("reports an account join m1 did not confirm and grants nothing", async () => {
    vi.mocked(useEnvironmentScope).mockImplementation(connectSignInThere as never);
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(joinAccountMachineForWorkers).mockRejectedValue(
      new Error("m1 did not answer. Check that it is online, then retry."),
    );
    const onGranted = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <IncomingWorkerAction
          here={here}
          coordinator={coordinator}
          hereLabel="m4"
          coordinatorLabel="m1"
          connected
          accountJoin
          onGranted={onGranted}
        />,
      );
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(onGranted).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).props.children).toBe(
      "m1 did not answer. Check that it is online, then retry.",
    );
    await act(async () => renderer!.unmount());
  });
  it("says the one manual path when m1 is neither managed here nor in this machine's list", () => {
    vi.mocked(useEnvironmentScope).mockImplementation((environmentId) => environmentId === here);
    const html = action();
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Allow m1<\/button>/);
    expect(html).toContain("m1 → m4");
    expect(html).toContain(
      "On m4, open Settings &gt; Machines &gt; Join a main machine, pick m1 and copy the line. On m1, open Settings &gt; Machines &gt; Add a machine, paste it, then choose Allow on m4&#x27;s card.",
    );
    // One plain step: no second hint pointing at a card m1 does not have.
    expect(html).not.toContain("not set up yet");
    expect(html).not.toContain("Manage access is needed");
  });
  it("enables the Allow button from this machine alone when it lists m1", () => {
    vi.mocked(useEnvironmentScope).mockImplementation((environmentId) => environmentId === here);
    const html = action(true, "m1");
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Allow m1<\/button>/);
    expect(html).not.toContain("Join a main machine");
  });
  it("stays disabled without manage access here, even when it lists m1", () => {
    vi.mocked(useEnvironmentScope).mockReturnValue(false);
    const html = action(true, "m1");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Allow m1<\/button>/);
    expect(html).toContain("Manage access is needed on m4.");
  });
  it("enables the Allow button when both machines can be managed", () => {
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    const html = action();
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Allow m1<\/button>/);
    expect(html).not.toContain("not set up yet");
  });
  it("explains an unconnected sending machine", () => {
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    expect(action(false)).toContain("Connect to m1 first.");
  });
  it("runs the incoming setup from the card's own label after one confirmation", async () => {
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(readStudioFleetMachines).mockResolvedValue([]);
    vi.mocked(addVisibleMachineToStudioFleet).mockResolvedValue(added);
    vi.mocked(allowStudioFleetWorkers).mockResolvedValue(allowed);
    const onGranted = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <IncomingWorkerAction
          here={here}
          coordinator={coordinator}
          hereLabel="m4"
          coordinatorLabel="m1"
          connected
          actionLabel="Let m1 use this machine too"
          onGranted={onGranted}
        />,
      );
    });
    const button = renderer!.root.findByType("button");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Let m1 use this machine too");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Allow m1");
    // The card's own label already names the direction.
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("m1 → m4");
    await act(async () => button.props.onClick());
    expect(requestConfirmDialog).toHaveBeenCalledTimes(1);
    // This machine is added on the other one, which then allows its workers here.
    expect(addVisibleMachineToStudioFleet).toHaveBeenCalledExactlyOnceWith(coordinator, here, "m4");
    expect(allowStudioFleetWorkers).toHaveBeenCalledExactlyOnceWith(coordinator, {
      id: "m4",
      access: "full-access",
    });
    expect(onGranted).toHaveBeenCalledExactlyOnceWith({ access: "full-access", expiresAt: null });
    await act(async () => renderer!.unmount());
  });
  it("asks this machine's server to have m1 add and allow it when m1 cannot be managed here", async () => {
    vi.mocked(useEnvironmentScope).mockImplementation((environmentId) => environmentId === here);
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(addVisibleMachineToStudioFleet).mockClear();
    vi.mocked(allowStudioFleetWorkers).mockClear();
    vi.mocked(allowIncomingStudioFleetWorkers).mockResolvedValue(allowed);
    const onGranted = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <IncomingWorkerAction
          here={here}
          coordinator={coordinator}
          hereLabel="m4"
          coordinatorLabel="m1"
          connected
          coordinatorFleetId="m1-line"
          actionLabel="Let m1 use this machine too"
          onGranted={onGranted}
        />,
      );
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(requestConfirmDialog).toHaveBeenCalled();
    expect(allowIncomingStudioFleetWorkers).toHaveBeenCalledExactlyOnceWith(
      here,
      "m1-line",
      "full-access",
    );
    expect(addVisibleMachineToStudioFleet).not.toHaveBeenCalled();
    expect(allowStudioFleetWorkers).not.toHaveBeenCalled();
    expect(onGranted).toHaveBeenCalledExactlyOnceWith({ access: "full-access", expiresAt: null });
    await act(async () => renderer!.unmount());
  });
  it("shows the saved access, its expiry and the sending side as done", () => {
    const html = renderToStaticMarkup(
      <IncomingWorkerSaved
        coordinatorLabel="m1"
        access="full-access"
        expiresAt="2027-11-06T12:00:00.000Z"
      />,
    );
    expect(html).toContain("m1 can run work here · Full access · until November 6, 2027");
    expect(html).toContain("On m1: done");
  });
  it("leaves the expiry out when none is known", () => {
    const html = renderToStaticMarkup(
      <IncomingWorkerSaved coordinatorLabel="m1" access="full-access" expiresAt={null} />,
    );
    expect(html).toContain("m1 can run work here · Full access</p>");
  });
});
