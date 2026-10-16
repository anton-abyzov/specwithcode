import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatSettingValue, listProjectSettingOverrides } from "./projectOverrideRows";

const m4 = EnvironmentId.make("m4");
const project = ProjectId.make("p1");
const environment = (overrides: ServerSettings["projectSettingsOverrides"]) => ({
  environmentId: m4,
  label: "MacBook",
  serverConfig: {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerLimitAction: "switch",
      projectSettingsOverrides: overrides,
    } as ServerSettings,
  },
});

describe("listProjectSettingOverrides", () => {
  it("lists nothing for a project that follows the app settings", () => {
    expect(
      listProjectSettingOverrides([{ environmentId: m4, id: project }], [environment({})]),
    ).toEqual([]);
  });

  it("lists each real override with the app value", () => {
    const rows = listProjectSettingOverrides(
      [{ environmentId: m4, id: project }],
      [environment({ [project]: { providerLimitAction: "ask" } })],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        key: "providerLimitAction",
        label: "When a provider runs out",
        page: "Providers",
        value: "Ask",
        appValue: "Switch",
        environmentLabel: "MacBook",
      }),
    ]);
  });

  it("formats values for people", () => {
    expect(formatSettingValue(null)).toBe("None");
    expect(formatSettingValue(true)).toBe("On");
    expect(formatSettingValue("approval-required")).toBe("Ask for approval");
    expect(formatSettingValue([1, 2])).toBe("2 items");
  });
});
