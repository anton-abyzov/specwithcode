import type { TeamRulesFile } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { teamRulesCompanion } from "./companion.ts";

const rules = (extra: Partial<TeamRulesFile>): TeamRulesFile => ({
  version: 1,
  owner: "Acme",
  ...extra,
});

describe("teamRulesCompanion", () => {
  it("prints nothing to enforce with no limits", () => {
    const out = teamRulesCompanion(rules({}));
    expect(JSON.parse(out.managedSettings)).toEqual({});
    expect(out.requirements).toBe("");
    expect(out.notes).toEqual([]);
  });

  it("turns off bypass for any ceiling below full access", () => {
    const out = teamRulesCompanion(rules({ agents: { ceiling: "auto" } }));
    expect(JSON.parse(out.managedSettings).permissions).toEqual({
      disableBypassPermissionsMode: "disable",
    });
    expect(out.requirements).toContain('allowed_approval_policies = ["untrusted", "on-request"]');
    expect(out.requirements).toContain('allowed_sandbox_modes = ["read-only", "workspace-write"]');
    expect(out.requirements).not.toContain("never");
    expect(out.requirements).not.toContain("danger-full-access");
  });

  it("turns off auto mode too below Auto, and says what Claude cannot forbid", () => {
    const out = teamRulesCompanion(rules({ agents: { ceiling: "approval-required" } }));
    expect(JSON.parse(out.managedSettings).permissions.disableAutoMode).toBe("disable");
    expect(out.notes.join(" ")).toContain("accepting edits");
  });

  it("does not limit full access", () => {
    const out = teamRulesCompanion(rules({ agents: { ceiling: "full-access" } }));
    expect(JSON.parse(out.managedSettings)).toEqual({});
    expect(out.requirements).toBe("");
  });

  it("copies exact models and connections and names what it left out", () => {
    const out = teamRulesCompanion(
      rules({
        ai: { models: ["claude-opus-5", "gpt-*"] },
        connections: { allow: ["github", "acme-*"] },
      }),
    );
    const settings = JSON.parse(out.managedSettings);
    expect(settings.availableModels).toEqual(["claude-opus-5"]);
    expect(settings.allowedMcpServers).toEqual([{ serverName: "github" }]);
    expect(out.notes.join(" ")).toContain("patterns");
    expect(out.notes.join(" ")).toContain("left out");
    expect(out.requirements).toContain('# [mcp_servers."github"]');
  });

  it("an empty connection list blocks every server in both", () => {
    const out = teamRulesCompanion(rules({ connections: { allow: [] } }));
    expect(JSON.parse(out.managedSettings).allowedMcpServers).toEqual([]);
    expect(out.requirements).toContain("[mcp_servers]");
  });

  it("names every rule with no equivalent", () => {
    const { notes } = teamRulesCompanion(
      rules({
        ai: { providers: ["codex"] },
        reach: { phones: false },
        tools: { chrome: false },
        telemetry: { export: false },
        updates: { automatic: false },
        zones: [{ remote: "github.com/a/*" }],
      }),
    );
    for (const key of ["ai.providers", "reach", "tools", "telemetry", "updates", "zones"]) {
      expect(notes.some((note) => note.startsWith(`${key}:`))).toBe(true);
    }
  });

  for (const pin of [
    { binaryPath: "/synthetic/claude" },
    { launchArgs: "--synthetic" },
    { launchArgs: "" },
  ]) {
    it(`reports unsupported Claude launch pin ${JSON.stringify(pin)}`, () => {
      const out = teamRulesCompanion(rules({ ai: { pin: { claudeAgent: pin } } }));
      expect(out.notes).toContain("ai.pin: only claudeAgent's environment has an equivalent here.");
      expect(JSON.parse(out.managedSettings)).toEqual({});
    });
  }

  it("preserves supported Claude environment pins without an unsupported notice", () => {
    const out = teamRulesCompanion(
      rules({ ai: { pin: { claudeAgent: { environment: { SYNTHETIC: "yes" } } } } }),
    );
    expect(JSON.parse(out.managedSettings).env).toEqual({ SYNTHETIC: "yes" });
    expect(out.notes).toEqual([]);
  });

  it("allows Codex no more than the app runs under Supervised", () => {
    const out = teamRulesCompanion(rules({ agents: { ceiling: "approval-required" } }));
    expect(out.requirements).toContain('allowed_approval_policies = ["untrusted"]');
    expect(out.requirements).toContain('allowed_sandbox_modes = ["read-only"]');
  });
});
