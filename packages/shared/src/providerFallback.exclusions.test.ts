import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFallbackOrder,
  isExcludedFallbackModel,
  normalizeModelKey,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const later = "2026-10-24T15:00:00.000Z";

function provider(
  id: string,
  driver: string,
  used: number | null,
  models: ReadonlyArray<readonly [slug: string, name: string]>,
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
    models: models.map(([slug, name], index) => ({
      slug,
      name,
      isCustom: false,
      capabilities: null,
      ...(index === 0 ? { isDefault: true } : {}),
    })),
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
  };
}

// The user's live machine, simplified: Claude is limited; Codex, Grok and
// two Copilot instances may take the thread.
const claude = provider("claudeAgent", "claudeAgent", 100, [["claude-opus-5-5", "Opus 5.5"]]);
const codex = provider("codex", "codex", 40, [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-astra", "GPT-6 Astra"],
]);
const grok = provider("grok", "grok", 5, [["grok-4.7", "Grok 4.7"]]);
const copilot = provider("copilot", "acpRegistry", null, [["claude-opus-5.5", "Opus 5.5"]]);
const copilot2 = provider("copilot-0889", "acpRegistry", null, [["claude-opus-5.5", "Opus 5.5"]]);
const id = ProviderInstanceId.make;
const astra = { instanceId: id("codex"), model: "gpt-6-astra" };
const sol = { instanceId: id("codex"), model: "gpt-6.1-sol" };
const base = { providerLimitFallbackModelSelection: null, defaultModelSelection: null };
const limitStop = {
  currentInstanceId: claude.instanceId,
  currentModel: "claude-opus-5-5",
  nowMs: now,
  belowPercent: 95,
  anyReady: true,
} as const;

describe("normalizeModelKey", () => {
  it("reads one model the same on every provider", () => {
    expect(normalizeModelKey("claude-opus-5.5")).toBe(normalizeModelKey("claude-opus-5-5"));
    expect(normalizeModelKey("Grok 4.7")).toBe("grok-4-7");
    expect(normalizeModelKey("gpt_6.1_sol")).toBe("gpt-6-1-sol");
    expect(normalizeModelKey("gpt-6-astra")).not.toBe(normalizeModelKey("gpt-6.1-sol"));
  });

  it("scopes an entry with an instance to that instance only", () => {
    const excluded = [{ model: "claude-opus-5.5", instanceId: id("copilot") }];
    expect(isExcludedFallbackModel(excluded, id("copilot"), "claude-opus-5.5")).toBe(true);
    expect(isExcludedFallbackModel(excluded, id("copilot-0889"), "claude-opus-5.5")).toBe(false);
    expect(isExcludedFallbackModel(excluded, id("copilot"), undefined)).toBe(false);
  });
});

describe("excluded models in the usage-limit fallback", () => {
  it("skips an excluded entry of the user's order and takes the next one", () => {
    const rule = {
      ...base,
      providerLimitFallbackModels: [astra, sol],
      providerLimitExcludedModels: [{ model: "gpt-6-astra" }],
    };
    expect(resolveProviderFallback({ ...limitStop, providers: [claude, codex], rule })).toEqual(
      sol,
    );
    expect(
      describeFallbackOrder({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        belowPercent: 95,
      }).map((entry) => entry.unavailable),
    ).toEqual(["excluded", null]);
  });

  it("applies exclusions to an explicitly selected API-billed home", () => {
    const api = {
      ...claude,
      auth: { status: "authenticated" as const, apiKeyBilling: true },
      usageLimits: undefined,
    };
    const home = { instanceId: api.instanceId, model: "claude-opus-5-5" };
    const input = {
      ...limitStop,
      currentInstanceId: codex.instanceId,
      currentModel: "gpt-6.1-sol",
      providers: [codex, api],
      rule: { ...base, defaultModelSelection: home },
    };
    expect(resolveProviderFallback(input)).toEqual(home);
    expect(
      resolveProviderFallback({
        ...input,
        rule: { ...input.rule, providerLimitExcludedModels: [{ model: "claude-opus-5.5" }] },
      }),
    ).toBeNull();
  });

  it("keeps the same model on another provider out when the model is excluded everywhere", () => {
    const rule = { ...base, providerLimitExcludedModels: [{ model: "claude-opus-5-5" }] };
    const target = resolveProviderFallback({
      ...limitStop,
      providers: [claude, copilot, copilot2, codex],
      rule,
    });
    expect(target).toEqual({ instanceId: codex.instanceId, model: "gpt-6.1-sol" });
  });

  it("excludes the model only on the named instance", () => {
    const rule = {
      ...base,
      providerLimitExcludedModels: [{ model: "claude-opus-5.5", instanceId: id("copilot") }],
    };
    const target = resolveProviderFallback({
      ...limitStop,
      providers: [claude, copilot, copilot2, codex],
      rule,
    });
    // Verified capacity still wins while the unexcluded Copilot reports none.
    expect(target).toEqual({ instanceId: codex.instanceId, model: "gpt-6.1-sol" });
    expect(
      resolveProviderFallback({
        ...limitStop,
        providers: [claude, copilot, copilot2],
        rule,
      }),
    ).toEqual({ instanceId: copilot2.instanceId, model: "claude-opus-5.5" });
  });

  it("without Copilot, never picks an excluded Grok with more room over Codex", () => {
    const providers = [claude, grok, codex];
    expect(resolveProviderFallback({ ...limitStop, providers, rule: base })?.instanceId).toBe(
      grok.instanceId,
    );
    const rule = { ...base, providerLimitExcludedModels: [{ model: "grok-4-7" }] };
    expect(resolveProviderFallback({ ...limitStop, providers, rule })).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6.1-sol",
    });
  });

  it("returns nothing when every other model is excluded, so the wait and manual choices apply", () => {
    const rule = {
      ...base,
      providerLimitFallbackModels: [astra],
      providerLimitExcludedModels: [
        { model: "gpt-6-astra" },
        { model: "gpt-6.1-sol" },
        { model: "grok-4.7" },
        { model: "claude-opus-5.5" },
      ],
    };
    expect(
      resolveProviderFallback({ ...limitStop, providers: [claude, codex, grok, copilot], rule }),
    ).toBeNull();
  });

  it("skips the coordinator's excluded model and an excluded project default", () => {
    const rule = {
      ...base,
      defaultModelSelection: { instanceId: grok.instanceId, model: "grok-4.7" },
      providerLimitExcludedModels: [{ model: "grok-4.7" }, { model: "gpt-6.1-sol" }],
    };
    expect(
      resolveProviderFallback({
        ...limitStop,
        anyReady: false,
        providers: [claude, grok, codex],
        rule,
        proven: { instanceId: codex.instanceId, model: "gpt-6.1-sol" },
      }),
    ).toBeNull();
  });

  it("starts a new worker on neither an excluded same model nor an excluded coordinator model", () => {
    const rule = {
      ...base,
      providerLimitAction: "switch" as const,
      providerLimitSwitchAtPercent: 95,
      providerLimitExcludedModels: [{ model: "claude-opus-5.5" }, { model: "gpt-6.1-sol" }],
    };
    const launch = resolveWorkerLaunchSelection({
      preferred: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      coordinator: { instanceId: codex.instanceId, model: "gpt-6.1-sol" },
      providers: [claude, copilot, codex],
      rule,
      nowMs: now,
    });
    expect(launch).toEqual({ selection: astra, reason: "fallback" });
  });

  it("moves a coordinator off a fallback model the user has since excluded", () => {
    const rule = {
      ...base,
      providerLimitAction: "switch" as const,
      providerLimitSwitchAtPercent: 95,
      providerLimitExcludedModels: [{ model: "grok-4.7" }],
    };
    const turn = resolveCoordinatorTurnSelection({
      saved: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      thread: { instanceId: grok.instanceId, model: "grok-4.7" },
      providers: [claude, grok, codex],
      rule,
      nowMs: now,
    });
    expect(turn.reason).not.toBe("staying-on-fallback");
    expect(turn.selection.instanceId).not.toBe(grok.instanceId);
  });

  it("reports an order entry that cannot run here by that cause, not as excluded", () => {
    const rule = {
      ...base,
      providerLimitFallbackModels: [{ instanceId: id("codex"), model: "gpt-5-gone" }, sol],
      providerLimitExcludedModels: [{ model: "gpt-5-gone" }, { model: "gpt-6.1-sol" }],
    };
    expect(
      describeFallbackOrder({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        belowPercent: 95,
      }).map((entry) => entry.unavailable),
    ).toEqual(["missing", "excluded"]);
  });

  it("skips an excluded legacy single fallback model", () => {
    const rule = {
      ...base,
      providerLimitFallbackModelSelection: sol,
      providerLimitExcludedModels: [{ model: "gpt-6.1-sol" }],
    };
    expect(
      resolveProviderFallback({ ...limitStop, anyReady: false, providers: [claude, codex], rule }),
    ).toBeNull();
  });

  it("keeps another account of the driver when only the thread's model is excluded", () => {
    const second = provider("claude-work", "claudeAgent", 10, [
      ["claude-opus-5-5", "Opus 5.5"],
      ["claude-fable-5-1", "Fable 5.1"],
    ]);
    const rule = { ...base, providerLimitExcludedModels: [{ model: "claude-opus-5-5" }] };
    expect(
      resolveProviderFallback({ ...limitStop, providers: [claude, second, codex], rule }),
    ).toEqual({ instanceId: second.instanceId, model: "claude-fable-5-1" });
  });
});
