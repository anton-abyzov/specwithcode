import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chainNamedByPerson,
  effectiveFallbackOrder,
  followNewestReleases,
  tierModelFor,
} from "./modelTiers.ts";
import { resolveReviewer, reviewerChain } from "./adversarialReview.ts";
import {
  defaultTrackSelections,
  effectiveModelLanes,
  isFreeTrackModel,
  isMakerOf,
  launchTrackLanes,
  projectDraftModelSelection,
  providerHomeFamily,
  providersForModel,
  trackEntryEffort,
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
      sel("codex", "gpt-6-luna"),
    ]);
    expect(defaultTrackSelections("complex", providers)).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
      sel("copilot", "gpt-6-astra"),
    ]);
    expect(defaultTrackSelections("review", providers)).toEqual([
      sel("muse", "muse-wonder-1.0"),
      sel("copilot", "gpt-6.1-sol"),
      sel("copilot", "gemini-4-carbon"),
    ]);
  });

  it("put Sonnet 5.5 after Opus 5.5 on Daily and keep Muse Wonder off it", () => {
    const withSonnet = {
      ...claude,
      models: [...claude.models, { ...claude.models[0]!, slug: "claude-sonnet-5-5" }],
    };
    expect(
      defaultTrackSelections("daily", [withSonnet, codexPaid, muse]).map((entry) => entry.model),
    ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6-luna"]);
  });

  it("start Review on Muse Wonder Full at extra high effort when Muse offers it", () => {
    const withFull = {
      ...muse,
      models: [
        { ...muse.models[0]!, slug: "muse-wonder-full-1.0", isDefault: false },
        ...muse.models,
      ],
    };
    const effortful = {
      ...withFull,
      models: withFull.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select" as const,
              options: [
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      })),
    };
    expect(defaultTrackSelections("review", [effortful]).slice(0, 2)).toEqual([
      {
        ...sel("muse", "muse-wonder-full-1.0"),
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      { ...sel("muse", "muse-wonder-1.0"), options: [{ id: "reasoningEffort", value: "xhigh" }] },
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
    // The built-in order names no entry on it at all, so nothing can land there.
    expect(entries.some((entry) => entry.selection.instanceId === devin.instanceId)).toBe(false);
    expect(
      defaultTrackSelections("daily", [codexPaid, devin]).map((entry) => entry.instanceId),
    ).not.toContain(devin.instanceId);
  });

  it("keeps a built-in entry off a model its source bills per use, by router or unknown", () => {
    for (const billing of ["api", "paid-router", "unknown"] as const) {
      const base = provider("pi", "acpRegistry", ["claude-opus-5-5"], 10);
      const pi = { ...base, models: base.models.map((model) => ({ ...model, billing })) };
      expect(defaultTrackSelections("daily", [pi])).toEqual([]);
    }
  });

  it("keeps a built-in entry off a per-token source a saved Sources order ranks first", () => {
    const apiClaude = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], null, {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    expect(defaultTrackSelections("daily", [apiClaude, claude], [apiClaude.instanceId])[0]).toEqual(
      sel("claudeAgent", "claude-opus-5-5"),
    );
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

describe("review round fixes", () => {
  it("keeps a built-in entry of an unsaved track behind the project model", () => {
    // Only Daily is saved. A limited Sol thread must go home to Opus, not to built-in Fable.
    const limitedCodex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra"], 100);
    expect(
      resolveProviderFallback({
        providers: [claude, limitedCodex],
        currentInstanceId: limitedCodex.instanceId,
        currentModel: "gpt-6.1-sol",
        nowMs: now,
        belowPercent: 95,
        anyReady: true,
        limitedInstanceIds: new Set<string>([limitedCodex.instanceId]),
        rule: {
          ...noRule,
          defaultModelSelection: sel("claudeAgent", "claude-opus-5-5"),
          modelLanes: { routine: [sel("muse", "muse-wonder-1.0")], complex: [] },
        },
      }),
    ).toEqual(sel("claudeAgent", "claude-opus-5-5"));
  });

  it("never reviews on a Gemini spend account nobody named", () => {
    const gemini = provider("acpRegistry_gemini", "acpRegistry", ["gemini-4-carbon"], null, {
      auth: { status: "authenticated", type: "vertex-ai" },
    });
    const author = sel("codex", "gpt-6.1-sol");
    const byDefault = resolveReviewer({
      providers: [codexPaid, gemini],
      author,
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(byDefault.reviewer).toBeNull();
    const named = resolveReviewer({
      providers: [codexPaid, gemini],
      author,
      reviewers: [sel("acpRegistry_gemini", "gemini-4-carbon")],
      tier: "regular",
      nowMs: now,
    });
    expect(named.reviewer).toEqual(sel("acpRegistry_gemini", "gemini-4-carbon"));
  });

  it("ends when two models are named as each other's successor", () => {
    const base = provider("codex", "codex", ["gpt-a", "gpt-b"], null);
    const looped = {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        succeeds: model.slug === "gpt-a" ? "gpt-b" : "gpt-a",
      })),
    };
    expect(followNewestReleases([sel("codex", "gpt-a")], [looped])).toEqual([
      sel("codex", "gpt-b"),
      sel("codex", "gpt-a"),
    ]);
  });

  it("never follows a release billed per use or with unknown billing", () => {
    const base = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6.2-sol"], null);
    const billed = (billing: "api" | "unknown") => ({
      ...base,
      models: base.models.map((model) =>
        model.slug === "gpt-6.2-sol" ? { ...model, billing } : model,
      ),
    });
    expect(tierModelFor(billed("api"), "regular")).toBe("gpt-6.1-sol");
    expect(tierModelFor(billed("unknown"), "regular")).toBe("gpt-6.1-sol");
    const unknownBoth = {
      ...base,
      models: base.models.map((model) => ({ ...model, billing: "unknown" as const })),
    };
    expect(followNewestReleases([sel("codex", "gpt-6.1-sol")], [unknownBoth])).toEqual([
      sel("codex", "gpt-6.1-sol"),
    ]);
  });
});

describe("tracks at launch", () => {
  const copilotIcon = {
    iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
  };
  const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 100);
  const copilot = provider("copilot", "acpRegistry", ["claude-opus-5.5"], null, copilotIcon);
  const apiKey = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], null, {
    auth: { status: "authenticated", type: "apiKey" },
  });
  const codex = provider("codex", "codex", ["gpt-6.1-sol"], 10);
  const all = [claude, copilot, apiKey, codex];

  it("follows each model with its other plan accounts before the next model", () => {
    expect(launchTrackLanes(null, all).routine).toEqual([
      sel("claudeAgent", "claude-opus-5-5"),
      sel("copilot", "claude-opus-5.5"),
      sel("codex", "gpt-6.1-sol"),
    ]);
  });

  it("puts the saved Sources order first and never adds a per-token account", () => {
    const lanes = launchTrackLanes(null, all, [copilot.instanceId]);
    expect(lanes.routine.slice(0, 2)).toEqual([
      sel("copilot", "claude-opus-5.5"),
      sel("claudeAgent", "claude-opus-5-5"),
    ]);
    expect(lanes.routine.some((entry) => entry.instanceId === "claude-api")).toBe(false);
  });

  it("keeps a saved per-token entry first: the person named that account", () => {
    const saved = { routine: [sel("claude-api", "claude-opus-5-5")], complex: [] };
    expect(launchTrackLanes(saved, all).routine).toEqual([
      sel("claude-api", "claude-opus-5-5"),
      sel("claudeAgent", "claude-opus-5-5"),
      sel("copilot", "claude-opus-5.5"),
    ]);
  });

  it("shows a Tracks draft the first Daily model, and a One model draft the project's", () => {
    const one = sel("codex", "gpt-6.1-sol");
    expect(
      projectDraftModelSelection({ threadModelMode: "tracks", defaultModelSelection: one }, all),
    ).toEqual(sel("claudeAgent", "claude-opus-5-5"));
    expect(
      projectDraftModelSelection({ threadModelMode: "model", defaultModelSelection: one }, all),
    ).toEqual(one);
    // Nothing installed names a track model: the draft keeps the project's model.
    expect(
      projectDraftModelSelection({ threadModelMode: "tracks", defaultModelSelection: one }, []),
    ).toEqual(one);
  });
});

describe("track effort", () => {
  const levels = (id: string, ids: ReadonlyArray<string>) => ({
    optionDescriptors: [
      {
        id,
        label: "Reasoning",
        type: "select" as const,
        options: ids.map((level) => ({
          id: level,
          label: level,
          ...(level === "high" ? { isDefault: true } : {}),
        })),
      },
    ],
  });
  const withLevels = (source: ServerProvider, id: string, ids: ReadonlyArray<string>) => ({
    ...source,
    models: source.models.map((model) => ({ ...model, capabilities: levels(id, ids) })),
  });
  const claudeE = withLevels(
    provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 10),
    "effort",
    ["low", "medium", "high"],
  );
  const copilotE = withLevels(
    provider("copilot", "acpRegistry", ["claude-opus-5.5"], 10, {
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
    }),
    "reasoning_effort",
    ["low", "medium", "high", "xhigh"],
  );
  const codexE = withLevels(provider("codex", "codex", ["gpt-6.1-sol"], 10), "reasoningEffort", [
    "low",
    "high",
  ]);

  it("starts a built-in entry at Medium, the nearest level a model offers otherwise", () => {
    expect(defaultTrackSelections("daily", [claudeE, codexE])).toEqual([
      { ...sel("claudeAgent", "claude-opus-5-5"), options: [{ id: "effort", value: "medium" }] },
      // Codex offers low and high here: a tie goes to the higher level.
      { ...sel("codex", "gpt-6.1-sol"), options: [{ id: "reasoningEffort", value: "high" }] },
    ]);
  });

  it("runs a saved entry without an effort at Medium and keeps a saved one", () => {
    const lanes = effectiveModelLanes(
      {
        routine: [
          sel("claudeAgent", "claude-opus-5-5"),
          { ...sel("codex", "gpt-6.1-sol"), options: [{ id: "reasoningEffort", value: "low" }] },
        ],
        complex: [],
      },
      [claudeE, codexE],
    ).lanes.routine;
    expect(lanes).toEqual([
      { ...sel("claudeAgent", "claude-opus-5-5"), options: [{ id: "effort", value: "medium" }] },
      { ...sel("codex", "gpt-6.1-sol"), options: [{ id: "reasoningEffort", value: "low" }] },
    ]);
    expect(trackEntryEffort(sel("claudeAgent", "claude-opus-5-5"), [claudeE])).toEqual({
      optionId: "effort",
      value: "medium",
      saved: false,
    });
    // A model its source lists with no effort setting has none.
    expect(trackEntryEffort(sel("claudeAgent", "claude-opus-5-5"), [claude])).toBeNull();
  });

  it("carries an entry's level to the same model on another harness", () => {
    const saved = {
      routine: [
        { ...sel("claudeAgent", "claude-opus-5-5"), options: [{ id: "effort", value: "high" }] },
      ],
      complex: [],
    };
    expect(launchTrackLanes(saved, [claudeE, copilotE]).routine).toEqual([
      { ...sel("claudeAgent", "claude-opus-5-5"), options: [{ id: "effort", value: "high" }] },
      {
        ...sel("copilot", "claude-opus-5.5"),
        options: [{ id: "reasoning_effort", value: "high" }],
      },
    ]);
  });

  it("runs a listed reviewer without an effort at Medium", () => {
    expect(
      reviewerChain({
        providers: [codexE],
        reviewers: [sel("codex", "gpt-6.1-sol")],
        tier: "regular",
      })[0],
    ).toEqual({
      ...sel("codex", "gpt-6.1-sol"),
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});

describe("GPT-6.2 in the built-in tracks", () => {
  const codex61 = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra"], 10);
  const codex62 = provider(
    "codex",
    "codex",
    ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-astra", "gpt-6.2-astra"],
    10,
  );

  it("runs the 6.2 entries on 6.2 where a source lists it, else on the release it lists", () => {
    expect(defaultTrackSelections("complex", [codex62]).map((entry) => entry.model)).toEqual([
      "gpt-6.2-astra",
    ]);
    expect(defaultTrackSelections("complex", [codex61]).map((entry) => entry.model)).toEqual([
      "gpt-6-astra",
    ]);
    expect(
      defaultTrackSelections("daily", [codex61]).map((entry) => entry.model),
    ).toContain("gpt-6.1-sol");
    expect(tierModelFor(codex62, "regular")).toBe("gpt-6.2-sol");
    expect(tierModelFor(codex61, "regular")).toBe("gpt-6.1-sol");
    expect(tierModelFor(codex61, "frontier")).toBe("gpt-6-astra");
  });

  it("lets a saved 6.1 entry follow 6.2 once its source lists it", () => {
    expect(followNewestReleases([sel("codex", "gpt-6.1-sol")], [codex62])).toEqual([
      sel("codex", "gpt-6.2-sol"),
      sel("codex", "gpt-6.1-sol"),
    ]);
  });

  it("adds a source that lists only 6.2 as another account of a built-in entry", () => {
    const copilot62 = provider("copilot", "acpRegistry", ["gpt-6.2-sol"], null, {
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
    });
    const routine = launchTrackLanes(null, [codex61, copilot62]).routine;
    expect(routine).toContainEqual(sel("codex", "gpt-6.1-sol"));
    expect(routine).toContainEqual(sel("copilot", "gpt-6.2-sol"));
  });
});
