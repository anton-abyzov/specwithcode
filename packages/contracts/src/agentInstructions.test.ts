import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AgentInstructions,
  ClaudeWorkflowMode,
  resolveAgentInstructions,
  ResponseStyle,
} from "./agentInstructions.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const isServerSettingsPatch = Schema.is(ServerSettingsPatch);

describe("shared agent instructions", () => {
  it("preserves environment rules alongside project additions", () => {
    expect(
      resolveAgentInstructions({
        globalInstructions: "Always verify",
        projectInstructions: "Use Node 22",
      }),
    ).toBe("## Environment instructions\nAlways verify\n\n## Project instructions\nUse Node 22");
    expect(
      resolveAgentInstructions({
        globalInstructions: " Always verify ",
        projectInstructions: "  ",
      }),
    ).toBe("## Environment instructions\nAlways verify");
    expect(resolveAgentInstructions({})).toBe("");
  });

  it("decodes older settings with conservative workflow defaults", () => {
    const settings = decodeServerSettings({});
    expect(settings.agentInstructions).toBe("");
    expect(settings.claudeWorkflowMode).toBe("on-request");
    expect(settings.responseStyle).toBe("concise");
    expect(settings.projectSettingsOverrides).toEqual({});
  });

  it("validates workflow modes and bounds instruction size at the write boundary", () => {
    expect(Schema.is(ClaudeWorkflowMode)("automatic")).toBe(true);
    expect(Schema.is(ClaudeWorkflowMode)("ultracode")).toBe(false);
    expect(Schema.is(AgentInstructions)("x".repeat(32_001))).toBe(false);
    expect(Schema.is(ServerSettingsPatch)({ claudeWorkflowMode: "unexpected" })).toBe(false);
    expect(
      Schema.is(ServerSettingsPatch)({
        agentInstructions: "Global",
        projectSettingsOverrides: {
          p: { agentInstructions: "Project", claudeWorkflowMode: "disabled" },
        },
      }),
    ).toBe(true);
  });

  it("accepts concise or detailed responses globally and per project", () => {
    expect(ResponseStyle.literals).toEqual(["concise", "detailed"]);
    expect(isServerSettingsPatch({ responseStyle: "detailed" })).toBe(true);
    expect(isServerSettingsPatch({ responseStyle: "verbose" })).toBe(false);
    expect(
      isServerSettingsPatch({
        projectSettingsOverrides: { p: { responseStyle: "concise" } },
      }),
    ).toBe(true);
    const decoded = decodeServerSettings({
      responseStyle: "detailed",
      projectSettingsOverrides: { p: { responseStyle: "concise" } },
    });
    expect(decoded.responseStyle).toBe("detailed");
    expect(Object.values(decoded.projectSettingsOverrides)[0]?.responseStyle).toBe("concise");
  });
});
