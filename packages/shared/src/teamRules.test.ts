import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderFallback } from "./providerFallback.ts";
import {
  parseTeamRulesText,
  teamRulesExportAllowed,
  teamRulesExportAllowedByText,
  teamRulesFilterProviders,
  summarizeTeamRules,
  TEAM_RULES_NONE,
  teamRulesAllowsFullAccessApprovals,
  teamRulesClampMode,
  teamRulesInstanceConfig,
  teamRulesModeRefusal,
  teamRulesOwnsProviderLaunch,
  teamRulesRoutineRefusal,
  teamRulesSelectionRefusal,
  teamRulesSettingsRefusal,
  type TeamRulesState,
  teamRulesTurnRefusal,
  canonicalTeamRules,
} from "./teamRules.ts";

const active = (body: Record<string, unknown>): TeamRulesState => {
  const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Acme", ...body }));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return { status: "active", rules: parsed.rules, fingerprint: "3a9f", warnings: parsed.warnings };
};
const hold: TeamRulesState = { status: "hold", issues: ["broken"], owner: "Acme" };

describe("parseTeamRulesText", () => {
  it("accepts the full shape and flags later-phase sections as not enforced", () => {
    const parsed = parseTeamRulesText(
      JSON.stringify({
        version: 1,
        owner: "Acme Engineering",
        contact: "https://it.acme.example/ai",
        ai: {
          providers: ["claudeAgent", "codex"],
          models: ["claude-*", "gpt-*"],
          pin: { claudeAgent: { environment: { CLAUDE_CODE_USE_BEDROCK: "1" } } },
        },
        agents: { ceiling: "auto-accept-edits", routines: "approval-required" },
        reach: { phones: false, connect: false, machines: "same-rules", webhooks: false },
        tools: { chrome: false, computerUse: false, google: false, telegram: false },
        connections: { allow: ["github"] },
        updates: { automatic: true, feed: "https://updates.acme.example/swc/" },
        zones: [{ remote: "github.com/acme/payments*", agents: { ceiling: "approval-required" } }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.filter((line) => line.includes("does not enforce"))).toHaveLength(5);
  });

  it.each([
    ["invalid JSON", "{", /Not valid JSON/],
    ["a wrong version", '{"version":2,"owner":"Acme"}', /version/],
    ["a missing owner", '{"version":1}', /owner/],
    ["an unknown top-level key", '{"version":1,"owner":"A","agentz":{}}', /agentz/],
    ["an unknown nested key", '{"version":1,"owner":"A","agents":{"cieling":"auto"}}', /cieling/],
    ["an unknown mode", '{"version":1,"owner":"A","agents":{"ceiling":"yolo"}}', /ceiling/],
  ])("refuses %s", (_label, text, pattern) => {
    const parsed = parseTeamRulesText(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("\n")).toMatch(pattern);
  });

  it("refuses a credential in a pin and keeps the owner for the hold message", () => {
    const parsed = parseTeamRulesText(
      JSON.stringify({
        version: 1,
        owner: "Acme",
        ai: { pin: { claudeAgent: { environment: { ANTHROPIC_API_KEY: "value-not-shown" } } } },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.owner).toBe("Acme");
    expect(parsed.issues.join("\n")).toMatch(/ANTHROPIC_API_KEY.*credential/);
    expect(parsed.issues.join("\n")).not.toContain("value-not-shown");
  });

  it("refuses an oversized file", () => {
    const parsed = parseTeamRulesText(" ".repeat(300 * 1024));
    expect(parsed.ok).toBe(false);
  });

  it("warns about a provider this version does not know", () => {
    const parsed = parseTeamRulesText('{"version":1,"owner":"A","ai":{"providers":["claude"]}}');
    expect(parsed.ok && parsed.warnings.join()).toMatch(/"claude"/);
  });

  it("fingerprints ignore key order", () => {
    const left = active({ agents: { ceiling: "auto", routines: "auto" } });
    const right = active({ agents: { routines: "auto", ceiling: "auto" } });
    if (left.status !== "active" || right.status !== "active") throw new Error("not active");
    expect(canonicalTeamRules(left.rules)).toBe(canonicalTeamRules(right.rules));
  });
});

describe("ceiling", () => {
  const rules = active({ agents: { ceiling: "auto-accept-edits", routines: "approval-required" } });

  it("allows up to the ceiling and refuses above it with the allowed mode", () => {
    expect(teamRulesModeRefusal(rules, "approval-required")).toBeNull();
    expect(teamRulesModeRefusal(rules, "auto-accept-edits")).toBeNull();
    const refused = teamRulesModeRefusal(rules, "full-access");
    expect(refused?.reason).toBe("ceiling");
    expect(refused?.allowedMode).toBe("auto-accept-edits");
    expect(refused?.message).toContain("Acme");
  });

  it("holds routines to the tighter limit", () => {
    expect(teamRulesRoutineRefusal(rules, "approval-required")).toBeNull();
    expect(teamRulesRoutineRefusal(rules, "auto-accept-edits")?.reason).toBe("routine-ceiling");
    const loose = active({ agents: { ceiling: "approval-required", routines: "full-access" } });
    expect(teamRulesRoutineRefusal(loose, "auto")?.allowedMode).toBe("approval-required");
  });

  it("stops full access approvals below full access and on hold, not otherwise", () => {
    expect(teamRulesAllowsFullAccessApprovals(rules)).toBe(false);
    expect(teamRulesAllowsFullAccessApprovals(hold)).toBe(false);
    expect(teamRulesAllowsFullAccessApprovals(TEAM_RULES_NONE)).toBe(true);
    expect(teamRulesAllowsFullAccessApprovals(active({ agents: { ceiling: "full-access" } }))).toBe(
      true,
    );
  });

  it("offers the broadest allowed mode as the switch down", () => {
    expect(teamRulesClampMode(rules, "full-access")).toBe("auto-accept-edits");
    expect(teamRulesClampMode(rules, "approval-required")).toBe("approval-required");
  });
});

describe("allowlist", () => {
  const rules = active({
    ai: { providers: ["claudeAgent", "codex"], models: ["claude-*", "GPT-*"] },
  });

  it("checks the provider and the model", () => {
    expect(
      teamRulesSelectionRefusal(rules, { driver: "claudeAgent", model: "claude-opus" }),
    ).toBeNull();
    expect(teamRulesSelectionRefusal(rules, { driver: "codex", model: "gpt-5.5" })).toBeNull();
    expect(
      teamRulesSelectionRefusal(rules, { driver: "acpRegistry", model: "claude-opus" })?.reason,
    ).toBe("provider");
    expect(teamRulesSelectionRefusal(rules, { driver: "codex", model: "o3" })?.reason).toBe(
      "model",
    );
  });

  it("treats pattern text literally apart from the wildcard", () => {
    const dotted = active({ ai: { models: ["gpt-5.5"] } });
    expect(teamRulesSelectionRefusal(dotted, { driver: "codex", model: "gpt-5x5" })?.reason).toBe(
      "model",
    );
  });
});

describe("turns", () => {
  it("holds everything on a broken file and passes everything with no file", () => {
    const turn = { runtimeMode: "approval-required", driver: "codex", model: "gpt-5.5" } as const;
    expect(teamRulesTurnRefusal(hold, turn)?.reason).toBe("hold");
    expect(teamRulesTurnRefusal(TEAM_RULES_NONE, turn)).toBeNull();
  });
});

describe("instance ownership", () => {
  const entry = {
    driver: "claudeAgent",
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: "https://elsewhere.example", sensitive: false },
    ],
    config: {
      launchArgs: "--dangerously-skip-permissions",
      binaryPath: "/tmp/fake",
      homePath: "~/.claude",
    },
  } as unknown as ProviderInstanceConfig;

  it("leaves an instance untouched with no rules or a Full access ceiling", () => {
    expect(teamRulesInstanceConfig(TEAM_RULES_NONE, entry)).toBe(entry);
    expect(teamRulesInstanceConfig(active({ agents: { ceiling: "full-access" } }), entry)).toBe(
      entry,
    );
  });

  it("drops launch args, environment and binary path under a ceiling", () => {
    const shaped = teamRulesInstanceConfig(active({ agents: { ceiling: "auto" } }), entry);
    expect(shaped.environment).toBeUndefined();
    expect(shaped.config).toEqual({ homePath: "~/.claude" });
  });

  it("takes launch values from a pin and replaces the instance environment", () => {
    const rules = active({
      ai: {
        pin: {
          claudeAgent: {
            environment: { CLAUDE_CODE_USE_BEDROCK: "1" },
            launchArgs: "--chrome",
            binaryPath: "/opt/acme/claude",
          },
        },
      },
    });
    expect(teamRulesOwnsProviderLaunch(rules, "codex")).toBe(false);
    const shaped = teamRulesInstanceConfig(rules, entry);
    expect(shaped.environment?.map(({ name }) => name)).toEqual(["CLAUDE_CODE_USE_BEDROCK"]);
    expect(shaped.config).toEqual({
      homePath: "~/.claude",
      launchArgs: "--chrome",
      binaryPath: "/opt/acme/claude",
    });
  });

  it("disables a driver outside the list, the ACP registry included", () => {
    const rules = active({ ai: { providers: ["codex"] } });
    const acp = {
      driver: "acpRegistry",
      config: { source: "registry" },
    } as unknown as ProviderInstanceConfig;
    expect(teamRulesInstanceConfig(rules, acp).enabled).toBe(false);
    const codex = { driver: "codex" } as unknown as ProviderInstanceConfig;
    expect(teamRulesInstanceConfig(rules, codex).enabled).toBeUndefined();
  });
});

describe("launch ownership", () => {
  it("covers an allowlist, because --model or an endpoint could leave the list", () => {
    const entry = {
      driver: "opencode",
      config: { serverUrl: "https://elsewhere.example", binaryPath: "/tmp/o", homePath: "~/o" },
    } as unknown as ProviderInstanceConfig;
    const shaped = teamRulesInstanceConfig(active({ ai: { models: ["gpt-*"] } }), entry);
    expect(shaped.config).toEqual({ homePath: "~/o" });
    expect(teamRulesOwnsProviderLaunch(active({ ai: { providers: ["codex"] } }), "codex")).toBe(
      true,
    );
    expect(teamRulesOwnsProviderLaunch(active({ telemetry: { export: false } }), "codex")).toBe(
      false,
    );
  });

  it("refuses a pin whose flags would break the ceiling", () => {
    const parsed = parseTeamRulesText(
      JSON.stringify({
        version: 1,
        owner: "Acme",
        agents: { ceiling: "auto" },
        ai: { pin: { claudeAgent: { launchArgs: "--chrome --dangerously-skip-permissions" } } },
      }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("fallback under an allowlist", () => {
  const provider = (driver: string, instanceId: string, models: ReadonlyArray<string>) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: models.map((slug) => ({ slug, name: slug, isCustom: false })),
      slashCommands: [],
      skills: [],
      checkedAt: "2026-11-02T00:00:00.000Z",
      version: "1",
    }) as never;
  const providers = [
    provider("claudeAgent", "claudeAgent", ["claude-opus"]),
    provider("codex", "codex", ["gpt-5.5", "o3"]),
    provider("acpRegistry", "acpRegistry_gemini", ["gemini-3"]),
  ];
  const rule = {
    providerLimitFallbackModelSelection: {
      instanceId: ProviderInstanceId.make("acpRegistry_gemini"),
      model: "gemini-3",
    },
    providerLimitFallbackModels: [{ instanceId: ProviderInstanceId.make("codex"), model: "o3" }],
    providerLimitFallbackListOnly: false,
    providerLimitExcludedModels: [],
    defaultModelSelection: null,
    defaultModelProviders: [],
  } as never;
  const resolve = (state: TeamRulesState, currentProviders = providers) =>
    resolveProviderFallback({
      providers: teamRulesFilterProviders(state, currentProviders as never) as never,
      currentInstanceId: ProviderInstanceId.make("claudeAgent"),
      currentModel: "claude-opus",
      rule,
      nowMs: 0,
      anyReady: true,
    });

  it("skips named entries and any-ready picks outside the list", () => {
    const narrowed = resolve(
      active({ ai: { providers: ["claudeAgent", "codex"], models: ["claude-*", "gpt-*"] } }),
    );
    expect(narrowed?.model).toBe("gpt-5.5");
  });

  it("stops with nothing when no approved model is left", () => {
    expect(resolve(active({ ai: { providers: ["claudeAgent"] } }))).toBeNull();
  });

  it("disables a provider off the list and keeps its neighbours", () => {
    const filtered = teamRulesFilterProviders(
      active({ ai: { providers: ["codex"], models: ["gpt-*"] } }),
      providers as never,
    ) as ReadonlyArray<{
      driver: string;
      enabled: boolean;
      models: ReadonlyArray<{ slug: string }>;
    }>;
    expect(filtered.find(({ driver }) => driver === "acpRegistry")).toMatchObject({
      enabled: false,
      models: [],
    });
    expect(
      filtered.find(({ driver }) => driver === "codex")?.models.map(({ slug }) => slug),
    ).toEqual(["gpt-5.5"]);
  });

  it("leaves providers alone with no rules", () => {
    expect(teamRulesFilterProviders(TEAM_RULES_NONE, providers as never)).toBe(providers);
  });
});

describe("settings writes", () => {
  const base = DEFAULT_SERVER_SETTINGS;
  const rules = active({
    agents: { ceiling: "auto-accept-edits" },
    ai: { providers: ["claudeAgent"], models: ["claude-*"] },
    telemetry: { export: false },
  });

  it("refuses raising the default mode, but not an unrelated save over a stale value", () => {
    const stale = { ...base, defaultRuntimeMode: "full-access" as const };
    expect(teamRulesSettingsRefusal(rules, base, stale)?.reason).toBe("ceiling");
    expect(
      teamRulesSettingsRefusal(rules, stale, { ...stale, agentInstructions: "changed" }),
    ).toBeNull();
  });

  it("refuses a project override above the ceiling", () => {
    const next = {
      ...base,
      projectSettingsOverrides: { p1: { defaultRuntimeMode: "full-access" } },
    } as unknown as typeof base;
    expect(teamRulesSettingsRefusal(rules, base, next)?.reason).toBe("ceiling");
  });

  it("refuses adding an unapproved fallback model", () => {
    const next = {
      ...base,
      providerLimitFallbackModels: [
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      ],
    } as unknown as typeof base;
    expect(teamRulesSettingsRefusal(rules, base, next)?.reason).toBe("provider");
  });

  it("refuses changing a provider's launch args under a ceiling", () => {
    const next = {
      ...base,
      providerInstances: {
        claudeAgent_2: {
          driver: "claudeAgent",
          config: { launchArgs: "--dangerously-skip-permissions" },
        },
      },
    } as unknown as typeof base;
    expect(teamRulesSettingsRefusal(rules, base, next)?.reason).toBe("provider-launch");
  });

  it("refuses setting an OTLP URL but allows clearing one", () => {
    const set = {
      ...base,
      observability: { ...base.observability, otlpTracesUrl: "https://t.example" },
    };
    expect(teamRulesSettingsRefusal(rules, base, set)?.reason).toBe("telemetry");
    expect(teamRulesSettingsRefusal(rules, set, base)).toBeNull();
  });

  it("owns an ACP agent's command and arguments", () => {
    const owned = active({ agents: { ceiling: "approval-required" } });
    const entry = {
      driver: "acpRegistry",
      config: { source: "local", commandPath: "/tmp/agent", commandArgs: ["--yolo"] },
    } as never;
    expect(teamRulesInstanceConfig(owned, entry).config).toEqual({ source: "local" });
    const next = {
      ...base,
      providerInstances: { acp: entry },
    } as never;
    expect(teamRulesSettingsRefusal(owned, base, next)?.reason).toBe("provider-launch");
  });

  it("lets a default instance be saved with its driver's existing launch values", () => {
    const owned = active({ ai: { providers: ["codex"] } });
    const current = {
      ...base,
      providerInstances: {},
      providers: { ...base.providers, codex: { ...base.providers.codex, binaryPath: "codex" } },
    } as never;
    const write = (config: Record<string, unknown>) =>
      ({
        ...base,
        providerInstances: { codex: { driver: "codex", enabled: false, config } },
      }) as never;
    expect(teamRulesSettingsRefusal(owned, current, write({ binaryPath: "codex" }))).toBeNull();
    expect(teamRulesSettingsRefusal(owned, current, write({}))).toBeNull();
    expect(
      teamRulesSettingsRefusal(owned, current, write({ binaryPath: "/tmp/other" }))?.reason,
    ).toBe("provider-launch");
    expect(teamRulesSettingsRefusal(owned, current, write({ launchArgs: "--yolo" }))?.reason).toBe(
      "provider-launch",
    );
  });

  it("does not quote the file in a JSON error", () => {
    const result = parseTeamRulesText('{"owner": sk-secret-value}');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("treats telemetry export as off when a broken file could be hiding it", () => {
    expect(teamRulesExportAllowed(TEAM_RULES_NONE)).toBe(true);
    expect(teamRulesExportAllowed({ status: "hold", issues: ["x"] })).toBe(false);
    expect(teamRulesExportAllowedByText("{")).toBe(false);
    expect(
      teamRulesExportAllowedByText(
        JSON.stringify({ version: 1, owner: "Acme", telemetry: { export: false } }),
      ),
    ).toBe(false);
    expect(teamRulesExportAllowedByText(JSON.stringify({ version: 1, owner: "Acme" }))).toBe(true);
  });

  it("lets everything through with no rules", () => {
    const next = { ...base, defaultRuntimeMode: "full-access" as const };
    expect(teamRulesSettingsRefusal(TEAM_RULES_NONE, base, next)).toBeNull();
  });
});

describe("summary", () => {
  it("is absent with no rules and never carries pinned values", () => {
    expect(summarizeTeamRules(TEAM_RULES_NONE)).toBeUndefined();
    const summary = summarizeTeamRules(
      active({
        ai: { pin: { claudeAgent: { environment: { AWS_PROFILE: "acme-secret-profile" } } } },
      }),
    );
    expect(summary?.pinnedProviders).toEqual(["claudeAgent"]);
    expect(JSON.stringify(summary)).not.toContain("acme-secret-profile");
  });

  it("reports the hold with its issues", () => {
    expect(summarizeTeamRules(hold)).toMatchObject({
      status: "hold",
      owner: "Acme",
      issues: ["broken"],
    });
  });
});
