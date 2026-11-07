import type { TeamRulesSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TEAM_RULES_ABOVE_LIMIT,
  TEAM_RULES_REPOSITORY_LABEL,
  teamRulesDecisionModelLock,
  teamRulesMachineLinkLock,
  teamRulesMachineLock,
  teamRulesOwnMachineView,
  teamRulesPeerMachineView,
  teamRulesProviderLock,
  teamRulesReachLock,
  teamRulesRows,
  teamRulesThreadNotice,
  teamRulesToolLock,
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

  it("locks no row without rules", () => {
    expect(teamRulesReachLock(undefined, "phones")).toBeNull();
    expect(teamRulesReachLock(undefined, "connect")).toBeNull();
    expect(teamRulesReachLock(undefined, "webhooks")).toBeNull();
    expect(teamRulesToolLock(undefined, "chrome")).toBeNull();
    expect(teamRulesToolLock(undefined, "google")).toBeNull();
    expect(teamRulesMachineLinkLock(undefined)).toBeNull();
    expect(teamRulesMachineLock(undefined, { fingerprint: undefined })).toBeNull();
    expect(teamRulesRows({ status: "active", owner: "Acme", reach: {}, tools: {} })).toEqual([]);
  });

  it("names the owner and the refusal on a path or tool the rules turn off", () => {
    const summary: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      reach: { phones: false, webhooks: true },
      tools: { computerUse: false },
    };
    expect(teamRulesReachLock(summary, "phones")).toEqual({
      setBy: "Set by Acme",
      message: "Acme's rules turn off phones on this machine.",
    });
    expect(teamRulesReachLock(summary, "webhooks")).toBeNull();
    expect(teamRulesToolLock(summary, "computerUse")?.setBy).toBe("Set by Acme");
    expect(teamRulesToolLock(summary, "telegram")).toBeNull();
  });

  it("refuses what is new during a hold, because the file could be hiding a false", () => {
    const hold: TeamRulesSummary = { status: "hold", issues: ["bad"] };
    expect(teamRulesReachLock(hold, "connect")?.setBy).toBe("Set by your team");
    expect(teamRulesToolLock(hold, "chrome")).not.toBeNull();
    expect(teamRulesMachineLinkLock(hold)).not.toBeNull();
  });

  it("decides machines as a whole for none and per peer for same-rules", () => {
    const none: TeamRulesSummary = { status: "active", owner: "Acme", reach: { machines: "none" } };
    expect(teamRulesMachineLinkLock(none)).not.toBeNull();

    const same: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      fingerprint: "aaaaaaaaaaaa",
      reach: { machines: "same-rules" },
    };
    expect(teamRulesMachineLinkLock(same)).toBeNull();
    expect(teamRulesMachineLock(same, { fingerprint: "aaaaaaaaaaaa" })).toBeNull();
    expect(
      teamRulesMachineLock(same, { label: "Laptop", fingerprint: undefined })?.message,
    ).toContain("Laptop has different rules");
  });

  it("shows reach and tools only when the rules restrict them", () => {
    const titles = teamRulesRows({
      status: "active",
      owner: "Acme",
      reach: { phones: false, connect: true, machines: "same-rules", webhooks: false },
      tools: { chrome: false, computerUse: true, google: false, telegram: false },
    }).map((row) => row.title);
    expect(titles).toEqual([
      "Phones",
      "Other machines",
      "Webhooks",
      "Chrome",
      "Google account",
      "Telegram",
    ]);
    expect(teamRulesRows({ status: "active", reach: { machines: "any" } })).toEqual([]);
  });

  it("applies a carried ceiling to a chat, even with no rules here", () => {
    const carried = { ceiling: "approval-required", owner: "Acme" } as never;
    const notice = teamRulesThreadNotice(undefined, "full-access", carried);
    expect(notice).toMatchObject({
      kind: "above-ceiling",
      switchTo: "approval-required",
      switchLabel: "Switch to Supervised",
    });
    expect(notice?.description).toContain("came from a machine where Acme's rules");
    expect(teamRulesThreadNotice(undefined, "approval-required", carried)).toBeNull();
  });

  it("switches a chat down to the stricter of the local and carried limits", () => {
    const carried = { ceiling: "approval-required", owner: "Acme" } as never;
    const local: TeamRulesSummary = {
      status: "active",
      owner: "Beta",
      ceiling: "auto-accept-edits",
    };
    expect(teamRulesThreadNotice(local, "full-access", carried)).toMatchObject({
      switchTo: "approval-required",
    });
  });

  it("flags each way a peer can differ", () => {
    const own: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      fingerprint: "aaaaaaaaaaaa",
      reach: { machines: "same-rules" },
    };
    expect(
      teamRulesPeerMachineView(own, { status: "active", fingerprint: "aaaaaaaaaaaa" }, true),
    ).toMatchObject({ status: "same", label: "Same rules", fingerprint: "aaaaaaaa", detail: null });
    expect(
      teamRulesPeerMachineView(own, { status: "active", fingerprint: "bbbbbbbbbbbb" }, true),
    ).toMatchObject({
      status: "different",
      label: "Different rules",
      fingerprint: "bbbbbbbb",
      detail: "Work refused.",
    });
    expect(teamRulesPeerMachineView(own, undefined, true)).toMatchObject({
      status: "different",
      label: "No rules",
      tone: "warning",
    });
    expect(teamRulesPeerMachineView(own, { status: "hold" }, true)).toMatchObject({
      status: "hold",
      label: "On hold",
    });
    expect(teamRulesPeerMachineView(own, undefined, false)).toMatchObject({
      status: "unknown",
      label: "Rules unknown",
    });
  });

  it("does not call a silent machine rule-free, and refuses nothing without a reach rule", () => {
    expect(teamRulesPeerMachineView(undefined, undefined, false).status).toBe("unknown");
    expect(teamRulesPeerMachineView(undefined, undefined, true)).toMatchObject({
      status: "none",
      label: "No rules",
      detail: null,
    });
    expect(
      teamRulesPeerMachineView(undefined, { status: "active", fingerprint: "bbbb" }, true),
    ).toMatchObject({ status: "different", detail: null });
  });

  it("describes this machine's own rules", () => {
    expect(teamRulesOwnMachineView(undefined).label).toBe("No rules");
    expect(teamRulesOwnMachineView({ status: "hold" }).label).toBe("On hold");
    expect(
      teamRulesOwnMachineView({ status: "active", fingerprint: "aaaaaaaaaaaa" }).fingerprint,
    ).toBe("aaaaaaaa");
  });

  it("names the repository that set a limit and says what it is", () => {
    const summary: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      ceiling: "approval-required",
      ceilingBy: { source: "repository", owner: "Payments" },
      sources: [{ source: "repository", owner: "Payments" }],
    };
    const notice = teamRulesThreadNotice(summary, "full-access");
    expect(notice?.description).toContain("Payments's repository rules");
    expect(notice?.description).toContain(TEAM_RULES_REPOSITORY_LABEL);
    expect(teamRulesRows(summary).at(-1)?.value).toContain(TEAM_RULES_REPOSITORY_LABEL);
  });

  it("keeps a zone's limit apart from a repository's", () => {
    const by = { source: "zone", owner: "Acme" } as const;
    const summary: TeamRulesSummary = {
      status: "active",
      owner: "Acme",
      ceiling: "approval-required",
      ceilingBy: by,
      sources: [by],
    };
    const notice = teamRulesThreadNotice(summary, "full-access");
    expect(notice?.description).toContain("Acme's rules for this repository");
    expect(notice?.description).not.toContain(TEAM_RULES_REPOSITORY_LABEL);
  });

  it("pauses one repository without saying the machine is broken", () => {
    const notice = teamRulesThreadNotice(
      { status: "hold", holdScope: "repository", owner: "Payments", issues: ["bad"] },
      "approval-required",
    );
    expect(notice?.title).toBe("Agents are paused in this repository");
    expect(notice?.description).toContain(TEAM_RULES_REPOSITORY_LABEL);
    const zone = teamRulesThreadNotice(
      { status: "hold", holdScope: "zone", owner: "Acme", issues: ["no remotes"] },
      "approval-required",
    );
    expect(zone?.title).toBe("Agents are paused in this folder");
  });

  it("lists connections and updates only when the rules set them", () => {
    const rows = teamRulesRows({
      status: "active",
      owner: "Acme",
      connections: ["github"],
      updates: { automatic: false, feed: "https://updates.acme.example" },
    }).map((row) => row.title);
    expect(rows).toEqual(["Approved connections", "Automatic updates", "Update source"]);
    expect(teamRulesRows({ status: "active", owner: "Acme" })).toEqual([]);
  });
});
