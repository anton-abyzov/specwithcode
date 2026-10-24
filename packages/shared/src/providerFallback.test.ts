import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canTakeTurn,
  coordinatorFallbackReason,
  coordinatorOnLimitFallback,
  describeFallbackOrder,
  fallbackSelectionKey,
  limitRestartRequest,
  providerUsedPercent,
  isClaudeApiKeyProvider,
  isGeminiSpendProvider,
  isPerTokenProvider,
  isApiCreditExhaustedMessage,
  isApiCreditProvider,
  isDirectClaudeApiKeyProvider,
  resolveApiCreditSelection,
  resolveApiCreditSelections,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveSameModelElsewhere,
  limitStopWaitsForReset,
  provenFallbackSelection,
  resolveWorkerLaunchSelection,
  shouldSwitchBeforeTurn,
  usageAtThreshold,
  usageResetAt,
  isUnknownBillingAgent,
} from "./providerFallback.ts";

const now = Date.parse("2026-10-09T12:00:00.000Z");
const later = "2026-10-09T15:00:00.000Z";
const earlier = "2026-10-09T11:00:00.000Z";

function provider(
  id: string,
  driver: string,
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
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    ...(driver === "acpRegistry" && /^copilot(?:-|$)/.test(id)
      ? { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" }
      : {}),
    version: null,
    models: [
      { slug: `${driver}-small`, name: "Small", isCustom: false, capabilities: null },
      {
        slug: `${driver}-default`,
        name: "Default",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
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
                kind: "session",
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

const claude = provider("claudeAgent", "claudeAgent", 93);
const codex = provider("codex", "codex", 20);
const rule = { providerLimitFallbackModelSelection: null, defaultModelSelection: null };
const nativeDenials = [
  { ordinaryUsageAllowed: true, spendControlReached: true },
  { ordinaryUsageAllowed: null, rateLimitReachedType: "workspace_member_usage_limit_reached" },
  { rateLimitReachedType: "workspace_owner_credits_depleted" },
] as const;

describe("providerUsedPercent", () => {
  it("takes the fullest window that has not reset", () => {
    const withExpiredWindow = {
      ...claude,
      usageLimits: {
        ...claude.usageLimits!,
        windows: [
          ...claude.usageLimits!.windows,
          {
            id: "old",
            kind: "weekly" as const,
            label: "Week",
            usedPercent: 100,
            resetsAt: earlier,
          },
        ],
      },
    };
    expect(providerUsedPercent(withExpiredWindow, now)).toBe(93);
    expect(providerUsedPercent(provider("x", "codex", null), now)).toBeNull();
  });
});

describe("resolveProviderFallback", () => {
  it.each(nativeDenials)("skips a known denied low-usage fallback: %j", (denial) => {
    const denied = {
      ...codex,
      usageLimits: { ...codex.usageLimits!, ...denial },
    };
    const fallback = { instanceId: denied.instanceId, model: "codex-default" };
    expect(canTakeTurn(denied)).toBe(false);
    for (const selections of [
      rule,
      { ...rule, providerLimitFallbackModelSelection: fallback },
      { ...rule, defaultModelSelection: fallback },
    ])
      expect(
        resolveProviderFallback({
          providers: [claude, denied],
          currentInstanceId: claude.instanceId,
          rule: selections,
          nowMs: now,
          anyReady: true,
        }),
      ).toBeNull();
  });

  it("keeps explicit allowance eligible despite a retained limit type", () => {
    const allowed = {
      ...codex,
      usageLimits: {
        ...codex.usageLimits!,
        ordinaryUsageAllowed: true,
        spendControlReached: false,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      },
    };
    expect(canTakeTurn(allowed)).toBe(true);
    expect(
      resolveProviderFallback({
        providers: [claude, allowed],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        anyReady: true,
      }),
    ).toEqual({ instanceId: allowed.instanceId, model: "codex-default" });
  });

  it("prefers the project's fallback, then its default, then any ready provider", () => {
    const fallback = { instanceId: codex.instanceId, model: "codex-small" };
    expect(
      resolveProviderFallback({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule: { ...rule, providerLimitFallbackModelSelection: fallback },
        nowMs: now,
      }),
    ).toEqual(fallback);
    expect(
      resolveProviderFallback({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
      }),
    ).toBeNull();
    expect(
      resolveProviderFallback({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        anyReady: true,
      }),
    ).toEqual({ instanceId: codex.instanceId, model: "codex-default" });
  });

  it("goes back to the default model when the thread already runs on the fallback", () => {
    const back = { instanceId: claude.instanceId, model: "claudeAgent-small" };
    const target = resolveProviderFallback({
      providers: [provider("claudeAgent", "claudeAgent", 10), codex],
      currentInstanceId: codex.instanceId,
      rule: {
        providerLimitFallbackModelSelection: { instanceId: codex.instanceId, model: "gpt" },
        defaultModelSelection: back,
      },
      nowMs: now,
    });
    expect(target).toEqual(back);
  });

  it("never hands a thread to a provider that is also full, signed out or refusing", () => {
    const full = provider("codex", "codex", 95);
    expect(
      resolveProviderFallback({
        providers: [claude, full],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        belowPercent: 90,
        anyReady: true,
      }),
    ).toBeNull();
    const signedOut = provider("codex", "codex", 5, { auth: { status: "unauthenticated" } });
    expect(canTakeTurn(signedOut)).toBe(false);
    const refusing = provider("codex", "codex", 5, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        windows: [],
        ordinaryUsageAllowed: false,
      },
    });
    expect(
      resolveProviderFallback({
        providers: [claude, refusing],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        anyReady: true,
      }),
    ).toBeNull();
  });
});

describe("shouldSwitchBeforeTurn", () => {
  it("switches only under the switch rule at or past the threshold", () => {
    const at = (action: "ask" | "wait" | "switch", percent: number | null) => ({
      providerLimitAction: action,
      providerLimitSwitchAtPercent: percent,
    });
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", 90), nowMs: now })).toBe(
      true,
    );
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", 95), nowMs: now })).toBe(
      false,
    );
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", null), nowMs: now })).toBe(
      false,
    );
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("ask", 90), nowMs: now })).toBe(
      false,
    );
  });

  // The session window resets at 15:00, three hours after `now`.
  const closeTo = (minutesToReset: number, used = 96) =>
    provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: used,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + minutesToReset * 60_000)),
          },
          { id: "weekly", kind: "weekly", label: "Week", usedPercent: 40, resetsAt: later },
        ],
      },
    });
  const waiting = (minutes: number) => ({
    providerLimitAction: "switch" as const,
    providerLimitSwitchAtPercent: 95,
    providerLimitWaitUnderMinutes: minutes,
  });

  it("waits instead of switching when the full window resets within the wait", () => {
    expect(shouldSwitchBeforeTurn({ provider: closeTo(20), rule: waiting(30), nowMs: now })).toBe(
      false,
    );
    expect(shouldSwitchBeforeTurn({ provider: closeTo(45), rule: waiting(30), nowMs: now })).toBe(
      true,
    );
    expect(shouldSwitchBeforeTurn({ provider: closeTo(45), rule: waiting(60), nowMs: now })).toBe(
      false,
    );
    expect(shouldSwitchBeforeTurn({ provider: closeTo(20), rule: waiting(0), nowMs: now })).toBe(
      true,
    );
  });

  it("does not wait while a full window with a far or unknown reset remains", () => {
    const weeklyFull = provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 97,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 20 * 60_000)),
          },
          { id: "weekly", kind: "weekly", label: "Week", usedPercent: 96, resetsAt: later },
        ],
      },
    });
    expect(usageResetAt(weeklyFull, 95, now)).toBe(Date.parse(later));
    expect(shouldSwitchBeforeTurn({ provider: weeklyFull, rule: waiting(30), nowMs: now })).toBe(
      true,
    );
    const noReset = provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 97 }],
      },
    });
    expect(usageResetAt(noReset, 95, now)).toBeNull();
    expect(shouldSwitchBeforeTurn({ provider: noReset, rule: waiting(30), nowMs: now })).toBe(true);
  });

  it("reports the threshold under any rule for the suggestion", () => {
    const ask = { providerLimitSwitchAtPercent: 95, providerLimitWaitUnderMinutes: 30 };
    expect(usageAtThreshold({ provider: closeTo(120), rule: ask, nowMs: now })).toBe(true);
    expect(usageAtThreshold({ provider: closeTo(120, 94), rule: ask, nowMs: now })).toBe(false);
    expect(usageAtThreshold({ provider: closeTo(10), rule: ask, nowMs: now })).toBe(false);
    expect(
      usageAtThreshold({
        provider: closeTo(120),
        rule: { ...ask, providerLimitSwitchAtPercent: null },
        nowMs: now,
      }),
    ).toBe(false);
  });
});

describe("limitStopWaitsForReset", () => {
  const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(now + minutes * 60_000));
  it("waits for a reset within the wait and a short grace after it", () => {
    expect(limitStopWaitsForReset({ resetAt: at(25), waitUnderMinutes: 30, nowMs: now })).toBe(
      true,
    );
    expect(limitStopWaitsForReset({ resetAt: at(-5), waitUnderMinutes: 30, nowMs: now })).toBe(
      true,
    );
  });
  it("acts on a far, unknown or long-passed reset, or with the wait off", () => {
    expect(limitStopWaitsForReset({ resetAt: at(45), waitUnderMinutes: 30, nowMs: now })).toBe(
      false,
    );
    expect(limitStopWaitsForReset({ resetAt: null, waitUnderMinutes: 30, nowMs: now })).toBe(false);
    expect(limitStopWaitsForReset({ resetAt: at(-15), waitUnderMinutes: 30, nowMs: now })).toBe(
      false,
    );
    expect(limitStopWaitsForReset({ resetAt: at(10), waitUnderMinutes: 0, nowMs: now })).toBe(
      false,
    );
    expect(
      limitStopWaitsForReset({ resetAt: at(10), waitUnderMinutes: undefined, nowMs: now }),
    ).toBe(false);
  });
});

describe("limitRestartRequest", () => {
  const threadId = "t1" as never;
  const user = (runId: string, ordinal: number, text: string) =>
    ({ type: "user_message", runId, ordinal, text, attachments: [] }) as never;
  it("resends the first message when the provider never answered", () => {
    expect(
      limitRestartRequest({
        threadId,
        runId: "r1" as never,
        runs: [{ status: "failed" }],
        providerThreads: [{ appThreadId: threadId, nativeThreadRef: null }],
        turnItems: [
          user("r1", 2, "second"),
          user("r1", 1, "Build the login form"),
          user("r0", 1, "other"),
        ],
      }),
    ).toEqual({ text: "Build the login form", attachments: [] });
  });
  it("continues normally once native history exists", () => {
    const turnItems = [user("r2", 1, "Next step")];
    expect(
      limitRestartRequest({
        threadId,
        runId: "r2" as never,
        runs: [{ status: "completed" }, { status: "failed" }],
        providerThreads: [{ appThreadId: threadId, nativeThreadRef: null }],
        turnItems,
      }),
    ).toBeNull();
    expect(
      limitRestartRequest({
        threadId,
        runId: "r2" as never,
        runs: [{ status: "failed" }],
        providerThreads: [{ appThreadId: threadId, nativeThreadRef: { nativeId: "n1" } as never }],
        turnItems,
      }),
    ).toBeNull();
  });
});

describe("Claude API credits", () => {
  const apiKey = provider("claudeApi", "claudeAgent", null, {
    auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
  });
  const current = { instanceId: claude.instanceId, model: "claudeAgent-small" };

  it("continues a subscription thread on the API-key instance, on its own model only", () => {
    expect(resolveApiCreditSelection({ providers: [claude, codex, apiKey], current })).toEqual({
      instanceId: apiKey.instanceId,
      model: "claudeAgent-small",
    });
    expect(
      resolveApiCreditSelection({
        providers: [claude, apiKey],
        current: { instanceId: claude.instanceId, model: "unlisted" },
      }),
    ).toBeNull();
  });

  it("tells an instance with its own Anthropic key from one behind a proxy token", () => {
    // The probe has not named the key yet, but the instance's environment has.
    const unprobed = { ...apiKey, auth: { status: "unknown" as const, apiKeyBilling: true } };
    const proxy = { ...apiKey, auth: { status: "authenticated" as const, type: "apiKey" } };
    expect(isDirectClaudeApiKeyProvider(apiKey)).toBe(true);
    expect(isDirectClaudeApiKeyProvider(unprobed)).toBe(true);
    expect(isDirectClaudeApiKeyProvider(proxy)).toBe(false);
    expect(isDirectClaudeApiKeyProvider(claude)).toBe(false);
    expect(
      isDirectClaudeApiKeyProvider({
        ...codex,
        auth: { status: "authenticated", apiKeyBilling: true },
      }),
    ).toBe(false);
    // Both are paid: neither is ever picked as any ready provider.
    const bedrock = { ...apiKey, auth: { status: "authenticated" as const, type: "bedrock" } };
    expect([apiKey, unprobed, proxy, bedrock, claude].map(isClaudeApiKeyProvider)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(isDirectClaudeApiKeyProvider(bedrock)).toBe(false);
    expect(resolveApiCreditSelection({ providers: [claude, proxy], current })).toBeNull();
    const input = {
      providers: [claude, proxy],
      currentInstanceId: claude.instanceId,
      nowMs: now,
      anyReady: true,
    };
    expect(resolveProviderFallback({ ...input, rule })).toBeNull();
  });

  it("has nowhere to go without a ready API-key instance, or from one", () => {
    expect(resolveApiCreditSelection({ providers: [claude, codex], current })).toBeNull();
    expect(
      resolveApiCreditSelection({ providers: [claude, { ...apiKey, status: "error" }], current }),
    ).toBeNull();
    expect(
      resolveApiCreditSelection({
        providers: [claude, apiKey],
        current: { instanceId: apiKey.instanceId, model: "claudeAgent-small" },
      }),
    ).toBeNull();
    expect(
      resolveApiCreditSelection({
        providers: [codex, apiKey],
        current: { instanceId: codex.instanceId, model: "codex-small" },
      }),
    ).toBeNull();
  });

  it("rotates from an API account that ran out of credits to the next one", () => {
    const second = provider("claudeApi2", "claudeAgent", null, {
      auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
    });
    const onFirst = { instanceId: apiKey.instanceId, model: "claudeAgent-small" };
    expect(
      resolveApiCreditSelection({ providers: [claude, apiKey, second], current: onFirst }),
    ).toBeNull();
    expect(
      resolveApiCreditSelection({
        providers: [claude, apiKey, second],
        current: onFirst,
        rotate: true,
      }),
    ).toEqual({ instanceId: second.instanceId, model: "claudeAgent-small" });
    // Never rotates onto the subscription or from one.
    expect(
      resolveApiCreditSelection({ providers: [claude, apiKey], current: onFirst, rotate: true }),
    ).toBeNull();
    expect(
      resolveApiCreditSelection({ providers: [claude, apiKey], current, rotate: true }),
    ).toBeNull();
  });

  it("lists every API account a limited thread can continue on", () => {
    const second = provider("claudeApi2", "claudeAgent", null, {
      auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
    });
    const proxy = provider("claudeProxy", "claudeAgent", null, {
      auth: { status: "authenticated", type: "apiKey" },
    });
    expect(
      resolveApiCreditSelections({ providers: [claude, apiKey, proxy, second, codex], current }),
    ).toEqual([
      { instanceId: apiKey.instanceId, model: "claudeAgent-small" },
      { instanceId: second.instanceId, model: "claudeAgent-small" },
    ]);
    // From a proxy thread nothing moves: it is billed per token already.
    expect(
      resolveApiCreditSelections({
        providers: [proxy, apiKey],
        current: { instanceId: proxy.instanceId, model: "claudeAgent-small" },
      }),
    ).toEqual([]);
  });

  it("offers xAI and OpenAI API keys for Grok and Codex threads", () => {
    const grok = provider("grok", "grok", 100, {
      auth: { status: "authenticated", type: "cached_token" },
    });
    const grokApi = provider("grokApi", "grok", null, {
      auth: { status: "authenticated", type: "api_key", label: "xAI API key" },
    });
    const codexApi = provider("codexApi", "codex", null, {
      auth: { status: "authenticated", type: "apiKey" },
    });
    expect([grok, grokApi, codex, codexApi, apiKey, claude].map(isApiCreditProvider)).toEqual([
      false,
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(
      resolveApiCreditSelections({
        providers: [grok, grokApi, codexApi, apiKey],
        current: { instanceId: grok.instanceId, model: "grok-default" },
      }),
    ).toEqual([{ instanceId: grokApi.instanceId, model: "grok-default" }]);
    expect(
      resolveApiCreditSelections({
        providers: [codex, grokApi, codexApi],
        current: { instanceId: codex.instanceId, model: "codex-small" },
      }),
    ).toEqual([{ instanceId: codexApi.instanceId, model: "codex-small" }]);
    // The automatic rule stays Claude's own.
    expect(
      resolveApiCreditSelection({
        providers: [grok, grokApi],
        current: { instanceId: grok.instanceId, model: "grok-default" },
      }),
    ).toBeNull();
  });

  it("recognises the API's out-of-credit refusal", () => {
    expect(
      isApiCreditExhaustedMessage(
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    ).toBe(true);
    expect(
      isApiCreditExhaustedMessage(
        "Credit balance too low · Add funds: https://platform.claude.com/settings/billing",
      ),
    ).toBe(true);
    expect(isApiCreditExhaustedMessage("Claude API rate limit reached. Try again later.")).toBe(
      false,
    );
    expect(isApiCreditExhaustedMessage(undefined)).toBe(false);
  });

  it("does not suggest unverified API capacity even when the rule names it", () => {
    const input = {
      providers: [claude, apiKey],
      currentInstanceId: claude.instanceId,
      nowMs: now,
      anyReady: true,
    };
    expect(resolveProviderFallback({ ...input, rule })).toBeNull();
    const named = { instanceId: apiKey.instanceId, model: "claudeAgent-small" };
    expect(
      resolveProviderFallback({
        ...input,
        rule: { ...rule, providerLimitFallbackModelSelection: named },
      }),
    ).toBeNull();
  });
});

describe("resolveProviderFallback ordering", () => {
  it("prefers the same model on another account of the same driver, then the most headroom", () => {
    const opus = provider("claudeAgent", "claudeAgent", 100);
    const busyCodex = provider("codex", "codex", 70);
    const freeCodex = provider("codex-2", "codex", 10);
    const otherClaude = provider("claude-2", "claudeAgent", 40);
    const input = {
      currentInstanceId: opus.instanceId,
      currentModel: "claudeAgent-small",
      rule,
      nowMs: now,
      anyReady: true,
    };
    expect(
      resolveProviderFallback({ ...input, providers: [opus, busyCodex, freeCodex, otherClaude] }),
    ).toEqual({
      instanceId: otherClaude.instanceId,
      model: "claudeAgent-small",
    });
    expect(resolveProviderFallback({ ...input, providers: [opus, busyCodex, freeCodex] })).toEqual({
      instanceId: freeCodex.instanceId,
      model: "codex-default",
    });
  });

  it("skips selections this stop already tried at every step, without a fallback order", () => {
    const opus = provider("claudeAgent", "claudeAgent", 100);
    const otherClaude = provider("claude-2", "claudeAgent", 40);
    const freeCodex = provider("codex-2", "codex", 10);
    const providers = [opus, otherClaude, freeCodex];
    const sameModel = { instanceId: otherClaude.instanceId, model: "claudeAgent-small" };
    const codexDefault = { instanceId: freeCodex.instanceId, model: "codex-default" };
    const input = {
      providers,
      currentInstanceId: opus.instanceId,
      currentModel: "claudeAgent-small",
      rule,
      nowMs: now,
    };
    const tried = (...selections: ReadonlyArray<{ instanceId: string; model: string }>) =>
      new Set(selections.map((selection) => fallbackSelectionKey(selection as never)));
    // Same model elsewhere, then any ready provider.
    expect(resolveProviderFallback({ ...input, anyReady: true })).toEqual(sameModel);
    expect(
      resolveProviderFallback({ ...input, anyReady: true, excludedSelections: tried(sameModel) }),
    ).toEqual(codexDefault);
    expect(
      resolveProviderFallback({
        ...input,
        anyReady: true,
        excludedSelections: tried(sameModel, codexDefault),
      }),
    ).toBeNull();
    // The legacy single model, the project default and the coordinator's model.
    const others = { ...input, providers: [opus, freeCodex] };
    for (const step of [
      { rule: { ...rule, providerLimitFallbackModelSelection: codexDefault } },
      { rule: { ...rule, defaultModelSelection: codexDefault } },
      { proven: codexDefault },
    ]) {
      expect(resolveProviderFallback({ ...others, ...step })).toEqual(codexDefault);
      expect(
        resolveProviderFallback({ ...others, ...step, excludedSelections: tried(codexDefault) }),
      ).toBeNull();
    }
    expect(
      resolveSameModelElsewhere({
        providers,
        current: { instanceId: opus.instanceId, model: "claudeAgent-small" },
        nowMs: now,
        excludedSelections: tried(sameModel),
      }),
    ).toBeNull();
  });

  it("skips instances a current stop marks as limited", () => {
    expect(
      resolveProviderFallback({
        providers: [claude, codex],
        currentInstanceId: claude.instanceId,
        rule,
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: new Set([codex.instanceId]),
      }),
    ).toBeNull();
  });
});

describe("Gemini and Vertex spend", () => {
  const gemini = provider("acpRegistry_gemini", "acpRegistry", null, {
    displayName: "Gemini CLI",
    auth: { status: "authenticated", type: "oauth-personal" },
  });
  const vertex = provider("custom-agent", "acpRegistry", null, {
    auth: { status: "authenticated", type: "vertex-ai" },
  });
  const antigravity = provider("antigravity", "antigravity", 15);

  it("treats the Gemini CLI and Vertex as per-token, and leaves Antigravity alone", () => {
    expect(isGeminiSpendProvider(gemini)).toBe(true);
    expect(isPerTokenProvider(gemini)).toBe(true);
    expect(isGeminiSpendProvider(provider("acpRegistry_gemini_2", "acpRegistry", null))).toBe(true);
    expect(isGeminiSpendProvider(provider("acpRegistry_gemini_cli", "acpRegistry", null))).toBe(
      true,
    );
    expect(isPerTokenProvider(vertex)).toBe(true);
    expect(isGeminiSpendProvider(antigravity)).toBe(false);
    expect(isPerTokenProvider(antigravity)).toBe(false);
    expect(isPerTokenProvider(codex)).toBe(false);
  });

  it("never falls back onto Gemini, including an order entry or the project default", () => {
    const full = provider("claudeAgent", "claudeAgent", 100);
    const geminiWithRoom = provider("acpRegistry_gemini", "acpRegistry", 10, {
      auth: { status: "authenticated", type: "oauth-personal" },
    });
    const geminiModel = {
      instanceId: geminiWithRoom.instanceId,
      model: "acpRegistry-default",
    };
    const codexModel = { instanceId: codex.instanceId, model: "codex-default" };
    const base = {
      currentInstanceId: full.instanceId,
      currentModel: "claudeAgent-default",
      nowMs: now,
      anyReady: true,
    };
    expect(resolveProviderFallback({ ...base, providers: [full, gemini, codex], rule })).toEqual(
      codexModel,
    );
    expect(
      resolveProviderFallback({ ...base, providers: [full, gemini, vertex], rule }),
    ).toBeNull();
    expect(
      resolveProviderFallback({
        ...base,
        providers: [full, geminiWithRoom],
        rule: { ...rule, defaultModelSelection: geminiModel },
      }),
    ).toBeNull();
    expect(
      describeFallbackOrder({
        providers: [full, geminiWithRoom, codex],
        currentInstanceId: full.instanceId,
        rule: {
          providerLimitFallbackModels: [geminiModel, codexModel],
          providerLimitFallbackModelSelection: null,
        },
        nowMs: now,
      }).map((entry) => entry.unavailable),
    ).toEqual(["per-token", null]);
    expect(
      resolveProviderFallback({
        ...base,
        providers: [full, geminiWithRoom, codex],
        rule: {
          providerLimitFallbackModels: [geminiModel, codexModel],
          defaultModelSelection: null,
          providerLimitFallbackModelSelection: null,
        },
      }),
    ).toEqual(codexModel);
    expect(
      resolveProviderFallback({
        ...base,
        providers: [full, antigravity],
        rule,
      }),
    ).toEqual({ instanceId: antigravity.instanceId, model: "antigravity-default" });
  });

  it.each(["gemini-api-key", "agent-platform"])(
    "blocks Antigravity's paid %s sign-in from automatic fallback",
    (type) => {
      const paid = provider("antigravity", "antigravity", 10, {
        auth: { status: "authenticated", type },
      });
      expect(isGeminiSpendProvider(paid)).toBe(true);
      expect(isPerTokenProvider(paid)).toBe(true);
      expect(
        resolveProviderFallback({
          providers: [provider("claudeAgent", "claudeAgent", 100), paid, codex],
          currentInstanceId: claude.instanceId,
          rule: {
            ...rule,
            defaultModelSelection: { instanceId: paid.instanceId, model: "antigravity-default" },
          },
          nowMs: now,
          anyReady: true,
        }),
      ).toEqual({ instanceId: codex.instanceId, model: "codex-default" });
    },
  );
});

describe("resolveCoordinatorTurnSelection", () => {
  const saved = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claudeAgent-default",
  };
  const onCodex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-x" };
  const fullRule = (action: "ask" | "wait" | "switch") => ({
    ...rule,
    providerLimitAction: action,
    providerLimitSwitchAtPercent: 95,
    providerLimitWaitUnderMinutes: 0,
  });
  const pick = (over: Partial<Parameters<typeof resolveCoordinatorTurnSelection>[0]>) =>
    resolveCoordinatorTurnSelection({
      saved,
      thread: saved,
      providers: [provider("claudeAgent", "claudeAgent", 40), codex],
      rule: fullRule("switch"),
      nowMs: now,
      ...over,
    });

  it.each(nativeDenials)(
    "routes away from a denied saved provider below the threshold: %j",
    (denial) => {
      const denied = provider("claudeAgent", "claudeAgent", 10);
      const providers = [{ ...denied, usageLimits: { ...denied.usageLimits!, ...denial } }, codex];
      expect(pick({ providers })).toEqual({
        selection: { instanceId: codex.instanceId, model: "codex-default" },
        reason: "fallback",
      });
      expect(pick({ providers, thread: onCodex })).toEqual({
        selection: onCodex,
        reason: "staying-on-fallback",
      });
    },
  );

  it("keeps the saved model while its provider has room", () => {
    expect(pick({})).toEqual({ selection: saved, reason: "saved" });
    expect(pick({ thread: onCodex })).toEqual({ selection: saved, reason: "saved" });
  });

  it("stays on the fallback while the saved provider is full, under any rule", () => {
    const providers = [provider("claudeAgent", "claudeAgent", 100), codex];
    for (const action of ["ask", "wait", "switch"] as const)
      expect(pick({ providers, thread: onCodex, rule: fullRule(action) })).toEqual({
        selection: onCodex,
        reason: "staying-on-fallback",
      });
  });

  it("moves to the cheapest fallback only under switch", () => {
    const providers = [provider("claudeAgent", "claudeAgent", 97), codex];
    expect(pick({ providers })).toEqual({
      selection: { instanceId: codex.instanceId, model: "codex-default" },
      reason: "fallback",
    });
    expect(pick({ providers, rule: fullRule("ask") })).toEqual({
      selection: saved,
      reason: "no-fallback",
    });
  });

  it("treats a current limit stop as full even when the usage read shows room", () => {
    expect(pick({ limitedInstanceIds: new Set([saved.instanceId]) }).reason).toBe("fallback");
  });

  it("waits for a reset within the project's wait instead of switching", () => {
    const soon = DateTime.formatIso(DateTime.makeUnsafe(now + 10 * 60_000));
    const providers = [
      provider("claudeAgent", "claudeAgent", null, {
        usageLimits: {
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: soon,
            },
          ],
        },
      }),
      codex,
    ];
    expect(
      pick({ providers, rule: { ...fullRule("switch"), providerLimitWaitUnderMinutes: 30 } }),
    ).toEqual({
      selection: saved,
      reason: "saved-resets-soon",
    });
  });

  it("goes back to the saved model once the fallback fills up and nothing else has room", () => {
    const providers = [provider("claudeAgent", "claudeAgent", 100), provider("codex", "codex", 99)];
    expect(pick({ providers, thread: onCodex })).toEqual({
      selection: saved,
      reason: "no-fallback",
    });
  });
});

describe("review follow-ups", () => {
  const saved = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claudeAgent-default",
  };
  const onCodex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-x" };
  const switchRule = {
    ...rule,
    providerLimitAction: "switch" as const,
    providerLimitSwitchAtPercent: 95,
    providerLimitWaitUnderMinutes: 0,
  };

  it("stays off the saved model after a failed run there until a newer usage read", () => {
    const stale = provider("claudeAgent", "claudeAgent", 10, {
      usageLimits: { ...claude.usageLimits!, checkedAt: earlier },
    });
    const input = { saved, thread: onCodex, rule: switchRule, nowMs: now };
    const stoppedAfterRead = Date.parse(earlier) + 60_000;
    expect(
      resolveCoordinatorTurnSelection({
        ...input,
        providers: [stale, codex],
        savedStoppedAtMs: stoppedAfterRead,
      }).reason,
    ).toBe("staying-on-fallback");
    const fresh = provider("claudeAgent", "claudeAgent", 10, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1_000)),
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 10, resetsAt: later },
        ],
      },
    });
    expect(
      resolveCoordinatorTurnSelection({
        ...input,
        providers: [fresh, codex],
        savedStoppedAtMs: stoppedAfterRead,
      }).reason,
    ).toBe("saved");
    const unread = provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1_000)),
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    });
    expect(
      resolveCoordinatorTurnSelection({
        ...input,
        providers: [unread, codex],
        savedStoppedAtMs: stoppedAfterRead,
      }).reason,
    ).toBe("staying-on-fallback");
  });

  it("does not stay on a per-token instance without the API-credit rule", () => {
    const keyed = provider("claude-key", "claudeAgent", null, {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    const thread = { instanceId: keyed.instanceId, model: "claudeAgent-default" };
    const providers = [provider("claudeAgent", "claudeAgent", 100), keyed, codex];
    expect(
      resolveCoordinatorTurnSelection({ saved, thread, providers, rule: switchRule, nowMs: now }),
    ).toEqual({
      selection: { instanceId: codex.instanceId, model: "codex-default" },
      reason: "fallback",
    });
    expect(
      resolveCoordinatorTurnSelection({
        saved,
        thread,
        providers,
        rule: { ...switchRule, providerLimitUseApiCredits: true },
        nowMs: now,
      }).reason,
    ).toBe("staying-on-fallback");
  });

  it.each([
    provider("acpRegistry_gemini", "acpRegistry", null),
    provider("custom-vertex", "acpRegistry", null, {
      auth: { status: "authenticated", type: "vertex-ai" },
    }),
    ...["gemini-api-key", "agent-platform"].map((type) =>
      provider("antigravity", "antigravity", null, {
        auth: { status: "authenticated", type },
      }),
    ),
  ])("leaves a prior Gemini/Vertex fallback despite API-credit consent: $instanceId", (paid) => {
    const thread = { instanceId: paid.instanceId, model: "acpRegistry-default" };
    const providers = [provider("claudeAgent", "claudeAgent", 100), paid, codex];
    expect(
      resolveCoordinatorTurnSelection({
        saved,
        thread,
        providers,
        rule: { ...switchRule, providerLimitUseApiCredits: true },
        nowMs: now,
      }),
    ).toEqual({
      selection: { instanceId: codex.instanceId, model: "codex-default" },
      reason: "fallback",
    });
    expect(
      resolveCoordinatorTurnSelection({
        saved: thread,
        thread,
        providers,
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({ selection: thread, reason: "saved" });
  });

  it("leaves redeeming and credits to the limit sweep before switching", () => {
    const providers = [provider("claudeAgent", "claudeAgent", 100), codex];
    for (const flag of ["providerLimitRedeemResets", "providerLimitSpendCredits"] as const)
      expect(
        resolveCoordinatorTurnSelection({
          saved,
          thread: saved,
          providers,
          rule: { ...switchRule, [flag]: true },
          nowMs: now,
        }),
      ).toEqual({ selection: saved, reason: "rule-steps-first" });
  });

  it("never picks a per-token Codex and ranks unknown usage last", () => {
    const keyedCodex = provider("codex-key", "codex", null, {
      auth: { status: "authenticated", type: "apiKey" },
    });
    const unknown = provider("codex-unknown", "codex", null);
    const busy = provider("codex-busy", "codex", 60);
    const input = { currentInstanceId: claude.instanceId, rule, nowMs: now, anyReady: true };
    expect(
      resolveProviderFallback({ ...input, providers: [claude, keyedCodex, unknown, busy] })
        ?.instanceId,
    ).toBe(busy.instanceId);
    expect(resolveProviderFallback({ ...input, providers: [claude, keyedCodex] })).toBeNull();
  });
});

const switchRule = {
  ...rule,
  providerLimitAction: "switch" as const,
  providerLimitSwitchAtPercent: 100,
};

describe("model-scoped windows", () => {
  const withFable = (fableUsed: number, weeklyUsed = 40): ServerProvider => ({
    ...claude,
    usageLimits: {
      checkedAt: claude.usageLimits!.checkedAt,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: 10, resetsAt: later },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt: later,
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          modelScope: "Fable",
          usedPercent: fableUsed,
          resetsAt: later,
        },
      ],
    },
  });

  it("counts a spent Fable weekly only against Fable", () => {
    const full = withFable(100);
    expect(providerUsedPercent(full, now, "claude-opus-5-5")).toBe(40);
    expect(providerUsedPercent(full, now, "claude-fable-5-1")).toBe(100);
    expect(providerUsedPercent(full, now)).toBe(40);
  });

  it("keeps Opus on Claude while only the Fable weekly is spent", () => {
    const saved = { instanceId: claude.instanceId, model: "claude-opus-5-5" };
    const input = {
      saved,
      thread: { instanceId: codex.instanceId, model: "codex-default" },
      providers: [withFable(100), codex],
      rule: switchRule,
      nowMs: now,
    };
    expect(resolveCoordinatorTurnSelection(input).reason).toBe("saved");
    expect(coordinatorOnLimitFallback(input)).toBe(false);
    const fableSaved = { ...input, saved: { ...saved, model: "claude-fable-5-1" } };
    expect(coordinatorOnLimitFallback(fableSaved)).toBe(true);
  });
});

describe("coordinatorOnLimitFallback", () => {
  const saved = { instanceId: claude.instanceId, model: "claudeAgent-default" };
  const base = {
    saved,
    providers: [provider("claudeAgent", "claudeAgent", 18), codex],
    rule: switchRule,
    nowMs: now,
  };

  it("is false on the saved instance and when the saved provider has room", () => {
    expect(coordinatorOnLimitFallback({ ...base, thread: saved })).toBe(false);
    // Another instance alone is no limit: the stale scheduled-task case.
    expect(
      coordinatorOnLimitFallback({
        ...base,
        thread: { instanceId: codex.instanceId, model: "codex-default" },
      }),
    ).toBe(false);
  });

  it("is true once the saved provider is full or stopped on a limit", () => {
    const thread = { instanceId: codex.instanceId, model: "codex-default" };
    expect(
      coordinatorOnLimitFallback({
        ...base,
        thread,
        providers: [provider("claudeAgent", "claudeAgent", 100), codex],
      }),
    ).toBe(true);
    expect(
      coordinatorOnLimitFallback({
        ...base,
        thread,
        limitedInstanceIds: new Set([claude.instanceId]),
      }),
    ).toBe(true);
  });
});

describe("coordinatorFallbackReason", () => {
  const saved = { instanceId: claude.instanceId, model: "claude-opus-5-5" };
  const withWindows = (
    windows: ReadonlyArray<{ id: string; label: string; used: number; resetsAt?: string }>,
  ): ServerProvider => ({
    ...claude,
    usageLimits: {
      checkedAt: claude.usageLimits!.checkedAt,
      windows: windows.map((window) => ({
        id: window.id,
        kind: window.id === "five_hour" ? ("session" as const) : ("weekly" as const),
        label: window.label,
        usedPercent: window.used,
        resetsAt: window.resetsAt ?? later,
      })),
    },
  });
  const reason = (provider: ServerProvider, limited = false) =>
    coordinatorFallbackReason({
      saved,
      providers: [provider, codex],
      rule: { ...switchRule, providerLimitSwitchAtPercent: 95 },
      nowMs: now,
      ...(limited ? { limitedInstanceIds: new Set([claude.instanceId]) } : {}),
    });

  it("names the spent window that keeps the saved model out and when it resets", () => {
    expect(
      reason(
        withWindows([
          { id: "five_hour", label: "Session", used: 0 },
          { id: "seven_day", label: "Weekly", used: 100 },
        ]),
      ),
    ).toEqual({ text: "weekly limit reached", resetsAt: Date.parse(later) });
  });

  it("names the window past the switch threshold, then a usage-limit response", () => {
    expect(reason(withWindows([{ id: "five_hour", label: "Session", used: 96 }])).text).toBe(
      "session at 96% used",
    );
    expect(reason(withWindows([{ id: "five_hour", label: "Session", used: 40 }]), true).text).toBe(
      "returned a usage limit",
    );
  });

  it("ignores a spent model window that does not apply to the saved model", () => {
    expect(
      reason(
        withWindows([
          { id: "five_hour", label: "Session", used: 96 },
          { id: "seven_day_fable", label: "Weekly · Fable", used: 100 },
        ]),
      ).text,
    ).toBe("session at 96% used");
  });
});

describe("workers and their coordinator", () => {
  const claudeSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claudeAgent-default",
  };
  const copilotSelection = {
    instanceId: ProviderInstanceId.make("copilot"),
    model: "claude-opus-5.5",
  };
  // An agent that reports no usage at all, as Copilot does.
  const copilot = provider("copilot", "acpRegistry", null);
  const spentClaude = provider("claudeAgent", "claudeAgent", 100);
  const roomyClaude = provider("claudeAgent", "claudeAgent", 40);
  const switchRule = {
    ...rule,
    providerLimitAction: "switch" as const,
    providerLimitSwitchAtPercent: 95,
    providerLimitWaitUnderMinutes: 30,
  };
  const launch = (over: Partial<Parameters<typeof resolveWorkerLaunchSelection>[0]>) =>
    resolveWorkerLaunchSelection({
      preferred: claudeSelection,
      coordinator: copilotSelection,
      providers: [spentClaude, copilot],
      rule: switchRule,
      nowMs: now,
      ...over,
    });

  it("starts a worker on the project's worker model while it has room", () => {
    expect(launch({ providers: [roomyClaude, copilot] })).toEqual({
      selection: claudeSelection,
      reason: "preferred",
    });
  });

  it("starts a worker where the coordinator runs when the worker model is spent", () => {
    expect(launch({})).toEqual({ selection: copilotSelection, reason: "coordinator" });
    const denied = {
      ...roomyClaude,
      usageLimits: { ...roomyClaude.usageLimits!, ordinaryUsageAllowed: false },
    };
    expect(launch({ providers: [denied, copilot] }).reason).toBe("coordinator");
    expect(
      launch({
        providers: [roomyClaude, copilot],
        limitedInstanceIds: new Set([claudeSelection.instanceId]),
      }).reason,
    ).toBe("coordinator");
  });

  it("keeps the worker model under the wait rule or a reset within the wait", () => {
    expect(launch({ rule: { ...switchRule, providerLimitAction: "wait" } })).toEqual({
      selection: claudeSelection,
      reason: "waits-for-reset",
    });
    // The spent window resets at 15:00, three hours on; a four-hour wait covers it.
    expect(launch({ rule: { ...switchRule, providerLimitWaitUnderMinutes: 240 } })).toEqual({
      selection: claudeSelection,
      reason: "preferred-resets-soon",
    });
  });

  it("falls back to another provider with room when the coordinator cannot take it", () => {
    const signedOut = { ...copilot, auth: { status: "unauthenticated" as const } };
    expect(launch({ providers: [spentClaude, signedOut, codex] })).toEqual({
      selection: { instanceId: codex.instanceId, model: "codex-default" },
      reason: "fallback",
    });
    expect(launch({ coordinator: claudeSelection, providers: [spentClaude, codex] }).reason).toBe(
      "fallback",
    );
    const paid = { ...copilot, auth: { status: "authenticated" as const, type: "apiKey" } };
    expect(launch({ providers: [spentClaude, paid] })).toEqual({
      selection: claudeSelection,
      reason: "no-room",
    });
  });

  it("offers the coordinator's model to a stopped worker without a usage read", () => {
    const pick = (proven: typeof copilotSelection | null, limited?: ReadonlySet<string>) =>
      resolveProviderFallback({
        providers: [spentClaude, copilot],
        currentInstanceId: claudeSelection.instanceId,
        currentModel: claudeSelection.model,
        rule,
        nowMs: now,
        belowPercent: 95,
        anyReady: true,
        proven,
        ...(limited === undefined ? {} : { limitedInstanceIds: limited }),
      });
    // Copilot never reports usage, so it counts as having room until a stop
    // there marks it limited.
    expect(pick(null)).toEqual({ instanceId: copilot.instanceId, model: "acpRegistry-default" });
    expect(pick(null, new Set([copilot.instanceId]))).toBeNull();
    expect(pick(copilotSelection)).toEqual(copilotSelection);
    const fullCopilot = provider("copilot", "acpRegistry", 97);
    expect(
      resolveProviderFallback({
        providers: [spentClaude, fullCopilot],
        currentInstanceId: claudeSelection.instanceId,
        rule,
        nowMs: now,
        belowPercent: 95,
        proven: copilotSelection,
      }),
    ).toBeNull();
  });

  it("treats the coordinator as proven only while it is not stopped on the limit", () => {
    const worker = { id: "worker" as never, providerInstanceId: claudeSelection.instanceId };
    const coordinator = {
      id: "coordinator" as never,
      providerInstanceId: copilotSelection.instanceId,
      modelSelection: copilotSelection,
      status: "completed",
    };
    expect(provenFallbackSelection(worker, coordinator)).toEqual(copilotSelection);
    expect(
      provenFallbackSelection(worker, {
        ...coordinator,
        status: "failed",
        lastErrorClass: "usage_limit",
      }),
    ).toBeNull();
    expect(provenFallbackSelection({ ...worker, id: coordinator.id }, coordinator)).toBeNull();
    expect(
      provenFallbackSelection(
        { ...worker, providerInstanceId: copilotSelection.instanceId },
        coordinator,
      ),
    ).toBeNull();
    expect(provenFallbackSelection(worker, null)).toBeNull();
  });
});

describe("the recommended model from another provider", () => {
  const opusOn = (
    id: string,
    driver: string,
    used: number | null,
    slug: string,
    extra: { isCustom?: boolean } = {},
  ) => {
    const base = provider(id, driver, used);
    return {
      ...base,
      models: [
        ...base.models,
        { slug, name: "Claude Opus 5.5", isCustom: extra.isCustom ?? false, capabilities: null },
      ],
    };
  };
  const opus = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  const spentClaude = opusOn("claudeAgent", "claudeAgent", 100, "claude-opus-5-5");
  // Copilot reports no usage; the person added Opus 5.5 to it as a custom model.
  const copilot = opusOn("copilot", "acpRegistry", null, "claude-opus-5.5", { isCustom: true });
  const workCopilot = opusOn("copilot-work", "acpRegistry", null, "claude-opus-5.5");
  const otherClaude = opusOn("claude-2", "claudeAgent", 20, "claude-opus-5-5");
  const codexRoomy = provider("codex", "codex", 10);
  const switchRule = {
    ...rule,
    providerLimitAction: "switch" as const,
    providerLimitSwitchAtPercent: 95,
  };

  it("starts a worker on the same model from another provider before anything else", () => {
    const codexSelection = { instanceId: codexRoomy.instanceId, model: "codex-default" };
    expect(
      resolveWorkerLaunchSelection({
        preferred: opus,
        coordinator: codexSelection,
        providers: [spentClaude, codexRoomy, copilot],
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({
      selection: { instanceId: copilot.instanceId, model: "claude-opus-5.5" },
      reason: "same-model",
    });
    // A stop there marks it limited: then the coordinator's model.
    expect(
      resolveWorkerLaunchSelection({
        preferred: opus,
        coordinator: codexSelection,
        providers: [spentClaude, codexRoomy, copilot],
        rule: switchRule,
        nowMs: now,
        limitedInstanceIds: new Set([copilot.instanceId]),
      }),
    ).toEqual({ selection: codexSelection, reason: "coordinator" });
  });

  it("tries the project's listed providers in order, then the same driver, then verified room", () => {
    const pick = (order?: ReadonlyArray<string>) =>
      resolveSameModelElsewhere({
        providers: [spentClaude, copilot, workCopilot, otherClaude],
        current: opus,
        order: order?.map((id) => ProviderInstanceId.make(id)),
        nowMs: now,
        belowPercent: 95,
      });
    // Another Claude account keeps the effort option; a Copilot pick drops it.
    expect(pick()).toEqual({
      instanceId: otherClaude.instanceId,
      model: "claude-opus-5-5",
      options: opus.options,
    });
    expect(pick(["copilot-work", "copilot"])).toEqual({
      instanceId: workCopilot.instanceId,
      model: "claude-opus-5.5",
    });
  });

  it("moves a coordinator stopped on its spent subscription to the same model elsewhere", () => {
    expect(
      resolveProviderFallback({
        providers: [spentClaude, codexRoomy, copilot],
        currentInstanceId: spentClaude.instanceId,
        currentModel: opus.model,
        rule: switchRule,
        nowMs: now,
        belowPercent: 95,
        anyReady: true,
      }),
    ).toEqual({ instanceId: copilot.instanceId, model: "claude-opus-5.5" });
    // Never onto a provider billed per token, even with the same model.
    const paid = { ...copilot, auth: { status: "authenticated" as const, type: "apiKey" } };
    expect(
      resolveSameModelElsewhere({
        providers: [spentClaude, paid],
        current: opus,
        nowMs: now,
      }),
    ).toBeNull();
  });
});

describe("the user's fallback order", () => {
  // Codex lists GPT-6 Astra and GPT-6.1 Sol; Astra has its own weekly window.
  const codexModels = (used: number, astraUsed: number) => {
    const base = provider("codex", "codex", used);
    return {
      ...base,
      models: [
        { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
        { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null },
      ],
      usageLimits: {
        ...base.usageLimits!,
        windows: [
          ...base.usageLimits!.windows,
          {
            id: "weekly_astra",
            kind: "weekly" as const,
            label: "Week",
            modelScope: "astra",
            usedPercent: astraUsed,
            resetsAt: later,
          },
        ],
      },
    } satisfies ServerProvider;
  };
  const opus = {
    ...provider("claudeAgent", "claudeAgent", 10),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
  } satisfies ServerProvider;
  const copilot = {
    ...provider("copilot", "acpRegistry", null),
    models: [{ slug: "claude-opus-5.5", name: "Opus 5.5", isCustom: false, capabilities: null }],
  } satisfies ServerProvider;
  const astra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
  const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const claudeOpus = { instanceId: opus.instanceId, model: "claude-opus-5-5" };
  const order = {
    ...rule,
    providerLimitFallbackModels: [astra, sol, claudeOpus],
  };

  it("continues a limited Claude thread on the first entry, before the same model elsewhere", () => {
    expect(
      resolveProviderFallback({
        providers: [opus, codexModels(20, 30), copilot],
        currentInstanceId: opus.instanceId,
        currentModel: "claude-opus-5-5",
        rule: order,
        nowMs: now,
        belowPercent: 95,
        anyReady: true,
      }),
    ).toEqual(astra);
  });

  it("takes the next entry when the first one's own window is full", () => {
    const providers = [opus, codexModels(20, 100), copilot];
    expect(
      resolveProviderFallback({
        providers,
        currentInstanceId: opus.instanceId,
        rule: order,
        nowMs: now,
        belowPercent: 95,
      }),
    ).toEqual(sol);
    const entries = describeFallbackOrder({
      providers,
      currentInstanceId: opus.instanceId,
      rule: order,
      nowMs: now,
      belowPercent: 95,
    });
    expect(entries.map((entry) => entry.unavailable)).toEqual(["full", null, "current"]);
    expect(entries[0]!.resetAt).toBe(Date.parse(later));
  });

  it("serves the reverse direction from the same order", () => {
    expect(
      resolveProviderFallback({
        providers: [opus, codexModels(100, 100), copilot],
        currentInstanceId: ProviderInstanceId.make("codex"),
        currentModel: "gpt-6-astra",
        rule: order,
        nowMs: now,
        belowPercent: 95,
        limitedInstanceIds: new Set(["codex"]),
      }),
    ).toEqual(claudeOpus);
  });

  it("falls through to the old steps when no entry can take the thread", () => {
    expect(
      resolveProviderFallback({
        providers: [opus, codexModels(100, 100), copilot],
        currentInstanceId: opus.instanceId,
        currentModel: "claude-opus-5-5",
        rule: order,
        nowMs: now,
        belowPercent: 95,
      }),
    ).toEqual({ instanceId: copilot.instanceId, model: "claude-opus-5.5" });
  });

  it("names why an entry is out: signed out, missing, per-token, limited", () => {
    const signedOut = { ...codexModels(10, 10), auth: { status: "unauthenticated" as const } };
    const apiKey = { ...opus, auth: { status: "authenticated" as const, type: "apiKey" } };
    const entries = describeFallbackOrder({
      providers: [signedOut, apiKey, copilot],
      currentInstanceId: ProviderInstanceId.make("other"),
      rule: {
        ...rule,
        providerLimitFallbackModels: [
          astra,
          claudeOpus,
          { instanceId: copilot.instanceId, model: "gone" },
          { instanceId: copilot.instanceId, model: "claude-opus-5.5" },
        ],
      },
      nowMs: now,
      limitedInstanceIds: new Set(["copilot"]),
    });
    expect(entries.map((entry) => entry.unavailable)).toEqual([
      "signed-out",
      "per-token",
      "missing",
      "limited",
    ]);
  });

  it("never offers an instance that can't open a session here", () => {
    // The managed Copilot agent that was never prepared on this machine.
    const unprepared = {
      ...copilot,
      installed: false,
      status: "warning" as const,
      auth: { status: "unknown" as const },
    };
    const entries = describeFallbackOrder({
      providers: [unprepared],
      currentInstanceId: ProviderInstanceId.make("other"),
      rule: {
        ...rule,
        providerLimitFallbackModels: [{ instanceId: copilot.instanceId, model: "claude-opus-5.5" }],
      },
      nowMs: now,
    });
    expect(entries.map((entry) => entry.unavailable)).toEqual(["not-ready"]);
  });

  it("keeps the legacy single fallback after the same model elsewhere", () => {
    expect(
      resolveProviderFallback({
        providers: [opus, codexModels(20, 30), copilot],
        currentInstanceId: opus.instanceId,
        currentModel: "claude-opus-5-5",
        rule: { ...rule, providerLimitFallbackModelSelection: astra },
        nowMs: now,
        belowPercent: 95,
      }),
    ).toEqual({ instanceId: copilot.instanceId, model: "claude-opus-5.5" });
  });
});

describe("agents whose billing is unknown", () => {
  const opus = (slug: string) => [
    { slug, name: "Claude Opus 5.5", isCustom: false, isDefault: true, capabilities: null },
  ];
  const registryIcon = (agent: string) =>
    `https://cdn.agentclientprotocol.com/registry/v1/latest/${agent}.svg`;
  const spentClaude = provider("claudeAgent", "claudeAgent", 100, { models: opus("claude-opus-5-5") });
  const copilot = provider("acpRegistry_copilot", "acpRegistry", null, {
    iconUrl: registryIcon("github-copilot-cli"),
    models: opus("claude-opus-5.5"),
  });
  const devin = provider("acpRegistry_devin", "acpRegistry", null, {
    displayName: "Devin",
    iconUrl: registryIcon("devin"),
    models: opus("claude-opus-5-5-medium"),
  });
  const switchRule = { ...rule, providerLimitFallbackModels: [] };
  const fallback = (over: Partial<Parameters<typeof resolveProviderFallback>[0]> = {}) =>
    resolveProviderFallback({
      providers: [spentClaude, copilot, devin],
      currentInstanceId: spentClaude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: switchRule,
      nowMs: now,
      belowPercent: 100,
      anyReady: true,
      ...over,
    });

  it("names Devin and other registry agents, never verified Copilot; missing branding fails closed", () => {
    expect(isUnknownBillingAgent(devin)).toBe(true);
    expect(isUnknownBillingAgent(copilot)).toBe(false);
    expect(isUnknownBillingAgent(provider("custom", "acpRegistry", null))).toBe(true);
    expect(isUnknownBillingAgent(spentClaude)).toBe(false);
  });

  it("keeps Copilot as the same-model fallback", () => {
    expect(fallback()).toEqual({ instanceId: copilot.instanceId, model: "claude-opus-5.5" });
  });

  it("does not move a thread onto Devin when Copilot is limited too", () => {
    const limited = new Set([copilot.instanceId]);
    expect(fallback({ limitedInstanceIds: limited })).toBeNull();
    expect(
      fallback({
        limitedInstanceIds: limited,
        proven: { instanceId: devin.instanceId, model: "claude-opus-5-5-medium" },
      }),
    ).toBeNull();
  });

  it("uses Devin when the person named it", () => {
    const limited = new Set([copilot.instanceId]);
    const named = { instanceId: devin.instanceId, model: "claude-opus-5-5-medium" };
    expect(
      fallback({ limitedInstanceIds: limited, rule: { ...switchRule, providerLimitFallbackModels: [named] } }),
    ).toEqual(named);
    expect(
      fallback({
        limitedInstanceIds: limited,
        rule: { ...switchRule, defaultModelProviders: [devin.instanceId] },
      }),
    ).toEqual(named);
  });
  it("rejects missing or misleading branding in implicit routes", () => {
    for (const candidate of [
      { ...devin, iconUrl: undefined },
      { ...devin, displayName: "GitHub Copilot" },
    ]) {
      expect(fallback({ providers: [spentClaude, candidate] })).toBeNull();
      expect(fallback({ providers: [spentClaude, candidate], currentModel: undefined })).toBeNull();
    }
  });

  it("preserves a configured project default", () => {
    const named = { instanceId: devin.instanceId, model: "claude-opus-5-5-medium" };
    expect(fallback({
      providers: [spentClaude, devin],
      rule: { ...switchRule, defaultModelSelection: named },
    })).toEqual(named);
  });

  it("does not inherit an unknown-billing coordinator after the preferred plan is spent", () => {
    const preferred = { instanceId: spentClaude.instanceId, model: "claude-opus-5-5" };
    const result = resolveWorkerLaunchSelection({
      preferred,
      coordinator: { instanceId: devin.instanceId, model: "claude-opus-5-5-medium" },
      providers: [spentClaude, devin],
      rule: { ...switchRule, providerLimitAction: "switch", providerLimitSwitchAtPercent: 100, providerLimitWaitUnderMinutes: 0 },
      nowMs: now,
    });
    expect(result).toEqual({ selection: preferred, reason: "no-room" });
  });

  it.each([undefined, "subscription", "local"] as const)(
    "never automatically selects an explicitly disabled provider with %s billing",
    (billing) => {
      const disabled = { ...devin, enabled: false,
        models: devin.models.map((model) => ({ ...model, ...(billing ? { billing } : {}) })),
      };
      const named = { instanceId: disabled.instanceId, model: "claude-opus-5-5-medium" };
      for (const overrides of [
        {},
        { proven: named },
        { rule: { ...switchRule, providerLimitFallbackModels: [named] } },
        { rule: { ...switchRule, defaultModelSelection: named } },
        { rule: { ...switchRule, defaultModelProviders: [disabled.instanceId] } },
      ]) {
        expect(fallback({ providers: [spentClaude, disabled], ...overrides })).toBeNull();
      }
      expect(resolveWorkerLaunchSelection({
        preferred: { instanceId: spentClaude.instanceId, model: "claude-opus-5-5" },
        coordinator: named,
        providers: [spentClaude, disabled],
        rule: { ...switchRule, providerLimitAction: "switch", providerLimitSwitchAtPercent: 100,
          providerLimitWaitUnderMinutes: 0, providerLimitFallbackModels: [named],
          defaultModelProviders: [disabled.instanceId] },
        nowMs: now,
      }).reason).toBe("no-room");
    },
  );

});
