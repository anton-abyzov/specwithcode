import { describe, expect, it } from "vite-plus/test";

import { machineColumnCh, machineColumnLabel, machineFilterOptions } from "./threadMachineFilter";

const thread = (machine: string, resolved = false) => ({
  machine,
  archivedAt: null,
  settledOverride: resolved ? "settled" : null,
});

describe("machine filter", () => {
  it("offers each machine with its open threads, busiest first", () => {
    const options = machineFilterOptions(
      [
        thread("m4"),
        thread("ministorm"),
        thread("m4"),
        thread("ministorm", true),
        thread("m1", true),
      ],
      (t) => ({ machineId: t.machine, label: t.machine }),
    );
    expect(options).toEqual([
      { machineId: "m4", label: "m4", count: 2 },
      { machineId: "ministorm", label: "ministorm", count: 1 },
      { machineId: "m1", label: "m1", count: 0 },
    ]);
  });

  it("sizes the column to the longest name within 4 to 10 characters", () => {
    expect(machineColumnCh(["m4"])).toBe(4);
    expect(machineColumnCh(["m4", "ministorm"])).toBe(9);
    expect(machineColumnCh(["a-very-long-machine-name"])).toBe(10);
  });

  it("names where a moved thread runs", () => {
    expect(machineColumnLabel({ label: "M4 → Minis", moved: true })).toBe("→ Minis");
    expect(machineColumnLabel({ label: "M4", moved: false })).toBe("M4");
  });
});
