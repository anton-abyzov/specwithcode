import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fallbackSelectionKey,
  isPerTokenProvider,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";

// October 22, 2026: the coordinator hit Claude's session limit, moved to
// Copilot managed (monthly quota spent), then to the second Copilot instance
// (same quota), and only then to Gemini, while the user had already signed
// the Claude CLI in to the Claude Console so its turns bill API credits.

const now = Date.parse("2026-10-22T14:01:15.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function agent(id: string, driver: string, models: ReadonlyArray<string>, over = {}) {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(now),
    version: null,
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...over,
  } as ServerProvider;
}

const opus = "claude-opus-5-5";
// Signed in to the Claude Console: ready, billed to API credits, no usage read.
const claudeApi = agent("claudeAgent", "claudeAgent", [opus], {
  auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
});
// Still on the claude.ai subscription, out of its session window.
const claudePlan = agent("claudeAgent", "claudeAgent", [opus], {
  usageLimits: {
    checkedAt: iso(now),
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        resetsAt: iso(now + 100 * 60_000),
      },
    ],
  },
});
const copilotIdentity = {
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
};
const copilotManaged = agent(
  "acpRegistry_copilot",
  "acpRegistry",
  ["claude-opus-5.5"],
  copilotIdentity,
);
const copilot = agent("copilot-0889", "acpRegistry", ["claude-opus-5.5"], copilotIdentity);
const gemini = agent("acpRegistry_gemini", "acpRegistry", ["gemini-default"]);
const home = { instanceId: claudeApi.instanceId, model: opus };
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: home,
};

describe("a project default billed to API credits", () => {
  const stopOnCopilot = (claude: ServerProvider, over = {}) =>
    resolveProviderFallback({
      providers: [claude, copilotManaged, copilot, gemini],
      currentInstanceId: copilotManaged.instanceId,
      currentModel: "claude-opus-5.5",
      rule,
      nowMs: now,
      belowPercent: 100,
      anyReady: true,
      limitedInstanceIds: new Set([copilotManaged.instanceId]),
      ...over,
    });

  it("takes a thread back home before another Copilot instance", () => {
    expect(stopOnCopilot(claudeApi)).toEqual(home);
  });

  it("still goes to the next provider while the subscription home is full", () => {
    expect(stopOnCopilot(claudePlan)).toEqual({
      instanceId: copilot.instanceId,
      model: "claude-opus-5.5",
    });
  });

  it("skips home when it is limited, signed out, or already tried for this stop", () => {
    const sibling = { instanceId: copilot.instanceId, model: "claude-opus-5.5" };
    expect(
      stopOnCopilot(claudeApi, {
        limitedInstanceIds: new Set([copilotManaged.instanceId, claudeApi.instanceId]),
      }),
    ).toEqual(sibling);
    expect(
      stopOnCopilot({ ...claudeApi, auth: { ...claudeApi.auth, status: "unauthenticated" } }),
    ).toEqual(sibling);
    expect(
      stopOnCopilot(claudeApi, { excludedSelections: new Set([fallbackSelectionKey(home)]) }),
    ).toEqual(sibling);
  });

  it("comes after verified free room on another account", () => {
    // Claude Max #2 has room on the same model: no paid credits before it.
    const max2 = agent("claude-2", "claudeAgent", [opus], {
      usageLimits: {
        checkedAt: iso(now),
        nativeAllowanceObservedAt: iso(now),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 10,
            resetsAt: iso(now + 100 * 60_000),
          },
        ],
      },
    });
    const max1 = { ...claudePlan, instanceId: ProviderInstanceId.make("claude-1") };
    expect(
      resolveProviderFallback({
        providers: [claudeApi, max1, max2],
        currentInstanceId: max1.instanceId,
        currentModel: opus,
        rule,
        nowMs: now,
        belowPercent: 100,
        anyReady: true,
      }),
    ).toEqual({ instanceId: max2.instanceId, model: opus });
  });

  it("keeps the same model on another account with verified room ahead of any default", () => {
    const room = (id: string, driver: string, model: string) =>
      agent(id, driver, [model], {
        usageLimits: {
          checkedAt: iso(now),
          nativeAllowanceObservedAt: iso(now),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              resetsAt: iso(now + 100 * 60_000),
            },
          ],
        },
      });
    const claude2 = room("claudeAgent_2", "claudeAgent", opus);
    const codex = room("codex", "codex", "gpt-6");
    expect(
      resolveProviderFallback({
        providers: [claudePlan, claude2, codex],
        currentInstanceId: claudePlan.instanceId,
        currentModel: opus,
        rule: { ...rule, defaultModelSelection: { instanceId: codex.instanceId, model: "gpt-6" } },
        nowMs: now,
        belowPercent: 100,
      }),
    ).toEqual({ instanceId: claude2.instanceId, model: opus });
  });

  it("is never picked when it is not the project's default", () => {
    // Gemini is never an automatic fallback either, so nothing is left.
    expect(
      stopOnCopilot(claudeApi, {
        rule: { ...rule, defaultModelSelection: null },
        limitedInstanceIds: new Set([copilotManaged.instanceId, copilot.instanceId]),
      }),
    ).toBeNull();
  });

  it("is never a Gemini or Vertex default, which bills a Cloud project", () => {
    const vertexHome = agent("acpRegistry_gemini", "acpRegistry", ["gemini-default"], {
      auth: { status: "authenticated", type: "vertex-ai" },
    });
    const geminiHome = { instanceId: vertexHome.instanceId, model: "gemini-default" };
    expect(
      stopOnCopilot(claudeApi, {
        providers: [claudeApi, copilotManaged, copilot, vertexHome],
        rule: { ...rule, defaultModelSelection: geminiHome },
        limitedInstanceIds: new Set([copilotManaged.instanceId, copilot.instanceId]),
      }),
    ).toBeNull();
  });

  it("keeps a legacy single fallback ahead of the default", () => {
    const codex = agent("codex", "codex", ["gpt-5.5"], {
      usageLimits: {
        checkedAt: iso(now),
        nativeAllowanceObservedAt: iso(now),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 10,
            resetsAt: iso(now + 100 * 60_000),
          },
        ],
      },
    });
    const legacy = { instanceId: codex.instanceId, model: "gpt-5.5" };
    expect(
      stopOnCopilot(claudeApi, {
        providers: [claudeApi, copilotManaged, codex],
        rule: { ...rule, providerLimitFallbackModelSelection: legacy },
      }),
    ).toEqual(legacy);
  });

  it("does not start new workers on it by itself", () => {
    // Worker launch passes no default: a per-token instance stays opt-in there.
    const { selection } = resolveWorkerLaunchSelection({
      preferred: { instanceId: copilotManaged.instanceId, model: "claude-opus-5.5" },
      coordinator: null,
      providers: [claudeApi, copilotManaged, gemini],
      rule,
      nowMs: now,
      limitedInstanceIds: new Set([copilotManaged.instanceId]),
    });
    expect(selection.instanceId).not.toBe(claudeApi.instanceId);
  });
});

describe("a coordinator stopped on a Claude plan limit", () => {
  const onCopilot = { instanceId: copilot.instanceId, model: "claude-opus-5.5" };
  const pick = (claude: ServerProvider, savedStopWasPlanLimit: boolean) =>
    resolveCoordinatorTurnSelection({
      saved: home,
      thread: onCopilot,
      providers: [claude, copilotManaged, copilot, gemini],
      rule,
      nowMs: now,
      savedStoppedAtMs: now - 11 * 60_000,
      savedStopWasPlanLimit,
    });

  it("returns to the saved Claude once its CLI bills API credits", () => {
    expect(pick(claudeApi, true)).toEqual({ selection: home, reason: "saved" });
  });

  it("keeps off it while the stop was an API limit, or the login is still the plan", () => {
    expect(pick(claudeApi, false)).toEqual({
      selection: onCopilot,
      reason: "staying-on-fallback",
    });
    expect(pick(claudePlan, true)).toEqual({
      selection: onCopilot,
      reason: "staying-on-fallback",
    });
  });
});

describe("Gemini CLI on Vertex AI", () => {
  // A Google Cloud project billed per token: never an automatic fallback.
  const vertex = agent("acpRegistry_gemini", "acpRegistry", ["gemini-default"], {
    auth: { status: "unknown", type: "vertex-ai" },
  });
  const googleLogin = { ...vertex, auth: { status: "unknown", type: "oauth-personal" } };

  it("is billed per token, like any Gemini sign-in, while a Cursor key is not", () => {
    expect(isPerTokenProvider(vertex as ServerProvider)).toBe(true);
    expect(isPerTokenProvider(googleLogin as ServerProvider)).toBe(true);
    expect(isPerTokenProvider(copilot)).toBe(false);
    // Cursor key instances still read plan usage, so they stay ordinary candidates.
    const cursorKey = agent("cursor", "cursor", ["auto"], {
      auth: { status: "authenticated", type: "api-key" },
    });
    expect(isPerTokenProvider(cursorKey)).toBe(false);
  });

  it("is skipped by the any-ready step while the API-billed default takes the thread home", () => {
    const stop = (over = {}) =>
      resolveProviderFallback({
        providers: [claudeApi, copilotManaged, vertex as ServerProvider],
        currentInstanceId: copilotManaged.instanceId,
        currentModel: "claude-opus-5.5",
        rule: { ...rule, defaultModelSelection: null },
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: new Set([copilotManaged.instanceId]),
        ...over,
      });
    expect(stop()).toBeNull();
    expect(stop({ rule })).toEqual(home);
  });
});
