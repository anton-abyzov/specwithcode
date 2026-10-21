import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountFingerprint,
  accountPoolKey,
  providerUsageSummary,
  simulatedProviderUsage,
  withSimulatedUsage,
} from "./providerUsageSummary.ts";

const now = Date.parse("2026-10-20T13:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function provider(over: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", email: " Anton@Example.com " },
    checkedAt: iso(now),
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(now - 60_000),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 42,
          resetsAt: iso(now + 2 * 3600_000),
        },
      ],
    },
    ...over,
  };
}

describe("accountPoolKey", () => {
  it("keys on the signed-in email, case and space folded", () => {
    expect(accountPoolKey(provider())).toBe("claudeAgent:anton@example.com");
  });

  it("falls back to the provider's own hashed account id, then to unknown", () => {
    const pooled = provider({
      auth: { status: "authenticated" },
      usageLimits: { checkedAt: iso(now), windows: [], quotaPoolId: "codex:sha256:abc" },
    } as Partial<ServerProvider>);
    expect(accountPoolKey(pooled)).toBe("claudeAgent:pool:codex:sha256:abc");
    expect(accountPoolKey(provider({ auth: { status: "authenticated" } }))).toBeNull();
  });

  it("never reads a credential fingerprint or a per-machine profile id", () => {
    const keyed = provider({
      auth: { status: "authenticated", profileId: "machine-local-client" },
      credentialFingerprint: "secret-derived",
    } as unknown as Partial<ServerProvider>);
    expect(accountPoolKey(keyed)).toBeNull();
  });
});

describe("providerUsageSummary", () => {
  it("shares a salted hash, the fullest live window and when it resets", () => {
    const summary = providerUsageSummary(provider(), now, {});
    expect(summary).toEqual({
      accountFingerprint: accountFingerprint("claudeAgent:anton@example.com"),
      usedPercent: 42,
      resetsAt: iso(now + 2 * 3600_000),
      signedIn: true,
      observedAt: iso(now - 60_000),
    });
    expect(summary.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("anton");
  });

  it("gives the same fingerprint on every machine signed in to one account", () => {
    const m4 = providerUsageSummary(provider(), now, {});
    const minis = providerUsageSummary(
      provider({ auth: { status: "authenticated", email: "anton@example.com" } }),
      now,
      {},
    );
    const other = providerUsageSummary(
      provider({ auth: { status: "authenticated", email: "anna@example.com" } }),
      now,
      {},
    );
    expect(minis.accountFingerprint).toBe(m4.accountFingerprint);
    expect(other.accountFingerprint).not.toBe(m4.accountFingerprint);
  });

  it("reports unknown usage when the provider has no reading", () => {
    const { usageLimits: _omit, ...rest } = provider();
    expect(providerUsageSummary(rest as ServerProvider, now, {})).toMatchObject({
      usedPercent: null,
      resetsAt: null,
      observedAt: null,
    });
    const unavailable = provider({
      usageLimits: { checkedAt: iso(now), windows: [], unavailable: true },
    } as unknown as Partial<ServerProvider>);
    expect(providerUsageSummary(unavailable, now, {}).usedPercent).toBeNull();
  });

  it("marks a signed-out provider and a native denial", () => {
    expect(
      providerUsageSummary(provider({ auth: { status: "unauthenticated" } }), now, {}).signedIn,
    ).toBe(false);
    const denied = provider({
      usageLimits: { checkedAt: iso(now), windows: [], ordinaryUsageAllowed: false },
    } as Partial<ServerProvider>);
    expect(providerUsageSummary(denied, now, {}).limited).toBe(true);
  });

  it("reports simulated usage for two-server tests", () => {
    const env = { STUDIO_SIMULATE_PROVIDER_USAGE: "claudeAgent=97@pool-a, codex=?" };
    expect(simulatedProviderUsage(env).get("codex")).toEqual({ usedPercent: null, account: null });
    const summary = providerUsageSummary(provider(), now, env);
    expect(summary).toMatchObject({ usedPercent: 97, signedIn: true });
    expect(summary.accountFingerprint).toBe(accountFingerprint("claudeAgent:sim:pool-a"));
    expect(
      providerUsageSummary(provider(), now, { STUDIO_SIMULATE_PROVIDER_USAGE: "claudeAgent=100" })
        .limited,
    ).toBe(true);
  });

  it("gives the sweep the simulated usage as one stable session window", () => {
    const env = { STUDIO_SIMULATE_PROVIDER_USAGE: "claudeAgent=96@pool-a,codex=?" };
    const codex = provider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
    });
    const [claude, unknown] = withSimulatedUsage([provider(), codex], now, env);
    expect(claude!.usageLimits?.windows).toEqual([
      expect.objectContaining({ kind: "session", usedPercent: 96 }),
    ]);
    const resetsAt = Date.parse(claude!.usageLimits!.windows[0]!.resetsAt!);
    expect(resetsAt - now).toBeGreaterThanOrEqual(5 * 3600_000);
    // The same window all through the block, so a thread moves once per window.
    const later = withSimulatedUsage([provider()], now + 60_000, env)[0]!;
    expect(later.usageLimits!.windows[0]!.resetsAt).toBe(claude!.usageLimits!.windows[0]!.resetsAt);
    expect(unknown).toBe(codex);
    const real = [provider()];
    expect(withSimulatedUsage(real, now, {})).toBe(real);
  });
});
