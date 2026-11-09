import { describe, expect, it } from "vite-plus/test";
import type { ProjectConnection } from "@specweave-studio/contracts";
import { SERVICE_PRESETS, serviceRowState, serviceStatusText } from "./assistantServices";

const connection = (over: Partial<ProjectConnection>) =>
  ({ status: "configured", allowedTools: [], ...over }) as ProjectConnection;

describe("service presets", () => {
  it("pins every package and names only variables, never values", () => {
    for (const preset of SERVICE_PRESETS) {
      expect(preset.config.args[1]).toMatch(/^--package=.+@\d+\.\d+\.\d+$/);
      for (const key of preset.config.envKeys) expect(key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });
});

describe("serviceRowState", () => {
  it("treats a revoked connection as not connected", () => {
    expect(serviceRowState(undefined)).toBe("not-connected");
    expect(serviceRowState(connection({ status: "revoked" }))).toBe("not-connected");
    expect(serviceRowState(connection({ status: "unavailable" }))).toBe("needs-check");
    expect(serviceRowState(connection({ status: "ready" }))).toBe("ready");
  });

  it("says how many tools are allowed", () => {
    expect(serviceStatusText(connection({ status: "ready" }))).toBe("Ready, no tools allowed");
    expect(serviceStatusText(connection({ status: "ready", allowedTools: ["a"] }))).toBe(
      "Ready, 1 tool allowed",
    );
  });
});
