import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { groupProjectSettingOverrides } from "./projectOverrideRows";
import { formatSettingValueFor } from "./settingValueLabels";

const m1 = EnvironmentId.make("m1");
const m4 = EnvironmentId.make("m4");
const storm = EnvironmentId.make("storm");
const project = ProjectId.make("p1");
const environment = (
  environmentId: EnvironmentId,
  label: string,
  overrides: ServerSettings["projectSettingsOverrides"],
  app: Partial<ServerSettings> = {},
) => ({
  environmentId,
  label,
  serverConfig: {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerLimitAction: "switch",
      ...app,
      projectSettingsOverrides: overrides,
    } as ServerSettings,
  },
});
const checkout = (environmentId: EnvironmentId) => ({ environmentId, id: project });

describe("groupProjectSettingOverrides", () => {
  it("lists nothing for a project that follows the app settings", () => {
    expect(groupProjectSettingOverrides([checkout(m4)], [environment(m4, "M4", {})])).toEqual([]);
  });

  it("lists each real override with the app value", () => {
    const groups = groupProjectSettingOverrides(
      [checkout(m4)],
      [environment(m4, "M4", { [project]: { providerLimitAction: "ask" } })],
    );
    expect(groups).toEqual([
      expect.objectContaining({
        key: "providerLimitAction",
        label: "When a provider runs out",
        page: "Providers",
        lines: [
          expect.objectContaining({
            value: "Ask",
            appValue: "Switch",
            rawValue: "ask",
            sameAsApp: false,
            machines: [expect.objectContaining({ environmentLabel: "M4", rawValue: "ask" })],
          }),
        ],
      }),
    ]);
  });

  it("shows one row per setting, grouping machines with the same values", () => {
    const providers = ["acpRegistry_devin", "acpRegistry_copilot", "copilot-0889"].map((id) =>
      ProviderInstanceId.make(id),
    );
    const groups = groupProjectSettingOverrides(
      [checkout(m4), checkout(storm), checkout(m1)],
      [
        environment(m4, "M4MAX", { [project]: { defaultModelProviders: providers } }),
        environment(storm, "Ministorm", {
          [project]: { defaultModelProviders: providers, defaultRuntimeMode: "full-access" },
        }),
        environment(
          m1,
          "M1Max",
          { [project]: { threadFinishAction: "auto_merge" } },
          { threadFinishAction: "pull_request", defaultRuntimeMode: "approval-required" },
        ),
      ],
      (_environmentId, item) =>
        ({ acpRegistry_devin: "Devin", acpRegistry_copilot: "Copilot" })[item],
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Providers for the recommended model",
      "Permissions for new threads",
      "When a thread finishes",
    ]);
    const [providerGroup, runtimeGroup, finishGroup] = groups;
    expect(providerGroup!.lines).toHaveLength(1);
    expect(providerGroup!.lines[0]!.machines.map((machine) => machine.environmentLabel)).toEqual([
      "M4MAX",
      "Ministorm",
    ]);
    expect(providerGroup!.lines[0]!.value).toBe("Devin, Copilot +1");
    expect(providerGroup!.lines[0]!.appValue).toBe("None");
    expect(runtimeGroup!.lines[0]!.value).toBe("Full access");
    expect(finishGroup!.lines[0]!.value).toBe("Open PR and auto-merge");
    expect(finishGroup!.lines[0]!.appValue).not.toMatch(/_/);
  });

  it("splits machines whose values differ", () => {
    const groups = groupProjectSettingOverrides(
      [checkout(m4), checkout(storm)],
      [
        environment(m4, "M4", { [project]: { defaultRuntimeMode: "full-access" } }),
        environment(storm, "Ministorm", { [project]: { defaultRuntimeMode: "auto-accept-edits" } }),
      ],
    );
    expect(groups[0]!.lines.map((line) => line.value)).toEqual(["Full access", "Accept edits"]);
  });
});

describe("formatSettingValueFor", () => {
  it("formats values for people", () => {
    expect(formatSettingValueFor("providerLimitAction", null)).toBe("Not set");
    expect(formatSettingValueFor("enableAgentBrowserAccess", true)).toBe("On");
    expect(formatSettingValueFor("defaultRuntimeMode", "approval-required")).toBe(
      "Ask for approval",
    );
    expect(formatSettingValueFor("threadFinishAction", "pull_request")).not.toMatch(/_/);
    expect(formatSettingValueFor("defaultModelProviders", [])).toBe("None");
    expect(
      formatSettingValueFor("providerLimitFallbackModels", [
        { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        { instanceId: "codex", model: "gpt-6.1-sol" },
      ]),
    ).toBe("claude-opus-5-5, gpt-6.1-sol");
    expect(formatSettingValueFor("providerLimitSwitchAtPercent", 95)).toBe("95%");
  });
});
