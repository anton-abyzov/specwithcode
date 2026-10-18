import { describe, expect, it } from "vite-plus/test";

import { coordinatorMachineKey, resolveCoordinatorMachine } from "./projectCoordinatorMachine";

const m4 = { environmentId: "env-m4", id: "proj-a" };
const m1 = { environmentId: "env-m1", id: "proj-b" };
const m3 = { environmentId: "env-m3", id: "proj-c" };

describe("resolveCoordinatorMachine", () => {
  it("uses the saved checkout when it is listed", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m4, m1, m3],
        saved: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m1, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("follows the saved machine when the project was re-added there", () => {
    const readded = { environmentId: "env-m1", id: "proj-new" };
    expect(
      resolveCoordinatorMachine({
        members: [m4, readded],
        saved: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: readded, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("starts on this computer's checkout when nothing is saved", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m1, m3, m4],
        saved: undefined,
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m4, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("uses the first checkout when this computer has none", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m1, m3],
        saved: undefined,
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m1, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("reports a saved machine that is not listed instead of hiding it", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m4, m3],
        saved: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m4, savedMachineMissing: true, savedMachineOffline: false });
  });

  it("stands in a reachable checkout while the saved machine is offline", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m4, m1, m3],
        saved: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1"]),
      }),
    ).toEqual({ member: m4, savedMachineMissing: false, savedMachineOffline: true });
  });

  it("keeps the saved checkout when no other machine is reachable", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m1, m3],
        saved: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1", "env-m3"]),
      }),
    ).toEqual({ member: m1, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("skips an unreachable first checkout when nothing is saved", () => {
    expect(
      resolveCoordinatorMachine({
        members: [m1, m3],
        saved: undefined,
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1"]),
      }),
    ).toEqual({ member: m3, savedMachineMissing: false, savedMachineOffline: false });
  });

  it("returns nothing for a project with no checkouts", () => {
    expect(
      resolveCoordinatorMachine({ members: [], saved: "env-m1:x", primaryEnvironmentId: null }),
    ).toEqual({ member: undefined, savedMachineMissing: false, savedMachineOffline: false });
  });
});
