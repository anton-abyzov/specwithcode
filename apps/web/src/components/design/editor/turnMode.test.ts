import { describe, expect, it } from "vite-plus/test";
import { designTurnRuntimeMode } from "./turnMode";

describe("designTurnRuntimeMode", () => {
  it("uses the thread's mode, then the project default, then approval-required", () => {
    expect(designTurnRuntimeMode("auto", "full-access")).toBe("auto");
    expect(designTurnRuntimeMode(undefined, "auto-accept-edits")).toBe("auto-accept-edits");
    expect(designTurnRuntimeMode(undefined, undefined)).toBe("approval-required");
  });
});
