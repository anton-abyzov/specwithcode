import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTEXT_FIT_MIN_HANDOFF_TOKENS,
  contextFits,
  contextHandoffReserve,
  describeFallbackOrder,
  resolveProviderFallback,
  resolveSameModelElsewhere,
} from "./providerFallback.ts";

const now = Date.parse("2026-10-22T19:50:00.000Z");
const fresh = "2026-10-22T19:49:00.000Z";
const stale = "2026-10-22T18:50:00.000Z";

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  checkedAt = fresh,
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
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "weekly",
                kind: "weekly" as const,
                label: "Week",
                usedPercent: used,
                resetsAt: "2026-10-27T00:00:00.000Z",
              },
            ],
          },
        }),
  } as ServerProvider;
}

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 30);
const codex = provider("codex", "codex", ["gpt-6.1-sol"], 20);
const copilot = provider("copilot", "copilot", ["small-model"], null);
const windows: Record<string, number> = {
  "claudeAgent\u0000claude-opus-5-5": 1_000_000,
  "codex\u0000gpt-6.1-sol": 258_400,
  "copilot\u0000small-model": 32_000,
};
const windowOf = (selection: ModelSelection) =>
  windows[`${selection.instanceId}\u0000${selection.model}`] ?? null;
const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

describe("contextFits", () => {
  it("needs room for the request, the reserve and a compacted handoff", () => {
    expect(contextHandoffReserve(258_400)).toBe(64_600);
    expect(contextHandoffReserve(32_000)).toBe(16_000);
    // A fresh Codex session holds a small request.
    expect(contextFits(258_400, 2_000)).toBe(true);
    // The session the DCFC thread reused: 221,400 of 258,400 already held.
    expect(contextFits(258_400, 2_000, 221_400)).toBe(false);
    // A pasted request larger than the window minus the reserve.
    expect(contextFits(258_400, 190_000)).toBe(false);
    expect(contextFits(32_000, 32_000 - 16_000 - CONTEXT_FIT_MIN_HANDOFF_TOKENS)).toBe(true);
    expect(contextFits(32_000, 32_000 - 16_000 - CONTEXT_FIT_MIN_HANDOFF_TOKENS + 1)).toBe(false);
    // An unknown window is never the reason a target is refused.
    expect(contextFits(null, 10_000_000)).toBe(true);
  });
});

describe("context fit in fallback resolution", () => {
  const rule = {
    providerLimitFallbackModelSelection: null,
    providerLimitFallbackModels: [sel("copilot", "small-model"), sel("codex", "gpt-6.1-sol")],
    defaultModelSelection: null,
  };

  it("skips an order entry whose window cannot hold the request", () => {
    const base = {
      providers: [claude, codex, copilot],
      currentInstanceId: claude.instanceId,
      rule,
      nowMs: now,
    };
    expect(resolveProviderFallback(base)).toEqual(sel("copilot", "small-model"));
    expect(
      resolveProviderFallback({ ...base, contextFit: { requestTokens: 20_000, windowOf } }),
    ).toEqual(sel("codex", "gpt-6.1-sol"));
    expect(
      describeFallbackOrder({ ...base, contextFit: { requestTokens: 20_000, windowOf } }).map(
        (entry) => entry.unavailable,
      ),
    ).toEqual(["too-small", null]);
    // Nothing on the order holds a 200k request: the any-ready step is gated too.
    expect(
      resolveProviderFallback({
        ...base,
        currentInstanceId: codex.instanceId,
        rule: { ...rule, providerLimitFallbackModels: [sel("copilot", "small-model")] },
        anyReady: true,
        contextFit: { requestTokens: 200_000, windowOf },
      }),
    ).toEqual(sel("claudeAgent", "claude-opus-5-5"));
    expect(
      resolveProviderFallback({
        ...base,
        providers: [claude, codex, copilot],
        currentInstanceId: codex.instanceId,
        rule: { ...rule, providerLimitFallbackModels: [sel("copilot", "small-model")] },
        anyReady: true,
        limitedInstanceIds: new Set([claude.instanceId]),
        contextFit: { requestTokens: 200_000, windowOf },
      }),
    ).toBeNull();
  });

  it("skips the same model elsewhere when that window is too small", () => {
    const smallClaude = provider("claude2", "claudeAgent", ["claude-opus-5-5"], 10);
    expect(
      resolveSameModelElsewhere({
        providers: [claude, smallClaude],
        current: sel("claudeAgent", "claude-opus-5-5"),
        nowMs: now,
        contextFit: {
          requestTokens: 50_000,
          windowOf: (selection) => (selection.instanceId === "claude2" ? 64_000 : 1_000_000),
        },
      }),
    ).toBeNull();
  });

  it("goes home first after an overflow, once home has a fresh reading with room", () => {
    const home = sel("claudeAgent", "claude-opus-5-5");
    const input = {
      currentInstanceId: codex.instanceId,
      rule: { ...rule, defaultModelSelection: home },
      nowMs: now,
      preferDefault: true,
      contextFit: { requestTokens: 2_000, windowOf },
    };
    expect(resolveProviderFallback({ ...input, providers: [claude, codex, copilot] })).toEqual(
      home,
    );
    // A stale reading is not room: the order applies until a fresh read shows it.
    const staleClaude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 30, stale);
    expect(resolveProviderFallback({ ...input, providers: [staleClaude, codex, copilot] })).toEqual(
      sel("copilot", "small-model"),
    );
    // A home that is truly limited is not chosen either.
    const fullClaude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], 100);
    expect(resolveProviderFallback({ ...input, providers: [fullClaude, codex, copilot] })).toEqual(
      sel("copilot", "small-model"),
    );
  });

  it("goes home after an overflow even when home reports no usage", () => {
    // Copilot is the project default and reports no usage; Claude shows
    // verified room. An overflow says nothing about home's quota.
    const home = sel("copilot", "small-model");
    const input = {
      currentInstanceId: codex.instanceId,
      rule: { ...rule, providerLimitFallbackModels: [], defaultModelSelection: home },
      nowMs: now,
      anyReady: true,
      contextFit: { requestTokens: 2_000, windowOf },
    };
    expect(
      resolveProviderFallback({
        ...input,
        preferDefault: true,
        providers: [claude, codex, copilot],
      }),
    ).toEqual(home);
    // Without the overflow, verified room comes before a home that reports none.
    expect(resolveProviderFallback({ ...input, providers: [claude, codex, copilot] })).toEqual(
      sel("claudeAgent", "claude-opus-5-5"),
    );
  });
});
