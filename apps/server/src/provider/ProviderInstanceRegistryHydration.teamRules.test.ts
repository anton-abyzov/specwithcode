import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@specweave-studio/contracts";
import { TEAM_RULES_NONE, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import { describe, expect, it } from "vite-plus/test";

import {
  desiredInstances,
  deriveProviderInstanceConfigMap,
  withTeamRules,
} from "./ProviderInstanceRegistryHydration.ts";

const active = (body: object): TeamRulesState => ({
  status: "active",
  rules: { version: 1, owner: "Acme", ...body },
  fingerprint: "3a9f",
  warnings: [],
});

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    claudeAgent_work: {
      driver: "claudeAgent",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false },
      ],
      config: { launchArgs: "--dangerously-skip-permissions", binaryPath: "/tmp/claude" },
    },
    acpRegistry_agent: { driver: "acpRegistry", config: { source: "registry" } },
  },
} as unknown as ServerSettings;

describe("desiredInstances", () => {
  it("changes nothing during a hold, so a typo revives nothing", () => {
    expect(desiredInstances({ status: "hold", issues: ["broken"] }, settings)).toBeNull();
  });

  it("follows the rules otherwise", () => {
    expect(desiredInstances(TEAM_RULES_NONE, settings)).toEqual(
      deriveProviderInstanceConfigMap(settings),
    );
  });
});

describe("withTeamRules", () => {
  it("changes nothing with no rules", () => {
    const map = deriveProviderInstanceConfigMap(settings);
    expect(withTeamRules(TEAM_RULES_NONE, map)).toBe(map);
  });

  it("removes launch flags and redirects under a ceiling, built-in instances included", () => {
    const map = withTeamRules(
      active({ agents: { ceiling: "auto-accept-edits" } }),
      deriveProviderInstanceConfigMap(settings),
    );
    const work = map["claudeAgent_work" as keyof typeof map]!;
    expect(work.environment).toBeUndefined();
    expect(work.config).toEqual({});
  });

  it("starts nothing when the machine starts on a hold", () => {
    const entries = Object.values(
      withTeamRules({ status: "hold", issues: ["version: expected 1"] }, {
        acp: { driver: "acpRegistry", config: { source: "local", commandPath: "/tmp/agent" } },
        codex: { driver: "codex", config: {} },
      } as never),
    );
    expect(entries.map((entry) => entry.enabled)).toEqual([false, false]);
  });

  it("stops the ACP registry unless it is listed", () => {
    const map = deriveProviderInstanceConfigMap(settings);
    const off = withTeamRules(active({ ai: { providers: ["claudeAgent"] } }), map);
    expect(off["acpRegistry_agent" as keyof typeof off]!.enabled).toBe(false);
    const on = withTeamRules(active({ ai: { providers: ["acpRegistry"] } }), map);
    expect(on["acpRegistry_agent" as keyof typeof on]!.enabled).not.toBe(false);
  });

  it("gives a pinned provider only the pinned environment", () => {
    const map = withTeamRules(
      active({
        ai: { pin: { claudeAgent: { environment: { CLAUDE_CODE_USE_BEDROCK: "1" } } } },
      }),
      deriveProviderInstanceConfigMap(settings),
    );
    expect(map["claudeAgent_work" as keyof typeof map]!.environment).toEqual([
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false },
    ]);
  });
});
