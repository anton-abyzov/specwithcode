import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  type ModelBilling,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  describeFallbackOrder,
  type ProviderFallbackRule,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveSameModelElsewhere,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
const piModel = "anthropic/claude-sonnet-5";

/** A Pi instance: its own sign-in, no usage reads, ready, serving one model. */
const pi = (billing?: ModelBilling): ServerProvider => ({
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "pi" },
  checkedAt: fresh,
  version: null,
  models: [
    {
      slug: piModel,
      name: "Claude Sonnet 5",
      isCustom: false,
      isDefault: true,
      capabilities: null,
      ...(billing === undefined ? {} : { billing }),
    },
  ],
  slashCommands: [],
  skills: [],
});

/** A Claude subscription that ran out. */
const claude: ServerProvider = {
  ...pi(),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  auth: { status: "authenticated" },
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  usageLimits: {
    checkedAt: fresh,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
  },
};

const piSelection: ModelSelection = { instanceId: ProviderInstanceId.make("pi"), model: piModel };
const claudeSelection: ModelSelection = {
  instanceId: claude.instanceId,
  model: "claude-opus-5-5",
};
const switchRule: ProviderFallbackRule = {
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: null,
};

const anyReady = (provider: ServerProvider) =>
  resolveProviderFallback({
    providers: [claude, provider],
    currentInstanceId: claude.instanceId,
    currentModel: "claude-opus-5-5",
    rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
    nowMs: now,
    anyReady: true,
  });
const ordered = (provider: ServerProvider) =>
  resolveProviderFallback({
    providers: [claude, provider],
    currentInstanceId: claude.instanceId,
    rule: {
      providerLimitFallbackModelSelection: null,
      providerLimitFallbackModels: [piSelection],
      defaultModelSelection: null,
    },
    nowMs: now,
  });
const described = (provider: ServerProvider) =>
  describeFallbackOrder({
    providers: [claude, provider],
    currentInstanceId: claude.instanceId,
    rule: { providerLimitFallbackModelSelection: piSelection },
    nowMs: now,
  })[0]?.unavailable;

describe("a Pi model billed per token by OpenRouter", () => {
  const paid = pi("paid-router");

  it("is never picked by the fallback, from any ready provider or the user's order", () => {
    expect(anyReady(paid)).toBeNull();
    expect(ordered(paid)).toBeNull();
    expect(
      resolveProviderFallback({
        providers: [claude, paid],
        currentInstanceId: claude.instanceId,
        rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: piSelection },
        nowMs: now,
        proven: piSelection,
      }),
    ).toBeNull();
  });

  it("shows as per-token in the fallback order", () => {
    expect(described(paid)).toBe("per-token");
    expect(described(pi("api"))).toBe("per-token");
  });

  it("is not the same model elsewhere, a worker launch target or a place to stay", () => {
    expect(
      resolveSameModelElsewhere({
        providers: [{ ...claude, models: paid.models }, paid],
        current: { instanceId: claude.instanceId, model: piModel },
        nowMs: now,
      }),
    ).toBeNull();
    expect(
      resolveWorkerLaunchSelection({
        preferred: claudeSelection,
        coordinator: piSelection,
        providers: [claude, paid],
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({ selection: claudeSelection, reason: "no-room" });
    const stay = (provider: ServerProvider, providerLimitUseApiCredits: boolean) =>
      resolveCoordinatorTurnSelection({
        saved: claudeSelection,
        thread: piSelection,
        providers: [claude, provider],
        rule: { ...switchRule, providerLimitUseApiCredits },
        nowMs: now,
      }).reason;
    expect(stay(paid, false)).not.toBe("staying-on-fallback");
    expect(stay(paid, true)).not.toBe("staying-on-fallback");
    expect(stay(pi(), false)).toBe("staying-on-fallback");
  });
});

describe.each([["local" as const], [undefined]])("a Pi model with billing %s", (billing) => {
  const free = pi(billing);

  it("stays usable as before", () => {
    expect(anyReady(free)).toEqual(piSelection);
    expect(ordered(free)).toEqual(piSelection);
    expect(described(free)).toBeNull();
    expect(
      resolveWorkerLaunchSelection({
        preferred: claudeSelection,
        coordinator: piSelection,
        providers: [claude, free],
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({ selection: piSelection, reason: "coordinator" });
  });
});
