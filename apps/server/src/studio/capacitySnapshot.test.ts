import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ProviderInstanceConfig } from "@specweave-studio/contracts";
import { capacitySnapshot, nativeCapacityBinding, nativeQuotaDenied, CAPACITY_MAX_AGE_MS } from "./capacitySnapshot.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";
import { provider, rawAccount, rawSnapshot, settings } from "./fixtures.ts";

const now = Date.parse("2026-10-07T19:00:00Z");
const build = (raw: unknown, providers = [provider("codex", "codex", now)], config = settings) => capacitySnapshot({ raw, providers, settings: config, baseEnv: {}, now });
describe("capacity snapshot", () => {
  it("returns only safe bounded fields and never forwards source labels, identities, errors or receipts", () => {
    const raw = rawSnapshot(now);
    Object.assign(raw.accounts[0]!, { label: "private@example.invalid", api_key: "synthetic-only-key", stdout: "synthetic-private-output" });
    const snapshot = build({ ...raw, runs: [{ prompt: "private request" }], token: "synthetic-token" });
    expect(snapshot.available).toBe(true);
    expect(snapshot.accounts[0]?.label).toBe("Codex 1");
    expect(snapshot.accounts[0]?.providerInstanceId).toBe("codex");
    expect(snapshot.verifiedQuotaPoolCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/private@|synthetic|private request|stdout|api_key/);
  });
  it.each([{ status: "error" as const }, { availability: "unavailable" as const }, { usageLimits: { ...provider("codex", "codex", now).usageLimits!, nativeRouteVerified: false } }, { usageLimits: { ...provider("codex", "codex", now).usageLimits!, nativeRouteObservedAt: new Date(now - CAPACITY_MAX_AGE_MS - 1).toISOString() } }])("never binds failed or route-unverified native snapshots", (changes) => {
    const snapshot = build(rawSnapshot(now), [{ ...provider("codex", "codex", now), ...changes }]);
    expect(snapshot.accounts[0]?.providerInstanceId).toBeNull();
    expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
  });
  it("keeps missing or malformed state unavailable with no invented policy", () => {
    for (const raw of [null, {}, { ...rawSnapshot(now), accounts: [rawAccount("codex-1", now), rawAccount("codex-1", now)] }, { ...rawSnapshot(now), accounts: [{ ...rawAccount("codex-1", now), provider: "claude" }] }]) {
      const snapshot = build(raw);
      expect(snapshot.available).toBe(false);
      expect(snapshot.policy).toBeNull();
      expect(snapshot.accounts).toEqual([]);
    }
  });
  it.each([
    ["missing expiry", { expiresAt: null }], ["malformed expiry", { expiresAt: "invalid" }],
    ["expiry before observation", { expiresAt: new Date(now - 1).toISOString() }],
    ["unbounded expiry", { expiresAt: new Date(now + 3600001).toISOString() }],
    ["infinite reset", { window: { usedPercent: 1, resetsAt: Infinity } }],
    ["negative reset", { window: { usedPercent: 1, resetsAt: -1 } }],
    ["null reset", { window: { usedPercent: 1, resetsAt: null } }],
    ["future observation", { observedAt: new Date(now + 6000).toISOString() }],
    ["old observation", { observedAt: new Date(now - CAPACITY_MAX_AGE_MS - 1).toISOString() }],
    ["expired reset", { weekly: { usedPercent: 10, resetsAt: Math.floor(now / 1000) - 1 } }],
  ])("does not recommend %s", (_name, changes) => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, changes);
    const snapshot = build(raw);
    expect(snapshot.accounts[0]?.status).not.toBe("ready");
    expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
  });
  it.each(["stale", "unknown", "exhausted", "active"])("preserves authoritative source %s", (status) => {
    const raw = rawSnapshot(now); raw.accounts[0]!.status = status;
    expect(build(raw).accounts[0]?.status).toBe(status);
    expect(build(raw).recommendations.every((r) => r.id === null)).toBe(true);
  });
  it("preserves native denial and legacy OAuth despite claimed auth and manual quota", () => {
    for (const changes of [{ authKind: "oauth_token" }, { authError: "profile-isolation-unverified" }, { authKind: "api-key" }]) {
      const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!, changes); raw.accounts[0]!.quota.source = "manual";
      expect(build(raw).accounts[0]?.status).toBe("blocked");
    }
    for (const changes of [{ ordinaryUsageAllowed: false }, { rateLimitReachedType: "workspace_owner_credits_depleted" }]) {
      const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, changes);
      expect(build(raw).accounts[0]?.status).toBe("exhausted");
    }
  });
  it.each(["Claude Max", "Claude Max 20x Subscription", "Claude Pro", "max5x", "Team", "Enterprise"])("binds supported consumer plan %s only with a ready authenticated native snapshot", (type) => {
    const p = { ...provider("claudeAgent", "claudeAgent", now), auth: { status: "authenticated" as const, type } };
    const snapshot = build({ ...rawSnapshot(now), accounts: [rawAccount("claude-1", now)] }, [p]);
    expect(snapshot.accounts[0]?.providerInstanceId).toBe("claudeAgent");
  });
  it("does not fall back from an exhausted, unbound or wrong-provider pin", () => {
    for (const selectedAccount of ["claude-1", "codex-2"] as const) {
      const raw = { ...rawSnapshot(now), accounts: [rawAccount("codex-1", now), { ...rawAccount(selectedAccount, now), status: "exhausted" }], policy: { mode: "balanced", preferredProvider: null, selectedAccount } };
      const snapshot = build(raw);
      expect(snapshot.policy?.selectedAccount).toBe(selectedAccount);
      expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
    }
    expect(build({ ...rawSnapshot(now), policy: { mode: "balanced", preferredProvider: "claude", selectedAccount: null } }).recommendations.every((r) => r.id === null)).toBe(true);
  });
  it("expires account identity independently of fresh quota notifications", () => {
    const p = provider("codex", "codex", now);
    const oldIdentity = { ...p, usageLimits: { ...p.usageLimits!, checkedAt: new Date(now).toISOString(), quotaPoolObservedAt: new Date(now - CAPACITY_MAX_AGE_MS - 1).toISOString() } };
    const snapshot = build(rawSnapshot(now), [oldIdentity]);
    expect(snapshot.accounts[0]?.quotaPoolId).toBeNull();
    expect(snapshot.verifiedQuotaPoolCount).toBeNull();
    expect(snapshot.accounts[0]?.status).toBe("ready");
  });
  it("binds an actual configured isolated instance only by canonical home and supported fresh auth", () => {
    const p = provider("personal", "codex", now);
    const config = { ...settings, providerInstances: { [p.instanceId]: { driver: p.driver, config: { homePath: "~/.local/share/specweave/account-profiles/codex-2" } } } };
    const result = build({ ...rawSnapshot(now), accounts: [rawAccount("codex-2", now)] }, [p], config);
    expect(result.accounts[0]?.providerInstanceId).toBe("personal");
    expect(build({ ...rawSnapshot(now), accounts: [rawAccount("codex-2", now)] }, [{ ...p, auth: { status: "unknown" } }], config).accounts[0]?.providerInstanceId).toBeNull();
  });
});
describe("native slot bindings", () => {
  const entry = (driver: string, config: object, environment?: ProviderInstanceConfig["environment"]): ProviderInstanceConfig => ({ driver: ProviderDriverKind.make(driver), config, ...(environment ? { environment } : {}) });
  it("accepts only exact canonical slot paths and keeps explicit Claude default scope distinct", () => {
    expect(nativeCapacityBinding(entry("codex", { homePath: "~/.local/share/specweave/account-profiles/codex-4" }), {})).toBe("codex-4");
    expect(nativeCapacityBinding(entry("claudeAgent", { homePath: "~/.local/share/specweave/account-profiles/claude-2" }), {})).toBe("claude-2");
    expect(nativeCapacityBinding(entry("claudeAgent", {}), {})).toBe("claude-1");
    for (const path of ["~/.claude", "~/.local/share/specweave/account-profiles/claude-2-copy", "/tmp/claude-2"]) expect(nativeCapacityBinding(entry("claudeAgent", { homePath: path }), {})).toBeNull();
    expect(nativeCapacityBinding(entry("codex", { shadowHomePath: "/tmp/shadow" }), {})).toBeNull();
    expect(nativeCapacityBinding(entry("codex", {}, [{ name: "OPENAI_API_KEY", value: "synthetic-explicit", sensitive: true }]), {})).toBeNull();
  });
});

describe("reset-first account priority", () => {
  it("ranks every main window before kind summaries and ignores unrelated model resets", () => {
    const first = provider("codex", "codex", now), second = provider("second", "codex", now);
    Object.assign(first.usageLimits!, { nativeAllowanceObservedAt: new Date(now).toISOString(), windows: [
      { id: "primary", kind: "session", label: "Primary", usedPercent: 90, resetsAt: new Date(now+86400000).toISOString(), windowDurationMins: 1440 },
      { id: "secondary", kind: "session", label: "Secondary", usedPercent: 10, resetsAt: new Date(now+3600000).toISOString(), windowDurationMins: 300 },
    ] });
    Object.assign(second.usageLimits!, { nativeAllowanceObservedAt: new Date(now).toISOString(), windows: [
      { id: "primary", kind: "session", label: "Primary", usedPercent: 20, resetsAt: new Date(now+10800000).toISOString(), windowDurationMins: 300 },
      { id: "other:primary", kind: "session", label: "Model", usedPercent: 20, resetsAt: new Date(now+600000).toISOString(), windowDurationMins: 15 },
    ] });
    const config = { ...settings, providerInstances: { second: { driver: second.driver, config: { homePath: "~/.local/share/specweave/account-profiles/codex-2" } } } };
    const raw = { ...rawSnapshot(now-1), accounts: [rawAccount("codex-1", now-1), rawAccount("codex-2", now-1)], policy: { mode: "reset-first", preferredProvider: null, selectedAccount: null } };
    const result = build(raw, [first,second], config);
    expect(result.accounts[0]?.quota.window?.usedPercent).toBe(90);
    expect(result.accounts[0]?.quota.windows?.filter((w) => w.appliesToSelection)).toHaveLength(2);
    expect(result.recommendations[0]?.id).toBe("codex-1");
    expect(result.recommendations[0]?.reason).toContain(new Date(now+3600000).toISOString());
  });
  it("prefers the earliest eligible reset and more used ties while retaining the explicit pin", () => {
    const first = provider("codex", "codex", now), second = provider("second", "codex", now);
    Object.assign(second.usageLimits!, { quotaPoolId: `codex:sha256:${"b".repeat(64)}` });
    const config = { ...settings, providerInstances: { second: { driver: second.driver, config: { homePath: "~/.local/share/specweave/account-profiles/codex-2" } } } };
    const raw = { ...rawSnapshot(now), accounts: [rawAccount("codex-1", now), rawAccount("codex-2", now)], policy: { mode: "reset-first", preferredProvider: null, selectedAccount: null as string | null } };
    Object.assign(raw.accounts[0]!.quota, { window: { usedPercent: 10, resetsAt: now/1000+1000 }, weekly: { usedPercent: 10, resetsAt: now/1000+9000 } });
    Object.assign(raw.accounts[1]!.quota, { window: { usedPercent: 90, resetsAt: now/1000+1000 }, weekly: { usedPercent: 90, resetsAt: now/1000+9000 } });
    const result = build(raw, [first,second], config);
    expect(result.recommendations[0]?.id).toBe("codex-2"); expect(result.verifiedQuotaPoolCount).toBe(2);
    expect(result.recommendations[0]?.reason).toContain(new Date(now+1000000).toISOString());
    expect(result.recommendations[0]?.reason).toContain("existing sessions keep their account and provider");
    raw.policy.selectedAccount = "codex-1";
    expect(build(raw, [first,second], config).recommendations[0]?.id).toBe("codex-1");
    expect(build(raw, [first,second], config).recommendations[0]?.reason).toContain("Explicit account preference retained");
    raw.policy.selectedAccount = null;
    for (const status of ["active", "stale", "exhausted"]) {
      raw.accounts[1]!.status = status;
      expect(build(raw, [first,second], config).recommendations[0]?.id).toBe("codex-1");
    }
  });
});


describe("authoritative native allowance and separate credit observations", () => {
  it("fences newer main denial notifications independently of an older full-read allowance", () => {
    const p = provider("codex", "codex", now), old = new Date(now-300000).toISOString();
    Object.assign(p.usageLimits!, { nativeAllowanceObservedAt: old, ordinaryUsageAllowed: true, spendControlReached: false, credits: { hasCredits: true, unlimited: true } });
    const raw = rawSnapshot(now-60000); Object.assign(raw.accounts[0]!.quota, { ordinaryUsageAllowed: true });
    const deniedProvider = { ...p, usageLimits: applyUsageLimitsUpdate({ previous: p.usageLimits, checkedAt: new Date(now).toISOString(), update: { windows: [], spendControlReached: true } })! };
    const result = build(raw, [deniedProvider]);
    expect(result.accounts[0]?.status).toBe("exhausted"); expect(result.accounts[0]?.quota.spendControlReached).toBe(true);
    expect(result.accounts[0]?.quota.ordinaryUsageAllowed).toBe(true); expect(result.accounts[0]?.quota.observedAt).toBe(raw.accounts[0]!.quota.observedAt);
    expect(result.recommendations[0]?.id).toBeNull(); expect(nativeQuotaDenied(deniedProvider.usageLimits, now)).toBe(true);
    const recovered = { ...p, usageLimits: { ...provider("codex", "codex", now).usageLimits!, nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: true, spendControlReached: false } };
    expect(build(raw, [recovered]).accounts[0]?.status).toBe("ready"); expect(nativeQuotaDenied(recovered.usageLimits, now)).toBe(false);
  });
  it("shares fresh native negative semantics without denying unknown, stale or classification-only allowed quota", () => {
    const limits = provider("codex", "codex", now).usageLimits!;
    expect(nativeQuotaDenied(undefined, now)).toBe(false); expect(nativeQuotaDenied(limits, now)).toBe(false);
    const full = { ...limits, nativeAllowanceObservedAt: new Date(now).toISOString() };
    expect(nativeQuotaDenied({ ...full, ordinaryUsageAllowed: false }, now)).toBe(true);
    expect(nativeQuotaDenied({ ...full, ordinaryUsageAllowed: true, spendControlReached: true }, now)).toBe(true);
    expect(nativeQuotaDenied({ ...full, ordinaryUsageAllowed: true, rateLimitReachedType: "workspace_member_usage_limit_reached" }, now)).toBe(false);
    expect(nativeQuotaDenied({ ...full, rateLimitReachedType: "workspace_member_usage_limit_reached" }, now)).toBe(true);
    const stale = { ...full, nativeAllowanceObservedAt: new Date(now-CAPACITY_MAX_AGE_MS-1).toISOString(), ordinaryUsageAllowed: false };
    expect(nativeQuotaDenied(stale, now)).toBe(false);
    expect(nativeQuotaDenied({ ...stale, nativeDenialObservedAt: new Date(now).toISOString() }, now)).toBe(true);
    expect(nativeQuotaDenied({ ...stale, nativeDenialObservedAt: new Date(now+6000).toISOString() }, now)).toBe(false);
  });
  it("allows a full included window only with fresh native permission and preserves duration and credits", () => {
    const raw = rawSnapshot(now);
    Object.assign(raw.accounts[0]!, { status: "exhausted" });
    Object.assign(raw.accounts[0]!.quota, { ordinaryUsageAllowed: true, window: { usedPercent: 100, resetsAt: now/1000+900, windowDurationMins: 15 },
      credits: { hasCredits: true, unlimited: false, balance: "42.5" }, resetCredits: { availableCount: 2 },
      windows: [{ id: "codex:primary", bucketId: "codex", appliesToSelection: true, usedPercent: 100, resetsAt: now/1000+900, windowDurationMins: 15 }, { id: "other:primary", bucketId: "other", appliesToSelection: false, usedPercent: 100, resetsAt: now/1000+3600, windowDurationMins: 60 }] });
    const a = build(raw).accounts[0]!;
    expect(a.status).toBe("ready"); expect(a.quota.window?.windowDurationMins).toBe(15);
    expect(a.quota.credits?.balance).toBe("42.5"); expect(a.quota.resetCredits?.availableCount).toBe(2);
    expect(a.quota.windows).toHaveLength(2); expect(build(raw).recommendations[0]?.id).toBe("codex-1");
  });
  it.each([{ ordinaryUsageAllowed: false }, { spendControlReached: true }, { denied: true }, { ordinaryUsageAllowed: null, rateLimitReachedType: "workspace_owner_credits_depleted" }])("preserves denial despite credit availability: %j", (refusal) => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { ordinaryUsageAllowed: true, credits: { hasCredits: true, unlimited: true }, resetCredits: { availableCount: 10 }, ...refusal });
    expect(build(raw).accounts[0]?.status).toBe("exhausted"); expect(build(raw).recommendations[0]?.id).toBeNull();
  });
  it("does not lift percentage exhaustion from manual permission or an earned-reset count", () => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { source: "manual", ordinaryUsageAllowed: true, window: { usedPercent: 100, resetsAt: now/1000+3600 }, credits: { hasCredits: true, unlimited: true } });
    const a = build(raw).accounts[0]!; expect(a.status).toBe("exhausted"); expect(a.quota.ordinaryUsageAllowed).toBeNull(); expect(a.quota.credits).toBeNull();
    Object.assign(raw.accounts[0]!.quota, { source: "native-app-server", ordinaryUsageAllowed: null, resetCredits: { availableCount: 3 } });
    expect(build(raw).accounts[0]?.status).toBe("exhausted");
  });
  it("uses a newer complete bound native read over stale companion data without inventing a window", () => {
    const raw = rawSnapshot(now - 16*60000); raw.accounts[0]!.status = "stale";
    const p = provider("codex", "codex", now); Object.assign(p.usageLimits!, { nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: true, credits: { hasCredits: false, unlimited: false } });
    const a = build(raw, [p]).accounts[0]!; expect(a.status).toBe("ready"); expect(a.quota.window).toBeNull(); expect(a.quota.weekly).toBeNull();
    expect(a.quota.source).toBe("native-app-server"); expect(a.quota.observedAt).toBe(new Date(now).toISOString());
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: new Date(now+1).toISOString() });
    expect(build(raw, [p]).accounts[0]?.status).toBe("exhausted");
  });
  it("keeps stale native permission and malformed credit details from authorizing a full window", () => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { window: { usedPercent: 100, resetsAt: now/1000+3600 }, credits: { hasCredits: true, unlimited: false, balance: "private@example.invalid" } });
    const p = provider("codex", "codex", now); Object.assign(p.usageLimits!, { nativeAllowanceObservedAt: new Date(now-16*60000).toISOString(), ordinaryUsageAllowed: true });
    const a = build(raw, [p]).accounts[0]!; expect(a.status).toBe("exhausted"); expect(a.quota.credits).toBeNull();
    expect(JSON.stringify(a)).not.toContain("private@");
  });
  it("keeps credits-only main capacity unknown even when a companion claims ready", () => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { window: null, weekly: null, credits: { hasCredits: true, unlimited: true } });
    const a = build(raw).accounts[0]!;
    expect(a.status).toBe("unknown"); expect(a.quota.credits?.unlimited).toBe(true); expect(build(raw).recommendations[0]?.id).toBeNull();
  });
  it("lets a fresh complete native read recover malformed companion observation time", () => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { observedAt: "invalid" });
    const p = provider("codex", "codex", now); Object.assign(p.usageLimits!, { nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: true });
    const a = build(raw, [p]).accounts[0]!;
    expect(a.status).toBe("ready"); expect(a.quota.observedAt).toBe(new Date(now).toISOString());
  });
  it("preserves OpenAI's explicit ordinary permission beside a reported limit classification", () => {
    const raw = rawSnapshot(now); Object.assign(raw.accounts[0]!.quota, { ordinaryUsageAllowed: true, spendControlReached: false, rateLimitReachedType: "workspace_member_usage_limit_reached", window: { usedPercent: 100, resetsAt: now/1000+3600 } });
    const a = build(raw).accounts[0]!;
    expect(a.status).toBe("ready"); expect(a.quota.rateLimitReachedType).toBe("workspace_member_usage_limit_reached");
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: new Date(now+1).toISOString() });
    expect(build(raw).accounts[0]?.status).toBe("exhausted");
  });
  it("does not drop an exhausted secondary when its duration is unavailable", () => {
    const raw = rawSnapshot(now-1);
    const p = provider("codex", "codex", now); Object.assign(p.usageLimits!, { nativeAllowanceObservedAt: new Date(now).toISOString(), windows: [
      { id: "primary", kind: "other", label: "Primary", usedPercent: 10, resetsAt: new Date(now+3600000).toISOString() },
      { id: "secondary", kind: "other", label: "Secondary", usedPercent: 100, resetsAt: new Date(now+86400000).toISOString() },
    ] });
    const a = build(raw, [p]).accounts[0]!;
    expect(a.status).toBe("exhausted"); expect(a.quota.weekly?.usedPercent).toBe(100); expect(a.quota.weekly?.windowDurationMins).toBeUndefined();
    Object.assign(p.usageLimits!, { windows: p.usageLimits!.windows.map(({ resetsAt: _reset, ...w }) => w) });
    expect(build(raw, [p]).accounts[0]?.status).toBe("unknown");
    Object.assign(p.usageLimits!, { ordinaryUsageAllowed: true });
    expect(build(raw, [p]).accounts[0]?.status).toBe("ready");
  });
});
