import { describe, expect, it } from "vite-plus/test";

import { machineStillChecking, type MachineCheckInput } from "./machineChecking";

const base: MachineCheckInput = {
  catalogReady: true,
  phase: null,
  autoConnect: true,
  fleetPending: false,
  autoConnectWillTry: false,
};

describe("machineStillChecking", () => {
  it("is checking while the saved machine list has not loaded", () => {
    expect(machineStillChecking({ ...base, catalogReady: false })).toBe(true);
  });

  it("is checking on a saved machine's first connection attempt only", () => {
    expect(machineStillChecking({ ...base, phase: "connecting" })).toBe(true);
    expect(machineStillChecking({ ...base, phase: "connected" })).toBe(false);
    expect(machineStillChecking({ ...base, phase: "reconnecting" })).toBe(false);
    expect(machineStillChecking({ ...base, phase: "error" })).toBe(false);
    expect(machineStillChecking({ ...base, phase: "available" })).toBe(false);
  });

  it("is checking a fresh browser's private machine until automatic pairing has tried it (Ministorm on load)", () => {
    expect(machineStillChecking({ ...base, fleetPending: true })).toBe(true);
    expect(machineStillChecking({ ...base, autoConnectWillTry: true })).toBe(true);
    // Tried and failed, or not one of this server's private machines: not connected.
    expect(machineStillChecking(base)).toBe(false);
  });

  it("never waits on automatic pairing that is turned off", () => {
    expect(
      machineStillChecking({
        ...base,
        autoConnect: false,
        fleetPending: true,
        autoConnectWillTry: true,
      }),
    ).toBe(false);
  });
});
