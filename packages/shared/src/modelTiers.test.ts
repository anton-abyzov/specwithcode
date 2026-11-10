import * as DateTime from "effect/DateTime";
import {
  type ModelLanes,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveFallbackOrder,
  followNewestReleases,
  tierFallbackOrder,
  tierOfModel,
} from "./modelTiers.ts";
import { describeFallbackOrder, resolveProviderFallback } from "./providerFallback.ts";

const now = Date.parse("2026-11-03T06:30:00.000Z");
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
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-11-05T00:00:00.000Z",
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

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 96);
const enterprise = provider(
  "copilot-enterprise",
  "acpRegistry",
  ["claude-opus-5.5", "gpt-6-astra"],
  12,
);
const codex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra"], 30);
const providers = [claude, enterprise, codex];

const lanes: ModelLanes = {
  complex: [sel("claudeAgent", "claude-opus-5-5"), sel("codex", "gpt-6-astra")],
  routine: [sel("codex", "gpt-6.1-sol")],
};
const rule = {
  providerLimitFallbackModelSelection: null,
  defaultModelSelection: sel("codex", "gpt-6-astra"),
  defaultModelProviders: [enterprise.instanceId],
  modelLanes: lanes,
};

describe("tierOfModel", () => {
  it("finds a model's tier under any provider's spelling", () => {
    expect(tierOfModel(lanes, "claude-opus-5.5")).toBe("complex");
    expect(tierOfModel(lanes, "gpt-6.1-sol")).toBe("routine");
    expect(tierOfModel(lanes, "unranked")).toBeNull();
    expect(tierOfModel(null, "gpt-6.1-sol")).toBeNull();
  });
});

describe("tierFallbackOrder", () => {
  it("walks the thread's tier first, each model on its other providers, then the other tier", () => {
    expect(tierFallbackOrder(rule, "claude-opus-5-5", providers)).toEqual([
      sel("claudeAgent", "claude-opus-5-5"),
      sel("copilot-enterprise", "claude-opus-5.5"),
      sel("codex", "gpt-6-astra"),
      sel("copilot-enterprise", "gpt-6-astra"),
      sel("codex", "gpt-6.1-sol"),
    ]);
  });

  it("keeps an everyday thread in everyday work before the hardest tier", () => {
    expect(tierFallbackOrder(rule, "gpt-6.1-sol", providers)[0]).toEqual(
      sel("codex", "gpt-6.1-sol"),
    );
    expect(tierFallbackOrder(rule, "gpt-6.1-sol", providers)[1]).toEqual(
      sel("claudeAgent", "claude-opus-5-5"),
    );
  });

  it("puts the thread's own model on other providers ahead of a higher-ranked model", () => {
    expect(tierFallbackOrder(rule, "gpt-6-astra", providers).slice(0, 3)).toEqual([
      sel("codex", "gpt-6-astra"),
      sel("copilot-enterprise", "gpt-6-astra"),
      sel("claudeAgent", "claude-opus-5-5"),
    ]);
  });

  it("starts an unranked thread on the recommended model's tier", () => {
    expect(tierFallbackOrder(rule, "unranked", providers)[0]).toEqual(
      sel("claudeAgent", "claude-opus-5-5"),
    );
  });

  it("is empty without tiers", () => {
    expect(tierFallbackOrder({ modelLanes: null }, "x", providers)).toEqual([]);
  });
});

describe("effectiveFallbackOrder", () => {
  it("uses an explicit fallback order over the tiers", () => {
    const explicit = { ...rule, providerLimitFallbackModels: [sel("codex", "gpt-6.1-sol")] };
    expect(effectiveFallbackOrder(explicit, "claude-opus-5-5", providers)).toEqual({
      order: [sel("codex", "gpt-6.1-sol")],
      fromTiers: false,
    });
    expect(effectiveFallbackOrder(rule, "claude-opus-5-5", providers).fromTiers).toBe(true);
  });
});

describe("limit fallback through the tiers", () => {
  const input = {
    providers,
    currentInstanceId: claude.instanceId,
    currentModel: "claude-opus-5-5",
    rule,
    nowMs: now,
    anyReady: true,
  };

  it("keeps a limited hardest-work thread on the same model elsewhere", () => {
    expect(resolveProviderFallback(input)).toEqual(sel("copilot-enterprise", "claude-opus-5.5"));
  });

  it("moves to the next ranked model when the same model has nowhere else to run", () => {
    expect(
      resolveProviderFallback({
        ...input,
        limitedInstanceIds: new Set([enterprise.instanceId]),
      }),
    ).toEqual(sel("codex", "gpt-6-astra"));
  });

  it("waits past the tiers when Only these models is on", () => {
    const listOnly = { ...rule, providerLimitFallbackListOnly: true };
    const other = provider("pi", "pi", ["other"], 5);
    expect(
      resolveProviderFallback({
        ...input,
        providers: [claude, other],
        rule: listOnly,
      }),
    ).toBeNull();
    expect(resolveProviderFallback({ ...input, providers: [claude, other], rule })).toEqual(
      sel("pi", "other"),
    );
  });

  it("never moves a thread onto a per-token or Gemini provider from the tiers", () => {
    const gemini = provider("acpRegistry_gemini", "acpRegistry", ["gemini-3.8-pro"], 1);
    const tiers = {
      ...rule,
      modelLanes: {
        complex: [
          sel("claudeAgent", "claude-opus-5-5"),
          sel("acpRegistry_gemini", "gemini-3.8-pro"),
        ],
        routine: [],
      },
    };
    const order = describeFallbackOrder({
      providers: [claude, gemini],
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: tiers,
      nowMs: now,
    });
    expect(order.map((entry) => entry.unavailable)).toEqual(["current", "per-token"]);
    expect(
      resolveProviderFallback({ ...input, providers: [claude, gemini], rule: tiers }),
    ).toBeNull();
  });

  const tiersOnly = { ...rule, defaultModelProviders: [] };

  it("never expands a ranked model onto an unnamed agent whose billing is unknown", () => {
    const custom = provider("custom-agent", "acpRegistry", ["claude-opus-5.5"], null);
    const order = describeFallbackOrder({
      providers: [claude, custom],
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: tiersOnly,
      nowMs: now,
    });
    expect(order.find((e) => e.provider?.instanceId === custom.instanceId)?.unavailable).toBe(
      "per-token",
    );
    expect(
      resolveProviderFallback({ ...input, providers: [claude, custom], rule: tiersOnly }),
    ).not.toEqual(sel("custom-agent", "claude-opus-5.5"));
  });

  it("prefers a ranked model with verified room over an unnamed provider without usage", () => {
    const personal = provider("copilot", "acpRegistry", ["claude-opus-5.5"], null, {
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
    });
    const all = [claude, personal, codex];
    expect(resolveProviderFallback({ ...input, providers: all, rule: tiersOnly })).toEqual(
      sel("codex", "gpt-6-astra"),
    );
    expect(
      resolveProviderFallback({
        ...input,
        providers: all,
        rule: tiersOnly,
        limitedInstanceIds: new Set([codex.instanceId]),
      }),
    ).toEqual(sel("copilot", "claude-opus-5.5"));
  });
});

describe("followNewestReleases", () => {
  it("swaps a listed older release for the newest of its family and dedupes", () => {
    const fable = provider(
      "claudeAgent",
      "claudeAgent",
      ["claude-fable-5-1", "claude-fable-5-2", "claude-opus-5-5"],
      null,
    );
    expect(
      followNewestReleases(
        [
          sel("claudeAgent", "claude-fable-5-1"),
          sel("claudeAgent", "claude-fable-5-2"),
          sel("claudeAgent", "claude-opus-5-5"),
          sel("claudeAgent", "claude-gone-1"),
        ],
        [fable],
      ),
    ).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
      sel("claudeAgent", "claude-fable-5-1"),
      sel("claudeAgent", "claude-opus-5-5"),
      sel("claudeAgent", "claude-gone-1"),
    ]);
  });

  it("keeps a thread on the followed release in its own tier when it hits a limit", () => {
    const fable = provider(
      "claudeAgent",
      "claudeAgent",
      ["claude-fable-5-1", "claude-fable-5-2", "claude-sonnet-5-5"],
      null,
    );
    const input = {
      modelLanes: {
        complex: [sel("claudeAgent", "claude-fable-5-1")],
        routine: [sel("claudeAgent", "claude-sonnet-5-5")],
      },
      defaultModelSelection: sel("claudeAgent", "claude-sonnet-5-5"),
    };
    expect(tierOfModel(input.modelLanes, "claude-fable-5-2")).toBe("complex");
    expect(tierOfModel(input.modelLanes, "claude-fable-5-0")).toBeNull();
    expect(tierFallbackOrder(input, "claude-fable-5-2", [fable])).toEqual([
      sel("claudeAgent", "claude-fable-5-2"),
      sel("claudeAgent", "claude-fable-5-1"),
      sel("claudeAgent", "claude-sonnet-5-5"),
    ]);
  });
});
