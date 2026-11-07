import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetAddResult,
  StudioFleetWorkersResult,
} from "@specweave-studio/contracts/studioFleet";
vi.mock("../../studio/fleet", () => ({
  addVisibleMachineToStudioFleet: vi.fn(),
  allowIncomingStudioFleetWorkers: vi.fn(),
  allowStudioFleetWorkers: vi.fn(),
  readStudioFleetMachines: vi.fn(),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("../../studio/machineNickname", () => ({ useMachineNicknames: vi.fn() }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: true }));
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentScope } from "../../state/session";
import {
  addVisibleMachineToStudioFleet,
  allowIncomingStudioFleetWorkers,
  allowStudioFleetWorkers,
  readStudioFleetMachines,
} from "../../studio/fleet";
import {
  IncomingWorkerAction,
  IncomingWorkerSaved,
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

describe("incoming worker setup view", () => {
  const action = (connected = true, coordinatorFleetId?: string) =>
    renderToStaticMarkup(
      <IncomingWorkerAction
        here={here}
        coordinator={coordinator}
        hereLabel="m4"
        coordinatorLabel="m1"
        connected={connected}
        coordinatorFleetId={coordinatorFleetId}
        onGranted={vi.fn()}
      />,
    );
  it("says the one manual path when m1 is neither managed here nor in this machine's list", () => {
    vi.mocked(useEnvironmentScope).mockImplementation((environmentId) => environmentId === here);
    const html = action();
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Allow m1<\/button>/);
    expect(html).toContain(
      "On m4, open Settings &gt; Connections &gt; Join a main machine, pick m1 and copy the line. On m1, open Settings &gt; Machines &gt; Add a machine, paste it, then choose Allow workers on m4&#x27;s card.",
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
