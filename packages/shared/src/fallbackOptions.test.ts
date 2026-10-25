import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeFallbackOptions, modelFamily, toggleExcludedModel } from "./fallbackOptions.ts";
import { resolveProviderFallback } from "./providerFallback.ts";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const later = "2026-10-24T15:00:00.000Z";

function provider(
  id: string,
  driver: string,
  used: number | null,
  models: ReadonlyArray<readonly [string, string]>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    ...(driver === "acpRegistry" && /^copilot(?:-|$)/.test(id)
      ? { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" }
      : {}),
    version: null,
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            windows: [
              {
                id: "five_hour",
                kind: "session" as const,
                label: "Session",
                usedPercent: used,
                resetsAt: later,
              },
            ],
          },
        }),
    ...over,
  };
}

const claude = provider("claudeAgent", "claudeAgent", 100, [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
]);
const codex = provider("codex", "codex", 40, [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-astra", "GPT-6 Astra"],
]);
const grok = provider("grok", "grok", 5, [["grok-4.7", "Grok 4.7"]]);
const copilot = provider("copilot", "acpRegistry", null, [["claude-opus-5.5", "Claude Opus 5.5"]]);
const gemini = provider(
  "acpRegistry_gemini",
  "acpRegistry",
  10,
  [["gemini-4-argon", "Gemini Argon 4"]],
  { auth: { status: "authenticated", type: "vertex" } },
);
const devin = provider("devin", "acpRegistry", null, [["devin-default", "Devin"]]);
const signedOut = provider("claude-2", "claudeAgent", null, [["claude-opus-5-5", "Opus 5.5"]], {
  auth: { status: "unauthenticated" },
});
const rule = {
  providerLimitFallbackModelSelection: null,
  providerLimitFallbackModels: [
    { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  ],
  providerLimitExcludedModels: [{ model: "grok-4-7" }],
};

const statusOf = (
  groups: ReturnType<typeof describeFallbackOptions>,
  instanceId: string,
  model: string,
) =>
  groups
    .flatMap((group) => group.options)
    .find(
      (option) => option.selection.instanceId === instanceId && option.selection.model === model,
    );

describe("modelFamily", () => {
  it("groups by model, not by the provider serving it", () => {
    expect(modelFamily({ slug: "claude-opus-5.5" })).toBe("claude");
    expect(modelFamily({ slug: "claude-fable-5-1" })).toBe("claude");
    expect(modelFamily({ slug: "gpt-6.1-sol" })).toBe("openai");
    expect(modelFamily({ slug: "gemini-4-argon" })).toBe("google");
    expect(modelFamily({ slug: "grok-4.7" })).toBe("xai");
    expect(modelFamily({ slug: "wander", name: "Meta Wander" })).toBe("meta");
    expect(modelFamily({ slug: "auto", name: "Auto" })).toBe("other");
  });
});

describe("describeFallbackOptions", () => {
  const groups = describeFallbackOptions({
    providers: [claude, codex, grok, copilot, gemini, devin, signedOut],
    currentInstanceId: claude.instanceId,
    currentModel: "claude-opus-5-5",
    rule,
    nowMs: now,
    belowPercent: 95,
  });

  it("lists and excludes custom models that can receive an automatic fallback", () => {
    const custom = {
      ...copilot,
      models: copilot.models.map((model) => ({ ...model, isCustom: true })),
    };
    const providers = [claude, custom];
    const capacityRule = { ...rule, defaultModelSelection: null };
    const input = {
      providers,
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: capacityRule,
      nowMs: now,
      anyReady: true,
    };
    const target = { instanceId: custom.instanceId, model: "claude-opus-5.5" };
    expect(resolveProviderFallback(input)).toEqual(target);
    expect(describeFallbackOptions(input).flatMap((group) => group.options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selection: target, status: "ready", excluded: false }),
      ]),
    );
    const excludedRule = {
      ...capacityRule,
      providerLimitExcludedModels: toggleExcludedModel(
        capacityRule.providerLimitExcludedModels,
        target.model,
      ),
    };
    expect(
      describeFallbackOptions({ ...input, rule: excludedRule }).flatMap((group) => group.options),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selection: target, status: "excluded", excluded: true }),
      ]),
    );
    expect(resolveProviderFallback({ ...input, rule: excludedRule })).toBeNull();
  });

  it("lists families in a fixed order, Copilot's Opus under Claude", () => {
    expect(groups.map((group) => group.family)).toEqual([
      "claude",
      "openai",
      "google",
      "xai",
      "other",
    ]);
    expect(groups[0]!.options.map((option) => option.provider.instanceId)).toContain("copilot");
  });

  it("says why each model can or cannot take a limited Claude thread", () => {
    expect(statusOf(groups, "claudeAgent", "claude-opus-5-5")?.status).toBe("current");
    expect(statusOf(groups, "claudeAgent", "claude-fable-5-1")?.status).toBe("full");
    expect(statusOf(groups, "codex", "gpt-6-astra")).toMatchObject({
      status: "ready",
      access: "usage-read",
      orderIndex: 0,
    });
    expect(statusOf(groups, "codex", "gpt-6.1-sol")?.orderIndex).toBe(1);
    expect(statusOf(groups, "grok", "grok-4.7")).toMatchObject({
      status: "excluded",
      excluded: true,
    });
    expect(statusOf(groups, "copilot", "claude-opus-5.5")).toMatchObject({
      status: "ready",
      access: "no-usage-reported",
    });
    expect(statusOf(groups, "acpRegistry_gemini", "gemini-4-argon")).toMatchObject({
      status: "never-automatic",
      access: "per-token",
    });
    expect(statusOf(groups, "devin", "devin-default")?.status).toBe("named-only");
    expect(statusOf(groups, "claude-2", "claude-opus-5-5")).toMatchObject({
      status: "signed-out",
      access: "unknown",
    });
  });

  it("shows a full model with its reset time", () => {
    const full = describeFallbackOptions({
      providers: [provider("codex", "codex", 97, [["gpt-6.1-sol", "GPT-6.1 Sol"]])],
      rule,
      nowMs: now,
      belowPercent: 95,
    });
    expect(statusOf(full, "codex", "gpt-6.1-sol")).toMatchObject({
      status: "full",
      resetAt: Date.parse(later),
      usedPercent: 97,
    });
  });

  it("marks a provider stopped on its limit without a reading as limited", () => {
    const limited = describeFallbackOptions({
      providers: [copilot],
      rule,
      nowMs: now,
      limitedInstanceIds: new Set(["copilot"]),
    });
    expect(statusOf(limited, "copilot", "claude-opus-5.5")?.status).toBe("limited");
  });
});

describe("toggleExcludedModel", () => {
  it("adds and removes a model on every provider, whatever the spelling", () => {
    const added = toggleExcludedModel([], "grok-4.7");
    expect(added).toEqual([{ model: "grok-4.7" }]);
    expect(toggleExcludedModel(added, "grok-4-7")).toEqual([]);
  });

  it("removes a provider-wide entry when toggled from one instance", () => {
    expect(
      toggleExcludedModel(
        [{ model: "claude-opus-5.5" }],
        "claude-opus-5.5",
        ProviderInstanceId.make("copilot"),
      ),
    ).toEqual([]);
  });
});
