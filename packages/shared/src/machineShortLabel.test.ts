import { describe, expect, it } from "vite-plus/test";

import { assignMachineShortLabels, machineShortLabelCandidates } from "./machineShortLabel.ts";

const fleet = (...machines: Array<[string, string, string?]>) =>
  Object.fromEntries(
    assignMachineShortLabels(
      machines.map(([environmentId, name, short]) => ({ environmentId, name, short })),
    ),
  );

describe("machine short labels", () => {
  it("keeps a short name as it is and abbreviates a long one", () => {
    expect(fleet(["a", "M4"], ["b", "m3"], ["c", "linux-mini"])).toEqual({
      a: "M4",
      b: "m3",
      c: "LM",
    });
  });

  it("never gives two machines the same derived label", () => {
    const labels = fleet(["a", "linux-mini"], ["b", "linux-main"], ["c", "Lab Mac"]);
    expect(new Set(Object.values(labels)).size).toBe(3);
    expect(labels.a).toBe("LM");
    expect(labels.b).toBe("LI");
  });

  it("steps aside for a label someone chose and for a short name", () => {
    expect(fleet(["a", "linux-mini"], ["b", "Laptop", "LM"])).toEqual({ a: "LI", b: "LM" });
    expect(fleet(["a", "linux-mini"], ["b", "LM"])).toEqual({ a: "LI", b: "LM" });
    // One character tells nothing apart, so it is derived instead.
    expect(fleet(["a", "o"], ["b", "Ops", "X"])).toEqual({ a: "O1", b: "Ops" });
  });

  it("is the same on every device, whatever order the fleet is listed in", () => {
    const one = fleet(["x", "studio"], ["y", "studio-2"], ["z", "Studio"]);
    const two = fleet(["z", "Studio"], ["y", "studio-2"], ["x", "studio"]);
    expect(one).toEqual(two);
    expect(new Set(Object.values(one)).size).toBe(3);
  });

  it("always has at least two characters", () => {
    expect(machineShortLabelCandidates("x")[0]).toBe("X1");
    expect(machineShortLabelCandidates("🚀")[0]).toBe("M1");
    expect(machineShortLabelCandidates("Mäc Mini")[0]).toBe("MM");
    for (const label of Object.values(fleet(["a", "Office desktop"], ["b", "o"]))) {
      expect(label.length).toBeGreaterThanOrEqual(2);
    }
  });
});
