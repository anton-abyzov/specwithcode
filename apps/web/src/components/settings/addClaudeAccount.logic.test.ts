import { describe, expect, it } from "vite-plus/test";

import { claudeAccountPlan, claudeLoginCommand } from "./addClaudeAccount.logic";

describe("claudeAccountPlan", () => {
  it("gives a new account its own instance and Claude home", () => {
    expect(claudeAccountPlan(" Marketing Team ", {})).toEqual({
      instanceId: "claudeAgent_marketing_team",
      displayName: "Claude - Marketing Team",
      homePath: "~/.claude-marketing-team",
    });
  });

  it("never reuses a taken id or home, so sign-ins stay apart", () => {
    const plan = claudeAccountPlan("Work", {
      claudeAgent_work: { config: { homePath: "~/.claude-work" } },
      claudeAgent_other: { config: { homePath: "~/.claude-work-2" } },
    });
    expect(plan).toMatchObject({ instanceId: "claudeAgent_work_3", homePath: "~/.claude-work-3" });
  });

  it("falls back to a plain name when the label has no letters or digits", () => {
    expect(claudeAccountPlan("!!!", {}).homePath).toBe("~/.claude-account");
  });

  it("signs in to exactly that home", () => {
    expect(claudeLoginCommand("~/.claude-work")).toBe(
      "CLAUDE_CONFIG_DIR=~/.claude-work command claude auth login",
    );
  });
});
