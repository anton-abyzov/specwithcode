import { describe, expect, it } from "vite-plus/test";

import {
  claudeAccountPlan,
  claudeLoginCommand,
  isClaudeSignInCode,
} from "./addClaudeAccount.logic";

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

  it("gives Windows the PowerShell form of that command", () => {
    expect(claudeLoginCommand("~/.claude-work", "linux")).toBe(
      "CLAUDE_CONFIG_DIR=~/.claude-work command claude auth login",
    );
    expect(claudeLoginCommand("~/.claude-work", "windows")).toBe(
      '$env:CLAUDE_CONFIG_DIR = "$HOME\\.claude-work"; claude auth login',
    );
  });

  it("knows the shape of the code Claude's page gives", () => {
    expect(isClaudeSignInCode(" abc123#STATE1 ")).toBe(true);
    expect(
      isClaudeSignInCode("https://platform.claude.com/oauth/code/callback?code=abc&state=S1"),
    ).toBe(true);
    for (const half of [
      "",
      "abc123",
      "abc123#",
      "#STATE1",
      "abc 123#STATE1",
      "abc#123#STATE1",
      "abc\u0007#STATE1",
      "https://x.test/",
      "https://x.test/?code=a%0Ab&state=S1",
      "https://x.test/?code=a%23b&state=S1",
    ])
      expect(isClaudeSignInCode(half), half).toBe(false);
  });
});
