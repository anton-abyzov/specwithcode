import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chainNamedByPerson, effectiveFallbackOrder } from "./modelTiers.ts";
import {
  defaultTrackSelections,
  effectiveModelLanes,
  isFreeTrackModel,
  isMakerOf,
  providerHomeFamily,
  providersForModel,
} from "./modelTracks.ts";
import { describeFallbackOrder, resolveProviderFallback } from "./providerFallback.ts";

const now = Date.parse("2026-11-14T18:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-11-21T14:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-2"], 13);
const codexFree = provider("codex", "codex", ["gpt-6-luna"], 20);
const codexPaid = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], 20);
const copilot = provider(
  "copilot",
  "acpRegistry",
  ["claude-opus-5.5", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gemini-4-carbon"],
  null,
  { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" },
);
const muse = provider("muse", "muse", ["muse-wonder-1.0"], 5);
const cursor = provider("cursor", "cursor", ["claude-fable-5-2"], 40);

const noRule = {
  providerLimitFallbackModelSelection: null,
  defaultModelSelection: null,
  modelLanes: null,
};

describe("the maker of a model", () => {
  it("is the vendor's own driver, never a reseller", () => {
    expect(providerHomeFamily(claude)).toBe("claude");
    expect(providerHomeFamily(codexPaid)).toBe("openai");
    expect(providerHomeFamily(muse)).toBe("meta");
    expect(providerHomeFamily(copilot)).toBeNull();
    expect(providerHomeFamily(provider("acpRegistry_gemini", "acpRegistry", [], null))).toBe(
      "google",
    );
    expect(isMakerOf(claude, { slug: "claude-opus-5-5" })).toBe(true);
    expect(isMakerOf(copilot, { slug: "claude-opus-5.5" })).toBe(false);
  });
});

describe("providersForModel", () => {
  it("puts the maker first, then the provider with the most room", () => {
    const roomy = provider("devin", "acpRegistry", ["claude-fable-5-2"], 10);
    const used = (candidate: Pick<ServerProvider, "instanceId">) =>
      candidate.instanceId === roomy.instanceId ? 10 : 40;
    expect(
      providersForModel({
        providers: [cursor, roomy, claude],
        model: { slug: "claude-fable-5-2" },
        usedPercent: used,
      }).map((choice) => choice.provider.instanceId),
    ).toEqual(["claudeAgent", "devin", "cursor"]);
  });

  it("keeps the person's own provider order ahead of the maker", () => {
    expect(
      providersForModel({
        providers: [claude, cursor],
        model: { slug: "claude-fable-5-2" },
        order: [cursor.instanceId],
      }).map((choice) => choice.provider.instanceId),
    ).toEqual(["cursor", "claudeAgent"]);
  });

  it("spells the model as each provider does and skips disabled providers", () => {
    expect(
      providersForModel({
        providers: [copilot, { ...claude, enabled: false }],
        model: { slug: "claude-opus-5-5" },
      }),
    ).toEqual([{ provider: copilot, slug: "claude-opus-5.5" }]);
  });
});

describe("built-in tracks", () => {
  it("fit each model to the best provider that lists it", () => {
    const providers = [claude, codexFree, copilot, muse];
    expect(defaultTrackSelections("daily", providers)).toEqual([
      sel("claudeAgent", "claude-opus-5-5"),
      // Codex is on a free plan here, so Sol runs through Copilot.
      sel("copilot", "gpt-6.1-sol"),
      sel("muse", "muse-wonder-1.0"),
      sel("codex", "gpt-6-luna"),
    ]);
    expect(defaultTrackSelections("complex", providers)).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
      sel("copilot", "gpt-6-astra"),
    ]);
    expect(defaultTrackSelections("review", providers)).toEqual([
      sel("copilot", "gpt-6.1-sol"),
      sel("muse", "muse-wonder-1.0"),
      sel("copilot", "gemini-4-carbon"),
    ]);
  });

  it("leave out a model nothing on this machine lists", () => {
    expect(defaultTrackSelections("complex", [claude])).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
    ]);
    expect(defaultTrackSelections("daily", [])).toEqual([]);
  });

  it("give way to a saved track, one track at a time", () => {
    const saved = { routine: [sel("muse", "muse-wonder-1.0")], complex: [] };
    const effective = effectiveModelLanes(saved, [claude, codexPaid, muse]);
    expect(effective.builtIn).toEqual({ routine: false, complex: true });
    expect(effective.lanes.routine).toEqual(saved.routine);
    expect(effective.lanes.complex).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
      sel("codex", "gpt-6-astra"),
    ]);
  });

  it("mark GPT-6 Luna as the free tail under any spelling", () => {
    expect(isFreeTrackModel({ slug: "gpt-6-luna" })).toBe(true);
    expect(isFreeTrackModel({ slug: "GPT-6-Luna" })).toBe(true);
    expect(isFreeTrackModel({ slug: "gpt-6.1-sol" })).toBe(false);
  });
});

describe("the chain a limited thread follows with nothing saved", () => {
  const providers = [claude, codexPaid, copilot, muse];

  it("walks Daily, then Complex, for a Daily thread", () => {
    const chain = effectiveFallbackOrder(noRule, "claude-opus-5-5", providers);
    expect(chain.fromTiers).toBe(true);
    expect(chainNamedByPerson(chain)).toBe(false);
    expect(chain.order.map((entry) => `${entry.instanceId}:${entry.model}`)).toEqual([
      "claudeAgent:claude-opus-5-5",
      "copilot:claude-opus-5.5",
      "codex:gpt-6.1-sol",
      "copilot:gpt-6.1-sol",
      "muse:muse-wonder-1.0",
      "codex:gpt-6-luna",
      "copilot:gpt-6-luna",
      "claudeAgent:claude-fable-5-2",
      "codex:gpt-6-astra",
      "copilot:gpt-6-astra",
    ]);
  });

  it("never offers a Complex thread the free tail", () => {
    const chain = effectiveFallbackOrder(noRule, "claude-fable-5-2", providers);
    const models = chain.order.map((entry) => entry.model);
    expect(models.slice(0, 2)).toEqual(["claude-fable-5-2", "gpt-6-astra"]);
    expect(models).not.toContain("gpt-6-luna");
    expect(models).toContain("claude-opus-5-5");
  });

  it("moves a limited Opus thread to GPT-6.1 Sol on Codex, where a reading shows room", () => {
    expect(
      resolveProviderFallback({
        providers,
        currentInstanceId: claude.instanceId,
        currentModel: "claude-opus-5-5",
        rule: noRule,
        nowMs: now,
        belowPercent: 99,
        anyReady: true,
        limitedInstanceIds: new Set([claude.instanceId]),
      }),
    ).toEqual(sel("codex", "gpt-6.1-sol"));
  });

  it("treats a built-in entry on a provider without a usage reading as a guess", () => {
    const entries = describeFallbackOrder({
      providers,
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: noRule,
      nowMs: now,
    });
    const copilotOpus = entries.find((entry) => entry.selection.instanceId === copilot.instanceId);
    expect(copilotOpus?.unavailable).toBeNull();
    expect(copilotOpus?.guess).toBe(true);
  });

  it("never picks an agent whose billing is unknown for a built-in entry", () => {
    const devin = provider("devin", "acpRegistry", ["claude-opus-5-5"], null);
    const entries = describeFallbackOrder({
      providers: [codexPaid, devin],
      currentInstanceId: codexPaid.instanceId,
      currentModel: "gpt-6.1-sol",
      rule: noRule,
      nowMs: now,
    });
    expect(
      entries.find((entry) => entry.selection.instanceId === devin.instanceId)?.unavailable,
    ).toBe("per-token");
  });

  it("never spends on a per-token account for a built-in entry", () => {
    const apiClaude = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], null, {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    expect(
      resolveProviderFallback({
        providers: [codexPaid, apiClaude],
        currentInstanceId: codexPaid.instanceId,
        currentModel: "gpt-6.1-sol",
        rule: noRule,
        nowMs: now,
        belowPercent: 99,
        anyReady: true,
        limitedInstanceIds: new Set([codexPaid.instanceId]),
      }),
    ).toBeNull();
  });

  it("lets a saved fallback order win over the built-in tracks", () => {
    const rule = { ...noRule, providerLimitFallbackModels: [sel("muse", "muse-wonder-1.0")] };
    expect(
      resolveProviderFallback({
        providers,
        currentInstanceId: claude.instanceId,
        currentModel: "claude-opus-5-5",
        rule,
        nowMs: now,
        belowPercent: 99,
        anyReady: true,
        limitedInstanceIds: new Set([claude.instanceId]),
      }),
    ).toEqual(sel("muse", "muse-wonder-1.0"));
  });

  it('does not let "Only these models" trap a thread on tracks nobody saved', () => {
    const rule = { ...noRule, providerLimitFallbackListOnly: true };
    expect(
      resolveProviderFallback({
        providers,
        currentInstanceId: claude.instanceId,
        currentModel: "claude-opus-5-5",
        rule,
        nowMs: now,
        belowPercent: 99,
        anyReady: true,
        limitedInstanceIds: new Set([claude.instanceId]),
      }),
    ).toEqual(sel("codex", "gpt-6.1-sol"));
  });
});

describe("the free tail", () => {
  it("runs on a free plan before the maker's paid account", () => {
    const paid = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"], 20);
    const free = provider("codex-free", "codex", ["gpt-6-luna"], 0, {
      auth: { status: "authenticated", label: "ChatGPT Free Subscription" },
    });
    const daily = defaultTrackSelections("daily", [paid, free]);
    expect(daily.at(-1)).toEqual(sel("codex-free", "gpt-6-luna"));
    expect(daily[0]).toEqual(sel("codex", "gpt-6.1-sol"));
  });
});

describe("sources the person ranked", () => {
  const work = provider("claude-work", "claudeAgent", ["claude-opus-5-5"], 10);
  const stop = {
    providers: [{ ...claude }, work, codexPaid],
    currentInstanceId: claude.instanceId,
    currentModel: "claude-opus-5-5",
    nowMs: now,
    belowPercent: 95,
    anyReady: true,
    limitedInstanceIds: new Set<string>([claude.instanceId]),
  };
  const order = { ...noRule, providerLimitFallbackModels: [sel("codex", "gpt-6.1-sol")] };

  it("keep the same model before a different model from the fallback order", () => {
    expect(
      resolveProviderFallback({
        ...stop,
        rule: { ...order, defaultModelProviders: [work.instanceId] },
      }),
    ).toEqual(sel("claude-work", "claude-opus-5-5"));
  });

  it("do not apply when none is ranked or the list is the whole chain", () => {
    expect(resolveProviderFallback({ ...stop, rule: order })).toEqual(sel("codex", "gpt-6.1-sol"));
    expect(
      resolveProviderFallback({
        ...stop,
        rule: {
          ...order,
          defaultModelProviders: [work.instanceId],
          providerLimitFallbackListOnly: true,
        },
      }),
    ).toEqual(sel("codex", "gpt-6.1-sol"));
  });
});
