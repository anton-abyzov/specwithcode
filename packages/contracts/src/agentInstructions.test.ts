import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  AgentInstructions,
  ClaudeWorkflowMode,
  LEGACY_DEFAULT_AGENT_INSTRUCTIONS,
  LIVE_DATABASE_INSTRUCTIONS,
  resolveAgentInstructions,
  ResponseStyle,
  withServiceInstructions,
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

  it("starts Settings > Agents empty and treats the retired default as nothing written", () => {
    expect(DEFAULT_AGENT_INSTRUCTIONS).toBe("");
    expect(
      resolveAgentInstructions({
        globalInstructions: `${LEGACY_DEFAULT_AGENT_INSTRUCTIONS}\n`,
        projectInstructions: "Use Node 22",
      }),
    ).toBe("## Project instructions\nUse Node 22");
    // Any edit makes the text the user's own, so it is sent as written.
    expect(
      resolveAgentInstructions({
        globalInstructions: `${LEGACY_DEFAULT_AGENT_INSTRUCTIONS}\nMine.`,
      }),
    ).toContain("Mine.");
  });

  it("always ends with the live database rule, even when the user wrote nothing", () => {
    expect(withServiceInstructions("")).toBe(LIVE_DATABASE_INSTRUCTIONS);
    expect(withServiceInstructions(" ## Environment instructions\nAlways verify ")).toBe(
      `## Environment instructions\nAlways verify\n\n${LIVE_DATABASE_INSTRUCTIONS}`,
    );
    expect(LIVE_DATABASE_INSTRUCTIONS).toContain("even read-only");
    expect(LIVE_DATABASE_INSTRUCTIONS).toContain("specweave-studio db snapshot");
    expect(LIVE_DATABASE_INSTRUCTIONS).toContain("specweave-studio db query");
  });

  it("decodes older settings with conservative workflow defaults", () => {
    const settings = decodeServerSettings({});
    expect(settings.agentInstructions).toBe(DEFAULT_AGENT_INSTRUCTIONS);
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
