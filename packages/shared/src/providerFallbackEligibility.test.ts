import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProviderFallback, FALLBACK_USAGE_MAX_AGE_MS } from "./providerFallback.ts";
const now = Date.parse("2026-10-14T13:00:00Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
const candidate = (over: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("grok"),
  driver: ProviderDriverKind.make("grok"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: fresh,
  version: null,
  models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: fresh,
    windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 20 }],
  },
  ...over,
});
const pick = (provider: ServerProvider, named = false) =>
  resolveProviderFallback({
    providers: [provider],
    currentInstanceId: ProviderInstanceId.make("codex"),
    nowMs: now,
    anyReady: true,
    rule: {
      defaultModelSelection: null,
      providerLimitFallbackModelSelection: named
        ? { instanceId: provider.instanceId, model: "grok-4.7" }
        : null,
    },
  });
describe("usable fallback evidence", () => {
  it("offers a freshly authenticated account with headroom", () =>
    expect(pick(candidate())?.model).toBe("grok-4.7"));
  it.each([false, true])("fails closed for unknown or invalid capacity, named=%s", (named) => {
    const base = candidate();
    for (const over of [
      { auth: { status: "unknown" as const } },
      {
        usageLimits: {
          ...base.usageLimits!,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - FALLBACK_USAGE_MAX_AGE_MS - 1)),
        },
      },
      {
        usageLimits: {
          ...base.usageLimits!,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)),
        },
      },
      { usageLimits: { ...base.usageLimits!, unavailable: { reason: "probeFailed" as const } } },
      { usageLimits: { ...base.usageLimits!, windows: [] } },
      { usageLimits: { ...base.usageLimits!, ordinaryUsageAllowed: false } },
      { usageLimits: { ...base.usageLimits!, spendControlReached: true } },
      { usageLimits: { ...base.usageLimits!, nativeDenialObservedAt: fresh } },
      {
        usageLimits: {
          ...base.usageLimits!,
          windows: [{ ...base.usageLimits!.windows[0]!, usedPercent: 100 }],
        },
      },
      {
        usageLimits: {
          ...base.usageLimits!,
          windows: [{ ...base.usageLimits!.windows[0]!, resetsAt: fresh }],
        },
      },
      { models: [] },
      { models: [{ ...base.models[0]!, isCustom: true }] },
    ])
      expect(pick(candidate(over), named)).toBeNull();
  });
  it.each([false, true])(
    "takes a provider that reports no usage only while it can take a turn, named=%s",
    (named) => {
      const silent = { usageLimits: undefined };
      expect(pick(candidate(silent), named)?.model).toBe("grok-4.7");
      for (const over of [
        { status: "error" as const },
        { enabled: false },
        { auth: { status: "unauthenticated" as const } },
        { auth: { status: "authenticated" as const, type: "api_key" } },
      ])
        expect(pick(candidate({ ...silent, ...over }), named)).toBeNull();
    },
  );
  it("requires renewed allowance when an exhausted window resets despite another active window", () => {
    const base = candidate();
    expect(
      pick(
        candidate({
          usageLimits: {
            ...base.usageLimits!,
            windows: [
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 100,
                resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now - 60000)),
              },
              {
                id: "weekly",
                kind: "weekly",
                label: "Week",
                usedPercent: 20,
                resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60000)),
              },
            ],
          },
        }),
      ),
    ).toBeNull();
  });
  it("does not infer paid API availability from Grok's api_key auth type", () => {
    expect(pick(candidate({ auth: { status: "authenticated", type: "api_key" } }))).toBeNull();
  });
  it("rejects an explicitly configured model absent from account discovery", () => {
    expect(
      pick(candidate({ models: [{ ...candidate().models[0]!, slug: "other" }] }), true)?.model,
    ).toBe("other");
  });
});
