import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  type ModelBilling,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { isPaidModel } from "./modelBilling.ts";
import {
  describeFallbackOrder,
  isPerTokenProvider,
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

describe("a Pi model whose billing Pi reports as unknown", () => {
  // Pi on `anthropic` cannot tell a Claude Max login from an API key, so a
  // priced Claude model reads `unknown`: it may bill per token.
  const unknown = pi("unknown");

  it("is never picked by itself: not from any ready provider, the same model or a worker launch", () => {
    expect(anyReady(unknown)).toBeNull();
    expect(
      resolveSameModelElsewhere({
        providers: [{ ...claude, models: unknown.models }, unknown],
        current: { instanceId: claude.instanceId, model: piModel },
        nowMs: now,
      }),
    ).toBeNull();
    expect(
      resolveProviderFallback({
        providers: [{ ...claude, models: unknown.models }, unknown],
        currentInstanceId: claude.instanceId,
        currentModel: piModel,
        rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
        nowMs: now,
        anyReady: true,
      }),
    ).toBeNull();
    expect(
      resolveProviderFallback({
        providers: [claude, unknown],
        currentInstanceId: claude.instanceId,
        rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
        nowMs: now,
        anyReady: true,
        proven: piSelection,
      }),
    ).toBeNull();
    expect(
      resolveWorkerLaunchSelection({
        preferred: claudeSelection,
        coordinator: piSelection,
        providers: [claude, unknown],
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({ selection: claudeSelection, reason: "no-room" });
  });

  it("stays a choice the person can make: their fallback order and provider order still reach it", () => {
    expect(ordered(unknown)).toEqual(piSelection);
    expect(described(unknown)).toBeNull();
    expect(
      resolveSameModelElsewhere({
        providers: [{ ...claude, models: unknown.models }, unknown],
        current: { instanceId: claude.instanceId, model: piModel },
        order: [unknown.instanceId],
        nowMs: now,
      }),
    ).toEqual(piSelection);
  });
});

describe("a Cursor instance signed in with an API key", () => {
  // PR #599: a Cursor API key draws on the Cursor plan, so it is not billed
  // per token. Automatic fallback may pick it only on a plan usage read.
  const cursorModel = "composer-2";
  const cursorSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("cursor"),
    model: cursorModel,
  };
  const cursorKey = (usageLimits?: ServerProvider["usageLimits"]): ServerProvider => ({
    ...pi(),
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    auth: { status: "authenticated", type: "api-key", label: "Cursor API key" },
    models: [
      {
        slug: cursorModel,
        name: "Composer 2",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    ...(usageLimits === undefined ? {} : { usageLimits }),
  });
  // What CursorDriver publishes for a key without CURSOR_AUTH_TOKEN.
  const unread = cursorKey({
    checkedAt: fresh,
    windows: [],
    unavailable: { reason: "unsupported" },
  });
  const planRead = cursorKey({
    checkedAt: fresh,
    windows: [{ id: "totalPercentUsed", kind: "monthly", label: "Total", usedPercent: 20 }],
  });
  const noUsage = cursorKey();
  const ready = (provider: ServerProvider) =>
    resolveProviderFallback({
      providers: [claude, provider],
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
      nowMs: now,
      anyReady: true,
    });

  it("is not per-token, so its plan room makes it an ordinary candidate", () => {
    expect(isPerTokenProvider(planRead)).toBe(false);
    expect(isPaidModel(planRead, cursorModel)).toBe(false);
    expect(ready(planRead)).toEqual(cursorSelection);
  });

  it("is never picked by itself without a plan usage read", () => {
    // The production shape: usage unavailable, so no usable capacity.
    expect(ready(unread)).toBeNull();
    // A snapshot without usage at all is not free room either.
    expect(ready(noUsage)).toBeNull();
    expect(
      resolveProviderFallback({
        providers: [claude, noUsage],
        currentInstanceId: claude.instanceId,
        rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
        nowMs: now,
        anyReady: true,
        proven: cursorSelection,
      }),
    ).toBeNull();
    expect(
      resolveWorkerLaunchSelection({
        preferred: claudeSelection,
        coordinator: cursorSelection,
        providers: [claude, noUsage],
        rule: switchRule,
        nowMs: now,
      }),
    ).toEqual({ selection: claudeSelection, reason: "no-room" });
  });

  it("stays reachable when the person named it in the fallback order", () => {
    expect(
      resolveProviderFallback({
        providers: [claude, noUsage],
        currentInstanceId: claude.instanceId,
        rule: {
          providerLimitFallbackModelSelection: null,
          providerLimitFallbackModels: [cursorSelection],
          defaultModelSelection: null,
        },
        nowMs: now,
      }),
    ).toEqual(cursorSelection);
  });
});
