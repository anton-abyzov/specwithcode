import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind } from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as NativeRoute from "./NativeRoute.ts";
import * as Capacity from "./Capacity.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import { provider, rawAccount, rawSnapshot, settings } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Capacity.Capacity>, raw: unknown, native = [provider()], config = settings, unavailable = false, routeVerified = true, refreshed = native, refreshIds: string[] = [], switchOptions: { refreshedRaw?: unknown; refreshBusy?: boolean; requests?: string[]; malformedJson?: boolean } = {}) =>
  Effect.runPromise(effect.pipe(Effect.provide(Capacity.layer), Effect.provide(Layer.mergeAll(
    Layer.succeed(NativeRoute.NativeRoute, { verify: () => Effect.succeed(routeVerified) }),
    Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(config) }),
    Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed(native), refreshInstance: (id) => Effect.sync(() => { refreshIds.push(id); return refreshed; }) }),
  )), Effect.provideService(HostProcessEnvironment, {}), Effect.provideService(SwitchFetch,
    (async (url) => {
      if (unavailable) throw new Error("synthetic-secret-error");
      if (switchOptions.malformedJson) return new Response("{", { headers: { "Content-Type": "application/json" } });
      const path = new URL(String(url)).pathname; switchOptions.requests?.push(path);
      if (path === "/api/refresh" && switchOptions.refreshBusy) return Response.json({}, { status: 409 });
      return Response.json(path === "/api/refresh" && "refreshedRaw" in switchOptions ? switchOptions.refreshedRaw : raw);
    }) as typeof fetch)));
const start = (id = "codex") => Effect.flatMap(Capacity.Capacity, (capacity) => capacity.assertNativeStart(ProviderInstanceId.make(id), "/workspace"));
describe("native session admission", () => {

  const creditStart = (now: number) => Clock.clockWith((clock) => Effect.flatMap(Capacity.Capacity, (capacity) => capacity.assertNativeStart(ProviderInstanceId.make("codex"), "/workspace", { allowCredits: true, expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}` })).pipe(Effect.provideService(Clock.Clock, { ...clock, currentTimeMillis: Effect.succeed(now), currentTimeMillisUnsafe: () => now })));
  const fundedProvider = (now: number) => {
    const base = provider("codex", "codex", now);
    return { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: false, spendControlReached: false, rateLimitReachedType: "rate_limit_reached", credits: { hasCredits: true, unlimited: false, balance: "68.7550445000" }, windows: [{ id: "primary", kind: "weekly" as const, label: "Weekly", usedPercent: 100, resetsAt: new Date(now + 3600000).toISOString(), windowDurationMins: 10080 }] } };
  };
  it("admits an explicitly credit-enabled start after refreshing the exact selected provider", async () => {
    const now = Date.now(), native = fundedProvider(now), refreshIds: string[] = [];
    const raw = rawSnapshot(now - 1000); raw.accounts[0]!.status = "exhausted";
    await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native], settings, false, true, [native], refreshIds)).resolves.toBeUndefined();
    expect(refreshIds).toEqual(["codex"]);
    await expect(run(start(), raw, [native])).rejects.toThrow(/no remaining permitted usage/);
  });
  it("admits fresh native existing credits with no optional companion", async () => {
    const native = fundedProvider(Date.now());
    await expect(run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true)).resolves.toBeUndefined();
  });
  it.each(["blocked", "active", "auth-required"])("keeps companion %s authoritative for funded starts", async (status) => {
    const now = Date.now(), native = fundedProvider(now), raw = rawSnapshot(now - 1000);
    raw.accounts[0]!.status = status;
    await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native])).rejects.toThrow(/blocked, busy/);
  });
  it("does not permit paid fallback when refresh loses credit permission", async () => {
    const native = fundedProvider(Date.now());
    const depleted = { ...native, usageLimits: { ...native.usageLimits, credits: { hasCredits: false, unlimited: false, balance: "0" } } };
    await expect(run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true, true, [depleted])).rejects.toThrow(/Existing credits/);
  });
  it("rejects a refreshed native account different from the explicit credit request", async () => {
    const native = fundedProvider(Date.now());
    const other = { ...native, usageLimits: { ...native.usageLimits, quotaPoolId: `codex:sha256:${"b".repeat(64)}` } };
    await expect(run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true, true, [other])).rejects.toThrow(/native account changed/);
  });
  it("rejects cached permission returned by a failed explicit refresh even within the 60-second age limit", async () => {
    const now = Date.now(), native = fundedProvider(now - 1000);
    await expect(run(creditStart(now), null, [native], settings, true)).rejects.toThrow(/Existing credits/);
  });
  it("does not use a stale full credit read even if authentication and a negative notification are fresh", async () => {
    const native = fundedProvider(Date.now());
    native.usageLimits.nativeAllowanceObservedAt = new Date(Date.now() - 60_001).toISOString();
    await expect(run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true)).rejects.toThrow(/Existing credits/);
  });
  it("does not clear real native spend or workspace denials when credit mode is requested", async () => {
    for (const change of [{ spendControlReached: true }, { rateLimitReachedType: "workspace_owner_usage_limit_reached" }]) {
      const native = fundedProvider(Date.now()); Object.assign(native.usageLimits, change);
      await expect(run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true)).rejects.toThrow(/Existing credits/);
    }
  });
  it.each(["newer", "equal", "invalid"])("keeps a %s companion quota failure authoritative over banked credits", async (kind) => {
    const now = Date.now(), native = fundedProvider(now - 1000), raw = rawSnapshot(now - 2000);
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: kind === "invalid" ? "invalid" : new Date(kind === "equal" ? now - 1000 : now).toISOString() });
    await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native])).rejects.toThrow(/no remaining permitted usage/);
  });
  it("accepts a new full credit observation after a historical companion failure", async () => {
    const now = Date.now(), native = fundedProvider(now), raw = rawSnapshot(now - 2000);
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: new Date(now - 1000).toISOString() });
    await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native])).resolves.toBeUndefined();
  });
  it("refuses malformed companion failure evidence instead of treating it as an absent service", async () => {
    const now = Date.now(), native = fundedProvider(now), raw = rawSnapshot(now - 2000);
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: 42 });
    await expect(run(creditStart(now), raw, [native])).rejects.toThrow(/capacity response is invalid/);
  });
  it("refuses malformed JSON from a responding companion", async () => {
    const now = Date.now(), native = fundedProvider(now);
    await expect(run(creditStart(now), null, [native], settings, false, true, [native], [], { malformedJson: true })).rejects.toThrow(/capacity response is invalid/);
  });
  it("rejects a credit-bound instance reconfigured as an API route", async () => {
    const now = Date.now(), native = fundedProvider(now);
    const config = { ...settings, providerInstances: { codex: { driver: ProviderDriverKind.make("codex"), environment: [{ name: "OPENAI_API_KEY", value: "synthetic-api-key", sensitive: true }], config: {} } } };
    await expect(run(creditStart(now), null, [native], config, true)).rejects.toThrow(/API or managed provider route/);
  });

  it("keeps verified native default usable when optional Switch is absent", async () => {
    await expect(run(start(), null, [provider()], settings, true)).resolves.toBeUndefined();
    const snapshot = await run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current), null, [provider()], settings, true);
    expect(snapshot.available).toBe(false); expect(snapshot.policy).toBeNull(); expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret-error");
  });
  it.each(["ordinary-denied", "spend-denied"])("fences fresh native %s before unavailable Switch or unbound-home fallback", async (kind) => {
    const now = Date.now(), base = provider("codex", "codex", now);
    const native: ReturnType<typeof provider> = { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: kind === "ordinary-denied" ? false : true, spendControlReached: kind === "spend-denied", windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 20, resetsAt: new Date(now + 3600000).toISOString(), windowDurationMins: 300 }] } };
    const custom = { ...settings, providers: { ...settings.providers, codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" } } };
    for (const [config, unavailable] of [[settings, true], [custom, false]] as const) {
      await expect(run(start(), rawSnapshot(), [native], config, unavailable)).rejects.toThrow(/limit|spend/i);
      await expect(run(start(), rawSnapshot(), [native], config, unavailable)).rejects.toThrow(/Next observed reset/);
    }
  });
  it("preserves the deliberate unbound native-home fallback when quota is unknown", async () => {
    const requests: string[] = [];
    const custom = { ...settings, providers: { ...settings.providers, codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" } } };
    await expect(run(start(), null, [provider()], custom, false, true, [provider()], [], { requests })).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
  it("does not turn an old native denial into fresh quota proof for optional fallbacks", async () => {
    const base = provider(), staleAt = new Date(Date.now() - 16 * 60000).toISOString();
    const native: ReturnType<typeof provider> = { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: staleAt, ordinaryUsageAllowed: false, spendControlReached: true } };
    const custom = { ...settings, providers: { ...settings.providers, codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" } } };
    for (const config of [settings, custom]) await expect(run(start(), null, [native], config, true)).resolves.toBeUndefined();
  });
  it("fences a fresh live spend denial without renewing an expired full-read allowance", async () => {
    const base = provider(), oldAt = new Date(Date.now() - 16 * 60000).toISOString();
    const native: ReturnType<typeof provider> = { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: oldAt, ordinaryUsageAllowed: true, spendControlReached: true, nativeDenialObservedAt: new Date().toISOString() } };
    const custom = { ...settings, providers: { ...settings.providers, codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" } } };
    for (const config of [settings, custom]) await expect(run(start(), null, [native], config, true)).rejects.toThrow(/spend control/);
  });
  it("rejects effective custom routes even when native account and quota are fresh", async () => {
    await expect(run(start(), rawSnapshot(), [provider()], settings, false, false)).rejects.toThrow(/effective Codex route/);
  });
  it("rejects failed refreshed native status with status guidance rather than asking an authenticated user to sign in", async () => {
    const attempts: string[] = [];
    const native = [{ ...provider(), status: "error" as const }];
    await expect(run(start(), rawSnapshot(), native, settings, false, true, native, attempts)).rejects.toThrow(/native provider status check failed/);
    expect(attempts).toEqual(["codex"]);
  });
  it("rejects unavailable native status despite a fresh authenticated account", async () => {
    await expect(run(start(), rawSnapshot(), [{ ...provider(), availability: "unavailable" as const }])).rejects.toThrow(/authorization is unverified/);
  });
  it.each(["stale", "error"])("refreshes only the selected shared provider once when its cache is %s", async (kind) => {
    const current = { ...provider(), ...(kind === "stale" ? { checkedAt: new Date(Date.now() - 16 * 60000).toISOString() } : { status: "error" as const, auth: { status: "unknown" as const } }) };
    const attempts: string[] = [];
    await expect(run(start(), rawSnapshot(), [current], settings, false, true, [provider()], attempts)).resolves.toBeUndefined();
    expect(attempts).toEqual(["codex"]);
  });
  it("does not refresh a fresh authorized snapshot or bypass quota after a stale one is refreshed", async () => {
    const attempts: string[] = [];
    await run(start(), rawSnapshot(), [provider()], settings, false, true, [provider()], attempts);
    expect(attempts).toEqual([]);
    const raw = rawSnapshot(); raw.accounts[0]!.status = "exhausted";
    const stale = { ...provider(), checkedAt: new Date(Date.now() - 16 * 60000).toISOString() };
    await expect(run(start(), raw, [stale], settings, false, true, [provider()], attempts)).rejects.toThrow(/no remaining permitted usage.*Next observed reset/);
    expect(attempts).toEqual(["codex"]);
  });
  it("never authorizes a refresh that remains stale", async () => {
    const old = [{ ...provider(), checkedAt: new Date(Date.now() - 16 * 60000).toISOString() }];
    await expect(run(start(), rawSnapshot(), old, settings, false, true, old)).rejects.toThrow(/authorization is unverified/);
  });
  it("recovers an idle host by refreshing stale native status and stale local quota exactly once", async () => {
    const old = Date.now() - 16 * 60000;
    const attempts: string[] = [], requests: string[] = [];
    await expect(run(start(), rawSnapshot(old), [{ ...provider(), checkedAt: new Date(old).toISOString() }], settings, false, true, [provider()], attempts, { refreshedRaw: rawSnapshot(), requests })).resolves.toBeUndefined();
    expect(attempts).toEqual(["codex"]); expect(requests).toEqual(["/api/state", "/api/refresh"]);
  });
  it("fails closed when stale quota refresh is busy and does not retry or admit its cache", async () => {
    const requests: string[] = [];
    await expect(run(start(), rawSnapshot(Date.now() - 16 * 60000), [provider()], settings, false, true, [provider()], [], { refreshBusy: true, requests })).rejects.toThrow(/refresh is already running/);
    expect(requests).toEqual(["/api/state", "/api/refresh"]);
  });
  it("does not admit an exhausted refreshed quota or a malformed refresh response", async () => {
    const stale = rawSnapshot(Date.now() - 16 * 60000), exhausted = rawSnapshot(); exhausted.accounts[0]!.status = "exhausted";
    await expect(run(start(), stale, [provider()], settings, false, true, [provider()], [], { refreshedRaw: exhausted })).rejects.toThrow(/no remaining permitted usage.*Next observed reset/);
    await expect(run(start(), stale, [provider()], settings, false, true, [provider()], [], { refreshedRaw: {} })).rejects.toThrow(/Fresh subscription capacity could not be verified/);
  });
  it("keeps ordinary background capacity reads passive when the local quota cache expires", async () => {
    const requests: string[] = [];
    const snapshot = await run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current), rawSnapshot(Date.now() - 16 * 60000), [provider()], settings, false, true, [provider()], [], { requests });
    expect(snapshot.accounts[0]?.status).toBe("stale"); expect(requests).toEqual(["/api/state"]);
  });
  it("admits fresh explicit native ordinary permission despite a 100%-used window and explanatory reached type", async () => {
    const now = Date.now(), base = provider("codex", "codex", now), requests: string[] = [];
    const native: ReturnType<typeof provider> = { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: true, spendControlReached: false, rateLimitReachedType: "workspace_member_usage_limit_reached", credits: { hasCredits: false, unlimited: false, balance: "0" }, windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100, resetsAt: new Date(now + 3600000).toISOString(), windowDurationMins: 300 }] } };
    await expect(run(start(), rawSnapshot(now - 1000), [native], settings, false, true, [native], [], { requests })).resolves.toBeUndefined();
    expect(requests).toEqual(["/api/state"]);
  });
  it.each(["ordinary-denied", "spend-denied"])("does not let banked credits override fresh native %s", async (kind) => {
    const now = Date.now(), base = provider("codex", "codex", now);
    const native: ReturnType<typeof provider> = { ...base, usageLimits: { ...base.usageLimits!, nativeAllowanceObservedAt: new Date(now).toISOString(), ordinaryUsageAllowed: kind === "ordinary-denied" ? false : true, spendControlReached: kind === "spend-denied", credits: { hasCredits: true, unlimited: false, balance: "1000" }, windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100, resetsAt: new Date(now + 3600000).toISOString(), windowDurationMins: 300 }] } };
    await expect(run(start(), rawSnapshot(now - 1000), [native])).rejects.toThrow(/no remaining permitted usage/);
  });
  it("does not authorize an unknown, stale or legacy native snapshot on absence", async () => {
    for (const native of [{ ...provider(), auth: { status: "unknown" as const } }, { ...provider(), checkedAt: new Date(Date.now() - 16 * 60000).toISOString() }, { ...provider("claudeAgent", "claudeAgent"), auth: { status: "authenticated" as const, type: "subscription-auth-unverified" } }]) {
      await expect(run(start(native.instanceId), null, [native], settings, true)).rejects.toThrow(/authorization is unverified/);
    }
  });
  it.each(["exhausted", "active", "stale"])("rechecks current source %s before native launch", async (status) => {
    const raw = rawSnapshot(); raw.accounts[0]!.status = status;
    await expect(run(start(), raw)).rejects.toThrow(status === "exhausted" ? /no remaining permitted usage/ : /blocked, busy, exhausted or unverified/);
  });
  it("rejects legacy/manual source and malformed quota at the native operation boundary", async () => {
    const raw = rawSnapshot(); raw.accounts[0]!.authKind = "oauth_token"; raw.accounts[0]!.quota.source = "manual";
    await expect(run(start(), raw)).rejects.toThrow(/blocked/);
    const invalid = rawSnapshot(); invalid.accounts[0]!.quota.expiresAt = "invalid";
    await expect(run(start(), invalid)).rejects.toThrow(/blocked/);
  });
  it.each(["blocked", "error", "auth-required"])("does not admit authoritative source %s even when percentages are unknown", async (status) => {
    const raw = { ...rawSnapshot(), accounts: [{ ...rawAccount(), status, quota: null }] };
    await expect(run(start(), raw)).rejects.toThrow(/blocked/);
  });
  it("permits supported consumer auth with explicitly unknown quotas, without inventing ready capacity", async () => {
    const now = Date.now(); const raw = { ...rawSnapshot(now), accounts: [{ ...rawAccount("claude-1", now), status: "unknown", quota: null }] };
    const native = [provider("claudeAgent", "claudeAgent", now)];
    await expect(run(start("claudeAgent"), raw, native)).resolves.toBeUndefined();
    const snapshot = await run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current), raw, native);
    expect(snapshot.accounts[0]?.status).toBe("unknown"); expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
  });
  it("keeps deliberate API instances separate and rejects unverified custom Claude isolation", async () => {
    const apiId = ProviderInstanceId.make("explicit-api");
    const config = { ...settings, providerInstances: { [apiId]: { driver: ProviderDriverKind.make("claudeAgent"), environment: [{ name: "ANTHROPIC_API_KEY", value: "synthetic-explicit-api", sensitive: true }], config: {} } } };
    await expect(run(start(apiId), null, [], config, true)).resolves.toBeUndefined();
    const native = provider("isolated", "claudeAgent");
    const custom = { ...settings, providerInstances: { [native.instanceId]: { driver: native.driver, config: { homePath: "/tmp/custom-claude" } } } };
    await expect(run(start(native.instanceId), null, [native], custom, true)).rejects.toThrow(/isolation is unverified/);
  });
  it("rejects pinning an ineligible profile but Automatic clears the pin", async () => {
    const raw = rawSnapshot(); raw.accounts[0]!.status = "exhausted";
    await expect(run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: "codex-1" })), raw)).rejects.toThrow(/not eligible/);
    const automatic = await run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: null })), raw);
    expect(automatic.available).toBe(true);
  });
});
