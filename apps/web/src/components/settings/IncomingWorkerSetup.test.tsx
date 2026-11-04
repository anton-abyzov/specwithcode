import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetAddResult,
  StudioFleetWorkersResult,
} from "@specweave-studio/contracts/studioFleet";
vi.mock("../../studio/fleet", () => ({
  addVisibleMachineToStudioFleet: vi.fn(),
  allowStudioFleetWorkers: vi.fn(),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("../../studio/machineNickname", () => ({ useMachineNicknames: vi.fn() }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
import { setUpIncomingWorkers } from "./IncomingWorkerSetup";
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
  return { add: vi.fn().mockResolvedValue(added), allow: vi.fn().mockResolvedValue(allowed) };
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
    expect((failure as Error).message).toContain(
      "Settings > Machines > Authorized clients on M4",
    );
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
      "was added there, but worker access was not confirmed",
    );
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
