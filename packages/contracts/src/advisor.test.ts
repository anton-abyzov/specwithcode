import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AdvisorConsultInput,
  AdvisorConsultResult,
  AdvisorSettings,
  AdvisorSettingsPatch,
  DEFAULT_ADVISOR_SETTINGS,
  MAX_ADVISOR_FOCUS_LENGTH,
} from "./advisor.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
import {
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectSettingsOverrides,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(AdvisorSettings);
const decodePatch = Schema.decodeUnknownSync(AdvisorSettingsPatch);

describe("AdvisorSettings", () => {
  it("decodes from an empty object to the defaults, off", () => {
    expect(decodeSettings({})).toEqual(DEFAULT_ADVISOR_SETTINGS);
    expect(DEFAULT_ADVISOR_SETTINGS).toEqual({
      enabled: false,
      model: null,
      claudeBuiltIn: true,
      builtInContextLimit: 200_000,
      maxConsultsPerRun: 3,
      briefTokenBudget: 24_000,
    });
  });

  it("keeps saved values and a saved model", () => {
    expect(
      decodeSettings({
        enabled: true,
        model: { instanceId: "claudeAgent", model: "claude-fable-5-2" },
        maxConsultsPerRun: 5,
      }),
    ).toMatchObject({
      enabled: true,
      model: { instanceId: "claudeAgent", model: "claude-fable-5-2" },
      maxConsultsPerRun: 5,
      briefTokenBudget: 24_000,
    });
  });

  it.each([
    ["builtInContextLimit", 49_999],
    ["builtInContextLimit", 1_000_001],
    ["maxConsultsPerRun", 0],
    ["maxConsultsPerRun", 11],
    ["briefTokenBudget", 3_999],
    ["briefTokenBudget", 64_001],
    ["maxConsultsPerRun", 2.5],
  ])("refuses %s = %s", (key, value) => {
    expect(() => decodeSettings({ [key]: value })).toThrow();
    expect(() => decodePatch({ [key]: value })).toThrow();
  });

  it("accepts the limits themselves", () => {
    expect(
      decodeSettings({
        builtInContextLimit: 50_000,
        maxConsultsPerRun: 10,
        briefTokenBudget: 64_000,
      }),
    ).toMatchObject({
      builtInContextLimit: 50_000,
      maxConsultsPerRun: 10,
      briefTokenBudget: 64_000,
    });
  });

  it("a patch names only the fields it changes, and can clear the model", () => {
    expect(decodePatch({})).toEqual({});
    expect(decodePatch({ model: null })).toEqual({ model: null });
    expect(decodePatch({ enabled: true })).toEqual({ enabled: true });
  });
});

describe("advisor in server settings", () => {
  it("is absent from old settings files and decodes to the defaults", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({});
    expect(settings.advisor).toEqual(DEFAULT_ADVISOR_SETTINGS);
  });

  it("is a project-scoped key overridable field by field", () => {
    expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).toContain("advisor");
    const overrides = Schema.decodeUnknownSync(ProjectSettingsOverrides)({
      advisor: { enabled: true },
    });
    expect(overrides.advisor).toEqual({ enabled: true });
  });

  it("is patchable app-wide", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      advisor: { briefTokenBudget: 8_000 },
    });
    expect(patch.advisor).toEqual({ briefTokenBudget: 8_000 });
  });
});

describe("the advisor tool", () => {
  it("takes no arguments, or a focus up to the limit", () => {
    const decode = Schema.decodeUnknownSync(AdvisorConsultInput);
    expect(decode({})).toEqual({});
    expect(decode({ focus: "x".repeat(MAX_ADVISOR_FOCUS_LENGTH) }).focus).toHaveLength(
      MAX_ADVISOR_FOCUS_LENGTH,
    );
    expect(() => decode({ focus: "x".repeat(MAX_ADVISOR_FOCUS_LENGTH + 1) })).toThrow();
  });

  it("returns advice, the advisor and the consults left", () => {
    const result = Schema.decodeUnknownSync(AdvisorConsultResult)({
      status: "advice",
      message: "Claude Fable 5.2 reviewed the work.",
      advice: "Check the migration first.",
      advisor: "Claude Fable 5.2 on Claude",
      consultsRemaining: 2,
    });
    expect(result.consultsRemaining).toBe(2);
  });

  it("a refusal names its reason", () => {
    const result = Schema.decodeUnknownSync(AdvisorConsultResult)({
      status: "refused",
      message: "The advisor is off for this thread.",
      refusal: "off",
    });
    expect(result.refusal).toBe("off");
  });
});

describe("thread.advisor-mode.set", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  it.each(["on", "off", null])("accepts %s", (advisorMode) => {
    expect(
      decode({
        type: "thread.advisor-mode.set",
        commandId: "cmd-1",
        threadId: "thread-1",
        advisorMode,
      }),
    ).toMatchObject({ type: "thread.advisor-mode.set", advisorMode });
  });

  it("refuses an unknown mode", () => {
    expect(() =>
      decode({
        type: "thread.advisor-mode.set",
        commandId: "cmd-1",
        threadId: "thread-1",
        advisorMode: "auto",
      }),
    ).toThrow();
  });
});
