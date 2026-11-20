import { DEFAULT_ADVISOR_SETTINGS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatSettingValueFor } from "./settingValueLabels";

describe("advisor value labels", () => {
  it("names each field a project override changed", () => {
    expect(formatSettingValueFor("advisor", { enabled: true })).toBe("On");
    expect(formatSettingValueFor("advisor", { enabled: true, maxConsultsPerRun: 5 })).toBe(
      "On, 5 consults per run",
    );
    expect(
      formatSettingValueFor("advisor", {
        model: { instanceId: "codex", model: "gpt-6.1-sol" },
        claudeBuiltIn: false,
        builtInContextLimit: 400_000,
        briefTokenBudget: 32_000,
        maxConsultsPerRun: 1,
      }),
    ).toBe(
      "Advisor gpt-6.1-sol, Claude's own advisor off, Claude's advisor up to 400,000 tokens, 1 consult per run, 32,000-token brief",
    );
    expect(formatSettingValueFor("advisor", { model: null })).toBe("Default advisor order");
  });

  it("reads the app's whole value by its switch and what differs from the defaults", () => {
    expect(formatSettingValueFor("advisor", DEFAULT_ADVISOR_SETTINGS)).toBe("Off");
    expect(
      formatSettingValueFor("advisor", {
        ...DEFAULT_ADVISOR_SETTINGS,
        enabled: true,
        maxConsultsPerRun: 7,
      }),
    ).toBe("On, 7 consults per run");
  });

  it("never falls back to Custom for an advisor value", () => {
    expect(formatSettingValueFor("advisor", { enabled: false })).not.toBe("Custom");
  });
});
