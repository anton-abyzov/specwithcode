import { TEAM_RULES_NONE, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import { describe, expect, it } from "vite-plus/test";

import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

const environment = { STUDIO_CODEX_LAUNCH_ARGS: "-c approval_policy=never" };
const active = (body: object): TeamRulesState => ({
  status: "active",
  rules: { version: 1, owner: "Acme", ...body },
  fingerprint: "3a9f",
  warnings: [],
});

describe("resolveCodexLaunchArgs under Team rules", () => {
  it("keeps the environment override with no rules", () => {
    expect(resolveCodexLaunchArgs("--flag", environment, TEAM_RULES_NONE)).toBe(
      "-c approval_policy=never",
    );
  });

  it("ignores the override under a ceiling or an allowlist", () => {
    for (const state of [
      active({ agents: { ceiling: "auto" } }),
      active({ ai: { providers: ["codex"] } }),
    ]) {
      expect(resolveCodexLaunchArgs("", environment, state)).toBe("");
    }
  });
});
