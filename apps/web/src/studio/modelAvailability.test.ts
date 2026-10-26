import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availabilityDisabledReason,
  availabilityText,
  isAvailabilityBlocking,
  modelAvailability,
  USAGE_FRESH_MS,
} from "./modelAvailability";

const now = Date.parse("2026-10-21T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const session = (usedPercent: number, resetIn = 2 * HOUR): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: iso(now + resetIn),
});
const weekly = (usedPercent: number, resetIn = 50 * HOUR): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: iso(now + resetIn),
});
const fableWeekly = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent,
  resetsAt: iso(now + 30 * HOUR),
  modelScope: "Fable",
});

const claude = (
  windows: ServerProviderUsageWindow[] | null,
  over: Partial<ServerProvider> = {},
  checkedAt = now - 60_000,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(now),
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  ...(windows === null ? {} : { usageLimits: { checkedAt: iso(checkedAt), windows } }),
  ...over,
});

const copilot = (): ServerProvider => ({
  ...claude(null),
  instanceId: ProviderInstanceId.make("github-copilot"),
  driver: ProviderDriverKind.make("acpRegistry"),
});

const text = (provider: ServerProvider, model: string | null) =>
  availabilityText(modelAvailability({ provider, model, nowMs: now }), {
    provider: "Claude",
    nowMs: now,
  });

describe("modelAvailability", () => {
  it("reports the least room left across the windows that apply", () => {
    const state = modelAvailability({
      provider: claude([session(38), weekly(82)]),
      model: "claude-opus-5-5",
      nowMs: now,
    });
    expect(state).toMatchObject({
      kind: "room",
      leftPercent: 18,
      tone: "warn",
      binding: { label: "Weekly", scope: "account" },
    });
    expect(isAvailabilityBlocking(state)).toBe(false);
  });

  it("blocks every model when an account-wide window is spent, naming its reset", () => {
    const provider = claude([session(100, 90 * 60_000), weekly(40)]);
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state).toMatchObject({ kind: "exhausted", binding: { scope: "account" } });
    expect(isAvailabilityBlocking(state)).toBe(true);
    expect(text(provider, "claude-opus-5-5").short).toBe("5-hour limit reached · resets in 1h 30m");
    expect(text(provider, "claude-opus-5-5").label).toBe("5-hour limit reached, resets in 1h 30m");
    expect(text(provider, "claude-opus-5-5").long).toContain(
      "Every Claude model on the account shares it",
    );
  });

  it("blocks only the model family a scoped window caps", () => {
    const provider = claude([session(20), weekly(30), fableWeekly(100)]);
    const fable = modelAvailability({ provider, model: "claude-fable-5-1", nowMs: now });
    const opus = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(fable).toMatchObject({
      kind: "exhausted",
      binding: { scope: "model", family: "Fable" },
    });
    expect(opus).toMatchObject({ kind: "room", leftPercent: 70 });
    expect(text(provider, "claude-fable-5-1").short).toBe("Fable limit reached · resets in 1d 6h");
    expect(text(provider, "claude-fable-5-1").long).toContain("It counts only Fable models");
    // The provider as a whole (the rail) is not out because one family is.
    expect(modelAvailability({ provider, model: null, nowMs: now }).kind).toBe("room");
  });

  it("keeps a spent model selectable while the provider still accepts turns", () => {
    const provider = claude(null, {
      usageLimits: {
        checkedAt: iso(now - 60_000),
        windows: [session(100)],
        ordinaryUsageAllowed: true,
      },
    });
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state).toMatchObject({ kind: "exhausted", providerAllows: true });
    expect(isAvailabilityBlocking(state)).toBe(false);
    expect(text(provider, "claude-opus-5-5").short).toBe("5-hour limit reached · still accepted");
    expect(text(provider, "claude-opus-5-5").label).toBe(
      "5-hour limit reached, extra usage allowed",
    );
  });

  it("never disables on an old read, even one that showed the limit reached", () => {
    const provider = claude([weekly(100)], {}, now - USAGE_FRESH_MS - 60_000);
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state).toMatchObject({ kind: "stale", wasExhausted: true });
    expect(isAvailabilityBlocking(state)).toBe(false);
    expect(text(provider, "claude-opus-5-5").short).toBe("Limit reached 16m ago");
  });

  it("treats a reset that passed since the read as unknown, not as room", () => {
    const provider = claude([session(100, -5 * 60_000)]);
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state).toMatchObject({ kind: "stale", resetSinceRead: true, leftPercent: null });
    expect(isAvailabilityBlocking(state)).toBe(false);
    expect(text(provider, "claude-opus-5-5").short).toBe("Reset since last read");
    // Another window's room is no proof either: the reset one could hold anything now.
    const mixed = claude([session(100, -5 * 60_000), weekly(54)]);
    expect(
      modelAvailability({ provider: mixed, model: "claude-opus-5-5", nowMs: now }),
    ).toMatchObject({ kind: "stale", resetSinceRead: true, leftPercent: 46 });
    // A live spent window still proves the model is out.
    const spent = claude([session(100, -5 * 60_000), weekly(100)]);
    expect(modelAvailability({ provider: spent, model: "claude-opus-5-5", nowMs: now }).kind).toBe(
      "exhausted",
    );
  });

  it("follows the provider's own denial while it is fresh", () => {
    const denied = claude([session(60)], {
      usageLimits: {
        checkedAt: iso(now - 60_000),
        windows: [session(60)],
        ordinaryUsageAllowed: false,
        rateLimitReachedType: "spend cap",
      },
    });
    const state = modelAvailability({ provider: denied, model: "claude-opus-5-5", nowMs: now });
    expect(state.kind).toBe("denied");
    expect(availabilityDisabledReason(state, { provider: "Claude", nowMs: now })).toContain(
      "spend cap",
    );
    const old = claude(null, {
      usageLimits: {
        checkedAt: iso(now - 2 * HOUR),
        windows: [session(60)],
        ordinaryUsageAllowed: false,
      },
    });
    expect(modelAvailability({ provider: old, model: "x", nowMs: now }).kind).toBe("stale");
  });

  it("keeps honest states for missing telemetry and never blocks on them", () => {
    const cases = [
      [modelAvailability({ provider: undefined, model: "m", nowMs: now }), "loading"],
      [modelAvailability({ provider: claude(null), model: "m", nowMs: now }), "loading"],
      [
        modelAvailability({
          provider: claude(null, { checkedAt: iso(now - 2 * HOUR) }),
          model: "m",
          nowMs: now,
        }),
        "unknown",
      ],
      [
        modelAvailability({
          provider: claude(null, { auth: { status: "unauthenticated" } }),
          model: "m",
          nowMs: now,
        }),
        "unknown",
      ],
      [
        modelAvailability({ provider: copilot(), model: "claude-opus-5.5", nowMs: now }),
        "unreported",
      ],
      [
        modelAvailability({
          provider: claude(null, {
            auth: { status: "authenticated", type: "apiKey" },
          }),
          model: "m",
          nowMs: now,
        }),
        "perToken",
      ],
      [
        modelAvailability({
          provider: claude(null, {
            usageLimits: {
              checkedAt: iso(now),
              windows: [],
              unavailable: { reason: "probeFailed" },
            },
          }),
          model: "m",
          nowMs: now,
        }),
        "unknown",
      ],
      [
        modelAvailability({
          provider: claude([weekly(100)]),
          model: "m",
          nowMs: now,
          connected: false,
          machineLabel: "M4",
        }),
        "offline",
      ],
    ] as const;
    for (const [state, kind] of cases) {
      expect(state.kind).toBe(kind);
      expect(isAvailabilityBlocking(state)).toBe(false);
      const words = availabilityText(state, { provider: "Claude", nowMs: now });
      // Unknown is never shown as a number.
      expect(words.short).not.toMatch(/\b(0|100)%/);
    }
  });

  it("keeps native Claude and GitHub Copilot Claude apart", () => {
    const native = claude([weekly(100)]);
    expect(modelAvailability({ provider: native, model: "claude-opus-5-5", nowMs: now }).kind).toBe(
      "exhausted",
    );
    expect(
      modelAvailability({ provider: copilot(), model: "claude-opus-5.5", nowMs: now }).kind,
    ).toBe("unreported");
  });

  it("writes the absolute reset time when a formatter is given", () => {
    const state = modelAvailability({
      provider: claude([weekly(100, 3 * HOUR)]),
      model: "claude-opus-5-5",
      nowMs: now,
    });
    const words = availabilityText(state, {
      provider: "Claude",
      nowMs: now,
      formatAt: () => "6:00 PM",
    });
    expect(words.long).toContain("resets 6:00 PM (in 3h 0m)");
  });

  it("keeps a Claude denial through a lookup that had no quota data", () => {
    const base = claude([weekly(100)]);
    const provider = claude(null, {
      usageLimits: {
        ...base.usageLimits!,
        ordinaryUsageAllowed: false,
        unavailable: { reason: "unsupported" },
      },
    });
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state.kind).toBe("denied");
    expect(isAvailabilityBlocking(state)).toBe(true);
    // Windows kept through such a lookup are history, not a fresh read.
    const kept = claude(null, {
      usageLimits: {
        ...claude([session(40)]).usageLimits!,
        unavailable: { reason: "unsupported" },
      },
    });
    expect(modelAvailability({ provider: kept, model: null, nowMs: now }).kind).toBe("stale");
    const empty = claude([], {});
    const unsupported = claude(null, {
      usageLimits: { ...empty.usageLimits!, unavailable: { reason: "unsupported" } },
    });
    expect(modelAvailability({ provider: unsupported, model: null, nowMs: now }).kind).toBe(
      "unreported",
    );
  });

  it("judges a sparse denial by when it was seen, not by the last full read", () => {
    const old = claude([weekly(60)], {}, now - 40 * 60_000);
    const provider = claude(null, {
      usageLimits: {
        ...old.usageLimits!,
        ordinaryUsageAllowed: false,
        nativeDenialObservedAt: iso(now - 30_000),
      },
    });
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(state.kind).toBe("denied");
  });

  it("names the account-wide limit when it and a family limit are both spent", () => {
    const words = text(
      claude([session(100, 2 * HOUR), { ...fableWeekly(100), resetsAt: iso(now + 120 * HOUR) }]),
      "claude-fable-5-1",
    );
    expect(words.short).toMatch(/^5-hour limit reached/);
    expect(words.long).not.toContain("counts only Fable");
  });

  it("keeps the family window for the model row when an account-wide one binds", () => {
    const provider = claude([session(38), weekly(82), fableWeekly(64)]);
    const fable = modelAvailability({ provider, model: "claude-fable-5-1", nowMs: now });
    expect(fable).toMatchObject({
      kind: "room",
      leftPercent: 18,
      binding: { scope: "account" },
      familyRoom: { leftPercent: 36, binding: { scope: "model", family: "Fable" } },
    });
    const opus = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    expect(opus).not.toHaveProperty("familyRoom");
  });

  it("never rounds a window with room down to 0% left", () => {
    const state = modelAvailability({
      provider: claude([session(99.6)]),
      model: null,
      nowMs: now,
    });
    expect(state).toMatchObject({ kind: "room", leftPercent: 1 });
  });

  it("names the window, the plan and the machine, never the email", () => {
    const provider = claude([session(95, 55 * 60_000), weekly(40)]);
    const state = modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now });
    const words = availabilityText(state, {
      provider: "Claude",
      account: "Claude Max",
      machine: "MacBook M4MAX",
      nowMs: now,
    });
    expect(state).toMatchObject({ kind: "room", leftPercent: 5, tone: "warn" });
    expect(words.label).toBe("5% of 5-hour limit left");
    expect(words.long).toBe(
      "5% of the 5-hour limit is left on the Claude Max account on MacBook M4MAX; it resets in 55m. Every Claude model on the account shares it, including use from other machines and apps.",
    );
    expect(words.long).not.toMatch(/@/);
    const fable = availabilityText(
      modelAvailability({
        provider: claude([session(10), fableWeekly(60)]),
        model: "claude-fable-5-1",
        nowMs: now,
      }),
      { provider: "Claude", nowMs: now },
    );
    expect(fable.label).toBe("40% of Fable weekly limit left");
    expect(fable.long).toContain("It counts only Fable models.");
  });

  it("shows nothing of the previous account's reading after an account switch", () => {
    const readAt = now - 60_000;
    const provider = claude(null, {
      usageLimits: {
        checkedAt: iso(readAt),
        windows: [session(30)],
        accountChangedAt: iso(now - 30_000),
      },
    });
    expect(modelAvailability({ provider, model: "claude-opus-5-5", nowMs: now }).kind).toBe(
      "switching",
    );
    const fresh = claude(null, { usageLimits: { checkedAt: iso(readAt), windows: [session(30)] } });
    expect(
      modelAvailability({
        provider: fresh,
        model: "claude-opus-5-5",
        nowMs: now,
        previousAccountReadAt: readAt,
      }).kind,
    ).toBe("switching");
    // The new account's first read shows.
    expect(
      modelAvailability({
        provider: fresh,
        model: "claude-opus-5-5",
        nowMs: now,
        previousAccountReadAt: readAt - 1,
      }).kind,
    ).toBe("room");
  });
});
