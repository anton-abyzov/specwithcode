import type { TeamRulesSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TEAM_RULES_ABOVE_LIMIT,
  teamRulesDecisionModelLock,
  teamRulesProviderLock,
  teamRulesRows,
  teamRulesThreadNotice,
} from "./teamRulesView";

const active: TeamRulesSummary = {
  status: "active",
  owner: "Acme",
  contact: "https://it.acme.example/ai",
  ceiling: "approval-required",
  routinesCeiling: "approval-required",
  providers: ["claudeAgent"],
  models: ["claude-*"],
  ownsProviderLaunch: true,
  telemetryExport: false,
};

describe("team rules view", () => {
  it("adds nothing without rules", () => {
    expect(teamRulesThreadNotice(undefined, "full-access")).toBeNull();
    expect(teamRulesProviderLock(undefined, "codex")).toBeNull();
    expect(teamRulesDecisionModelLock(undefined, "jev", "any")).toBeNull();
  });

  it("offers a one-click switch down for a chat above the ceiling", () => {
    const notice = teamRulesThreadNotice(active, "full-access");
    expect(notice).toMatchObject({
      kind: "above-ceiling",
      title: TEAM_RULES_ABOVE_LIMIT,
      switchTo: "approval-required",
      switchLabel: "Switch to Supervised",
    });
    expect(teamRulesThreadNotice(active, "approval-required")).toBeNull();
  });

  it("explains a hold with the error and no way to switch", () => {
    const notice = teamRulesThreadNotice(
      { status: "hold", issues: ["agents.ceiling: invalid"] },
      "approval-required",
    );
    expect(notice?.kind).toBe("hold");
    expect(notice?.description).toContain("agents.ceiling: invalid");
    expect(notice).not.toHaveProperty("switchTo");
  });

  it("locks provider launch when rules own it, pin it or leave the driver off the list", () => {
    expect(teamRulesProviderLock(active, "claudeAgent")).toBe("Set by Acme");
    const pinned: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      pinnedProviders: ["codex"],
    };
    expect(teamRulesProviderLock(pinned, "codex")).toBe("Set by Acme");
    expect(teamRulesProviderLock(pinned, "claudeAgent")).toBeNull();
    expect(teamRulesProviderLock({ status: "active", owner: "Acme" }, "codex")).toBeNull();
    expect(teamRulesProviderLock({ status: "hold" }, "codex")).toBeNull();
  });

  it("flags a decision model outside the list, never Off", () => {
    expect(teamRulesDecisionModelLock(active, "jev", "router")).toBe("Set by Acme");
    expect(teamRulesDecisionModelLock(active, "off", "")).toBeNull();
  });

  it("shows only the rows the rules set", () => {
    expect(teamRulesRows(active).map((row) => row.title)).toEqual([
      "Broadest permission",
      "Routines",
      "Approved providers",
      "Approved models",
      "Provider launch",
      "Telemetry export",
    ]);
    expect(teamRulesRows(active)[3]?.value).toContain("Fallback at a usage limit");
    expect(teamRulesRows({ status: "active", owner: "Acme" })).toEqual([]);
  });
});
