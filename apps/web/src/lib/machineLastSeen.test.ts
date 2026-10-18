import { beforeEach, expect, it } from "vite-plus/test";

import {
  machineLastSeenAt,
  recordMachinePhases,
  resetMachineLastSeenForTests,
} from "./machineLastSeen";

const machine = (phase: "connected" | "reconnecting" | "connecting") => [
  { environmentId: "m1", connection: { phase } },
];

beforeEach(() => resetMachineLastSeenForTests());

it("keeps the last time a machine was connected after it drops", () => {
  recordMachinePhases(machine("connecting"), 1_000);
  expect(machineLastSeenAt("m1")).toBeNull();
  recordMachinePhases(machine("connected"), 2_000);
  expect(machineLastSeenAt("m1")).toBe(2_000);
  // Refreshed at most once a minute while it stays connected.
  recordMachinePhases(machine("connected"), 30_000);
  expect(machineLastSeenAt("m1")).toBe(2_000);
  recordMachinePhases(machine("reconnecting"), 45_000);
  expect(machineLastSeenAt("m1")).toBe(45_000);
  recordMachinePhases(machine("reconnecting"), 3_600_000);
  expect(machineLastSeenAt("m1")).toBe(45_000);
});
