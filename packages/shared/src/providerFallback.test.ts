import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canTakeTurn,
  limitRestartRequest,
  providerUsedPercent,
  isClaudeApiKeyProvider,
  isDirectClaudeApiKeyProvider,
  resolveApiCreditSelection,
  resolveProviderFallback,
  limitStopWaitsForReset,
  shouldSwitchBeforeTurn,
  usageAtThreshold,
  usageResetAt,
} from "./providerFallback.ts";

const now = Date.parse("2026-10-09T12:00:00.000Z");
const later = "2026-10-09T15:00:00.000Z";
const earlier = "2026-10-09T11:00:00.000Z";

function provider(id: string, driver: string, used: number | null, over: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: earlier,
    version: null,
    models: [
      { slug: `${driver}-small`, name: "Small", isCustom: false, capabilities: null },
      { slug: `${driver}-default`, name: "Default", isCustom: false, isDefault: true, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: earlier,
            windows: [
              { id: "five_hour", kind: "session", label: "Session", usedPercent: used, resetsAt: later },
              { id: "old", kind: "weekly", label: "Week", usedPercent: 100, resetsAt: earlier },
            ],
          },
        }),
    ...over,
  };
}

const claude = provider("claudeAgent", "claudeAgent", 93);
const codex = provider("codex", "codex", 20);
const rule = { providerLimitFallbackModelSelection: null, defaultModelSelection: null };

describe("providerUsedPercent", () => {
  it("takes the fullest window that has not reset", () => {
    expect(providerUsedPercent(claude, now)).toBe(93);
    expect(providerUsedPercent(provider("x", "codex", null), now)).toBeNull();
  });
});

describe("resolveProviderFallback", () => {
  it("prefers the project's fallback, then its default, then any ready provider", () => {
    const fallback = { instanceId: codex.instanceId, model: "gpt-chosen" };
    expect(
      resolveProviderFallback({ providers: [claude, codex], currentInstanceId: claude.instanceId, rule: { ...rule, providerLimitFallbackModelSelection: fallback }, nowMs: now }),
    ).toEqual(fallback);
    expect(
      resolveProviderFallback({ providers: [claude, codex], currentInstanceId: claude.instanceId, rule, nowMs: now }),
    ).toBeNull();
    expect(
      resolveProviderFallback({ providers: [claude, codex], currentInstanceId: claude.instanceId, rule, nowMs: now, anyReady: true }),
    ).toEqual({ instanceId: codex.instanceId, model: "codex-default" });
  });

  it("goes back to the default model when the thread already runs on the fallback", () => {
    const back = { instanceId: claude.instanceId, model: "opus" };
    const target = resolveProviderFallback({
      providers: [provider("claudeAgent", "claudeAgent", 10), codex],
      currentInstanceId: codex.instanceId,
      rule: { providerLimitFallbackModelSelection: { instanceId: codex.instanceId, model: "gpt" }, defaultModelSelection: back },
      nowMs: now,
    });
    expect(target).toEqual(back);
  });

  it("never hands a thread to a provider that is also full, signed out or refusing", () => {
    const full = provider("codex", "codex", 95);
    expect(resolveProviderFallback({ providers: [claude, full], currentInstanceId: claude.instanceId, rule, nowMs: now, belowPercent: 90, anyReady: true })).toBeNull();
    const signedOut = provider("codex", "codex", 5, { auth: { status: "unauthenticated" } });
    expect(canTakeTurn(signedOut)).toBe(false);
    const refusing = provider("codex", "codex", 5, { usageLimits: { checkedAt: earlier, windows: [], ordinaryUsageAllowed: false } });
    expect(resolveProviderFallback({ providers: [claude, refusing], currentInstanceId: claude.instanceId, rule, nowMs: now, anyReady: true })).toBeNull();
  });
});

describe("shouldSwitchBeforeTurn", () => {
  it("switches only under the switch rule at or past the threshold", () => {
    const at = (action: "ask" | "wait" | "switch", percent: number | null) => ({ providerLimitAction: action, providerLimitSwitchAtPercent: percent });
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", 90), nowMs: now })).toBe(true);
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", 95), nowMs: now })).toBe(false);
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("switch", null), nowMs: now })).toBe(false);
    expect(shouldSwitchBeforeTurn({ provider: claude, rule: at("ask", 90), nowMs: now })).toBe(false);
  });

  // The session window resets at 15:00, three hours after `now`.
  const closeTo = (minutesToReset: number, used = 96) =>
    provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: earlier,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: used,
            resetsAt: new Date(now + minutesToReset * 60_000).toISOString(),
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
    expect(shouldSwitchBeforeTurn({ provider: closeTo(20), rule: waiting(30), nowMs: now })).toBe(false);
    expect(shouldSwitchBeforeTurn({ provider: closeTo(45), rule: waiting(30), nowMs: now })).toBe(true);
    expect(shouldSwitchBeforeTurn({ provider: closeTo(45), rule: waiting(60), nowMs: now })).toBe(false);
    expect(shouldSwitchBeforeTurn({ provider: closeTo(20), rule: waiting(0), nowMs: now })).toBe(true);
  });

  it("does not wait while a full window with a far or unknown reset remains", () => {
    const weeklyFull = provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: earlier,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 97,
            resetsAt: new Date(now + 20 * 60_000).toISOString(),
          },
          { id: "weekly", kind: "weekly", label: "Week", usedPercent: 96, resetsAt: later },
        ],
      },
    });
    expect(usageResetAt(weeklyFull, 95, now)).toBe(Date.parse(later));
    expect(shouldSwitchBeforeTurn({ provider: weeklyFull, rule: waiting(30), nowMs: now })).toBe(true);
    const noReset = provider("claudeAgent", "claudeAgent", null, {
      usageLimits: {
        checkedAt: earlier,
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
      usageAtThreshold({ provider: closeTo(120), rule: { ...ask, providerLimitSwitchAtPercent: null }, nowMs: now }),
    ).toBe(false);
  });
});

describe("limitStopWaitsForReset", () => {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  it("waits for a reset within the wait and a short grace after it", () => {
    expect(limitStopWaitsForReset({ resetAt: at(25), waitUnderMinutes: 30, nowMs: now })).toBe(true);
    expect(limitStopWaitsForReset({ resetAt: at(-5), waitUnderMinutes: 30, nowMs: now })).toBe(true);
  });
  it("acts on a far, unknown or long-passed reset, or with the wait off", () => {
    expect(limitStopWaitsForReset({ resetAt: at(45), waitUnderMinutes: 30, nowMs: now })).toBe(false);
    expect(limitStopWaitsForReset({ resetAt: null, waitUnderMinutes: 30, nowMs: now })).toBe(false);
    expect(limitStopWaitsForReset({ resetAt: at(-15), waitUnderMinutes: 30, nowMs: now })).toBe(false);
    expect(limitStopWaitsForReset({ resetAt: at(10), waitUnderMinutes: 0, nowMs: now })).toBe(false);
    expect(limitStopWaitsForReset({ resetAt: at(10), waitUnderMinutes: undefined, nowMs: now })).toBe(false);
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
        turnItems: [user("r1", 2, "second"), user("r1", 1, "Build the login form"), user("r0", 1, "other")],
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
    expect(isDirectClaudeApiKeyProvider({ ...codex, auth: { status: "authenticated", apiKeyBilling: true } })).toBe(false);
    // Both are paid: neither is ever picked as any ready provider.
    const bedrock = { ...apiKey, auth: { status: "authenticated" as const, type: "bedrock" } };
    expect([apiKey, unprobed, proxy, bedrock, claude].map(isClaudeApiKeyProvider)).toEqual([true, true, true, true, false]);
    expect(isDirectClaudeApiKeyProvider(bedrock)).toBe(false);
    expect(resolveApiCreditSelection({ providers: [claude, proxy], current })).toBeNull();
    const input = { providers: [claude, proxy], currentInstanceId: claude.instanceId, nowMs: now, anyReady: true };
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

  it("is never the any-ready fallback, only one the rule names", () => {
    const input = { providers: [claude, apiKey], currentInstanceId: claude.instanceId, nowMs: now, anyReady: true };
    expect(resolveProviderFallback({ ...input, rule })).toBeNull();
    const named = { instanceId: apiKey.instanceId, model: "claudeAgent-small" };
    expect(
      resolveProviderFallback({ ...input, rule: { ...rule, providerLimitFallbackModelSelection: named } }),
    ).toEqual(named);
  });
});
