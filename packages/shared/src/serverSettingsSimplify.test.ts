import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { simplifyProjectSettingsOverrides } from "./serverSettings.ts";

const settings = (
  overrides: Record<string, Record<string, unknown>>,
  patch: Partial<ServerSettings> = {},
): ServerSettings =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsFolded: true,
    ...patch,
    projectSettingsOverrides: overrides,
  }) as ServerSettings;

describe("simplifyProjectSettingsOverrides", () => {
  it("keeps disagreeing overrides and drops ones equal to the app value", () => {
    const result = simplifyProjectSettingsOverrides(
      settings(
        {
          a: { providerLimitAction: "ask", defaultRuntimeMode: "full-access" },
          b: { defaultRuntimeMode: "approval-required" },
        },
        { providerLimitAction: "switch", defaultRuntimeMode: "full-access" },
      ),
      ["a", "b", "c"],
    );
    expect(result.projectSettingsOverrides).toEqual({
      a: { providerLimitAction: "ask" },
      b: { defaultRuntimeMode: "approval-required" },
    });
    expect(result.providerLimitAction).toBe("switch");
    expect(result.defaultRuntimeMode).toBe("full-access");
    expect(result.projectSettingsSimplified).toBe(true);
  });

  it("promotes a value every live project shares to the app value", () => {
    const result = simplifyProjectSettingsOverrides(
      settings(
        { a: { defaultAutoPull: true }, b: { defaultAutoPull: true } },
        { defaultAutoPull: false },
      ),
      ["a", "b"],
    );
    expect(result.defaultAutoPull).toBe(true);
    expect(result.projectSettingsOverrides).toEqual({});
    expect(result.projectAutoPullOverrides).toEqual({});
  });

  it("keeps a deleted project's override from blocking or being promoted", () => {
    const result = simplifyProjectSettingsOverrides(
      settings({
        a: { defaultThreadEnvMode: "local" },
        gone: { defaultThreadEnvMode: "worktree" },
      }),
      ["a"],
    );
    expect(result.defaultThreadEnvMode).toBe("local");
    expect(result.projectSettingsOverrides).toEqual({ gone: { defaultThreadEnvMode: "worktree" } });
  });

  it("runs once", () => {
    const done = settings({ a: { defaultAutoPull: true } }, { projectSettingsSimplified: true });
    expect(simplifyProjectSettingsOverrides(done, ["a"])).toBe(done);
  });
});
