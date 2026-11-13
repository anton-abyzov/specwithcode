import { describe, expect, it } from "vite-plus/test";

import { handoffAccountMachines, handoffFleetOnlyMachines } from "./handoffAccountMachines";

const found = (environmentId: string, label: string, availability = "online") => ({
  environment: { environmentId, label },
  availability,
});

describe("handoffAccountMachines", () => {
  it("offers an account machine this app never saved", () => {
    expect(
      handoffAccountMachines({
        discovered: [found("m4", "M4"), found("m5", "M5"), found("mini", "Mini")],
        savedEnvironmentIds: new Set(["m4", "m1"]),
        sourceEnvironmentId: "mini",
      }),
    ).toEqual([{ environmentId: "m5", label: "M5", answering: true }]);
  });

  it("keeps a machine that is not answering, and says so", () => {
    expect(
      handoffAccountMachines({
        discovered: [found("m5", "M5", "offline"), found("m6", "M6", "checking")],
        savedEnvironmentIds: new Set(),
        sourceEnvironmentId: "m4",
      }).map((machine) => [machine.environmentId, machine.answering]),
    ).toEqual([
      ["m5", false],
      ["m6", true],
    ]);
  });

  it("names machines the way the rest of the app does", () => {
    expect(
      handoffAccountMachines({
        discovered: [found("m5", "Anton M5MAX")],
        savedEnvironmentIds: new Set(),
        sourceEnvironmentId: "m4",
        name: (id, label) => (id === "m5" ? "m5" : label),
      })[0]?.label,
    ).toBe("m5");
  });
});

describe("handoffFleetOnlyMachines", () => {
  it("names a fleet machine this app cannot reach or offer", () => {
    expect(
      handoffFleetOnlyMachines({
        fleet: [
          { environmentId: "m1", label: "M1" },
          { environmentId: "m5", label: "M5" },
          { environmentId: "m5", label: "M5" },
          { environmentId: "m6", label: "M6" },
          { environmentId: "mini", label: "Mini" },
        ],
        savedEnvironmentIds: new Set(["m1"]),
        sourceEnvironmentId: "mini",
        offeredEnvironmentIds: new Set(["m6"]),
      }),
    ).toEqual([{ environmentId: "m5", label: "M5" }]);
  });
});
