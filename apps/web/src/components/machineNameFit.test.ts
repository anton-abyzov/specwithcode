import { describe, expect, it } from "vite-plus/test";

import { machineNameTooNarrow } from "./machineNameFit";

describe("machineNameTooNarrow", () => {
  it("keeps a name that fits", () => {
    expect(machineNameTooNarrow({ visible: 80, full: 80 }, 10)).toBe(false);
  });

  it("keeps a long name while it still shows four characters", () => {
    expect(machineNameTooNarrow({ visible: 40, full: 80 }, 10)).toBe(false);
  });

  it("swaps to the short label once fewer than four characters show", () => {
    expect(machineNameTooNarrow({ visible: 24, full: 80 }, 10)).toBe(true);
    expect(machineNameTooNarrow({ visible: 0, full: 80 }, 10)).toBe(true);
  });

  it("counts only the name after a prefix such as Runs on", () => {
    // "Runs on linux-box": 18 characters, 8 of them the prefix.
    expect(machineNameTooNarrow({ visible: 50, full: 72 }, 18, 8)).toBe(false);
    expect(machineNameTooNarrow({ visible: 32, full: 72 }, 18, 8)).toBe(true);
    expect(machineNameTooNarrow({ visible: 50, full: 60 }, 10, 8)).toBe(true);
  });

  it("swaps a short name as soon as any of it is cut off", () => {
    expect(machineNameTooNarrow({ visible: 10, full: 18 }, 2)).toBe(true);
  });
});
