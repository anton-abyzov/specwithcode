import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageWindow,
  type ServerProviderUsageLimits,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
} from "../provider/claudeUsageLimits.ts";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe as resolveProviderUsageLimitsAfterProbe,
} from "../provider/providerUsageLimits.ts";
import * as Capacity from "./Capacity.ts";
import * as NativeRoute from "./NativeRoute.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import { capacitySnapshot, CAPACITY_MAX_AGE_MS } from "./capacitySnapshot.ts";
import { provider, rawAccount, settings } from "./fixtures.ts";

const now = Date.parse("2026-10-09T08:00:00Z");
const emptyQuota = { window: null, weekly: null, observedAt: null, expiresAt: null, source: null };
const oldFailure = DateTime.formatIso(DateTime.makeUnsafe(now - 2 * 86400000));
const resolveUsageLimitsAfterProbe = (
  input: Parameters<typeof resolveProviderUsageLimitsAfterProbe>[0],
) =>
  resolveProviderUsageLimitsAfterProbe({
    ...input,
    driver: ProviderDriverKind.make("claudeAgent"),
  });
const claude = () => provider("claudeAgent", "claudeAgent", now);
const unsupported = (available = false) =>
  claudeUsageResponseToLimits({
    checkedAt: claude().checkedAt,
    response: { rate_limits_available: available, rate_limits: null },
  }).limits;
const record = () => ({
  ...rawAccount("claude-1", now),
  status: "exhausted",
  lastQuotaErrorAt: oldFailure,
  quota: { ...emptyQuota },
});
const raw = (account: unknown) => ({
  accounts: [account],
  policy: { mode: "balanced", preferredProvider: null, selectedAccount: null },
});
const snapshot = (account: unknown, native = claude(), clockNow = now) =>
  capacitySnapshot({
    raw: raw(account),
    providers: [native],
    settings,
    baseEnv: {},
    now: clockNow,
  });

const start = (
  account: unknown,
  native = claude(),
  companion: "available" | "unavailable" | "invalid" = "available",
  clockNow = now,
) =>
  Effect.runPromise(
    Clock.clockWith((clock) =>
      Effect.flatMap(Capacity.Capacity, (capacity) =>
        capacity.assertNativeStart(ProviderInstanceId.make("claudeAgent"), "/synthetic/workspace"),
      ).pipe(
        Effect.provideService(
          Clock.Clock,
          Object.assign(Object.create(clock), {
            currentTimeMillis: Effect.succeed(clockNow),
            currentTimeMillisUnsafe: () => clockNow,
          }),
        ),
      ),
    ).pipe(
      Effect.provide(Capacity.layer),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(NativeRoute.NativeRoute, { verify: () => Effect.succeed(true) }),
          Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Effect.succeed([native]),
            refreshInstance: () => Effect.succeed([native]),
          }),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {}),
      Effect.provideService(SwitchFetch, (async () => {
        if (companion === "unavailable") throw new Error("Synthetic companion offline");
        return Response.json(companion === "invalid" ? {} : raw(account));
      }) as typeof fetch),
    ),
  );

describe("Claude failure observation expiry", () => {
  it.each([false, true])(
    "permits an explicit retry of the old null-quota error after an unavailable lookup (applicable=%s)",
    async (available) => {
      const account = record();
      const native = {
        ...claude(),
        usageLimits: resolveUsageLimitsAfterProbe({
          published: undefined,
          probed: unsupported(available),
        }),
      };
      expect(native.usageLimits).toEqual({
        checkedAt: claude().checkedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
      expect(snapshot(account, native).accounts[0]).toMatchObject({
        status: "unknown",
        providerInstanceId: "claudeAgent",
        authenticated: true,
        quota: {
          ...emptyQuota,
          freshness: "unknown",
          ordinaryUsageAllowed: null,
          credits: null,
          resetCredits: null,
        },
      });
      expect(
        snapshot(account, native).recommendations.every(
          (recommendation) => recommendation.id === null,
        ),
      ).toBe(true);
      await expect(start(account, native)).resolves.toBeUndefined();
      expect(account).toEqual(record());
    },
  );

  it.each([
    {},
    { rate_limits: null },
    { rate_limits_available: false },
    { rate_limits_available: true },
    { rate_limits_available: "false", rate_limits: null },
    { rate_limits_available: 0, rate_limits: null },
    { rate_limits_available: false, rate_limits: {} },
    {
      rate_limits_available: false,
      rate_limits: { five_hour: { utilization: 100, resets_at: null } },
    },
    { rate_limits_available: true, rate_limits: [] },
    { rate_limits_available: true, rate_limits: "invalid" },
  ])(
    "keeps malformed unsupported-shaped SDK responses blocked through the full pipeline: %j",
    async (response) => {
      const probed = claudeUsageResponseToLimits({
        checkedAt: claude().checkedAt,
        response: response as Parameters<typeof claudeUsageResponseToLimits>[0]["response"],
      }).limits;
      expect(probed.unavailable).toEqual({ reason: "probeFailed", invalidResponse: true });
      const native = {
        ...claude(),
        usageLimits: resolveUsageLimitsAfterProbe({ published: undefined, probed }),
      };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/no remaining permitted usage/);
    },
  );

  it.each(["failed", "missing"])(
    "does not reuse a pure empty lookup after a %s probe",
    async (kind) => {
      const published = unsupported(true);
      const probed =
        kind === "missing"
          ? undefined
          : { ...unsupported(), unavailable: { reason: "probeFailed" as const } };
      const failed = resolveUsageLimitsAfterProbe({ published, probed });
      expect(failed?.unavailable?.reason).toBe("probeFailed");
      const native = { ...claude(), usageLimits: failed };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/no remaining permitted usage/);
      const recovered = {
        ...native,
        usageLimits: resolveUsageLimitsAfterProbe({ published: failed, probed: unsupported(true) }),
      };
      expect(snapshot(record(), recovered).accounts[0]?.status).toBe("unknown");
      expect(snapshot(record(), recovered).recommendations.every((r) => r.id === null)).toBe(true);
      await expect(start(record(), recovered)).resolves.toBeUndefined();
    },
  );

  it.each([
    { unavailable: { reason: "probeFailed" } },
    { unavailable: { reason: "unsupported", invalidResponse: true } },
    { windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 0 }] },
    { checkedAt: "invalid" },
    { checkedAt: "" },
    { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)) },
    { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 5001)) },
    { ordinaryUsageAllowed: false },
    { ordinaryUsageAllowed: true },
    { ordinaryUsageAllowed: null },
    { spendControlReached: true },
    { spendControlReached: false },
    { rateLimitReachedType: "usage_limit_reached" },
    { nativeDenialRequiresFullRead: true },
    { nativeDenialObservedAt: oldFailure },
    { nativeCreditDenialObservedAt: oldFailure },
    { nativeAllowanceObservedAt: claude().checkedAt },
    { credits: { hasCredits: true, unlimited: true } },
    { resetCredits: { availableCount: 2 } },
  ] as Array<Partial<ServerProviderUsageLimits>>)(
    "rejects unsupported lookups with non-pure or stale evidence: %j",
    async (change) => {
      const native = { ...claude(), usageLimits: { ...unsupported(), ...change } };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/no remaining permitted usage/);
    },
  );

  it.each([
    { lastQuotaErrorAt: claude().checkedAt },
    { lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS)) },
    { lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1000)) },
    { lastQuotaErrorAt: "invalid" },
    { lastQuotaErrorAt: undefined },
    { quota: { ...emptyQuota, observedAt: oldFailure } },
    { quota: { ...emptyQuota, source: "native-app-server" } },
    { quota: { ...emptyQuota, window: { usedPercent: 100, resetsAt: now / 1000 + 3600 } } },
  ])(
    "does not erase fresh or measured companion errors with unsupported usage: %j",
    async (change) => {
      const account = Object.fromEntries(
        Object.entries({ ...record(), ...change }).filter(([, value]) => value !== undefined),
      );
      const native = { ...claude(), usageLimits: unsupported() };
      expect(snapshot(account, native).accounts[0]?.status).toBe("exhausted");
      await expect(start(account, native)).rejects.toThrow(/no remaining permitted usage/);
    },
  );

  it.each(["active", "blocked", "auth-required", "error"])(
    "preserves %s with unsupported usage",
    async (status) => {
      const account = { ...record(), status },
        native = { ...claude(), usageLimits: unsupported() };
      expect(snapshot(account, native).accounts[0]?.status).toBe(
        status === "error" ? "blocked" : status,
      );
      await expect(start(account, native)).rejects.toThrow(/blocked, busy/);
    },
  );

  it("requires current verified native subscription auth for unsupported manual retry", async () => {
    for (const change of [
      { auth: { status: "unknown" as const } },
      { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)) },
      { instanceId: ProviderInstanceId.make("claude-other") },
    ]) {
      const native = { ...claude(), usageLimits: unsupported(), ...change };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/authorization is unverified/);
    }
  });

  it("admits a CLI billed to API credits; the subscription's exhaustion does not apply", async () => {
    const native = {
      ...claude(),
      usageLimits: unsupported(),
      auth: { status: "authenticated" as const, type: "api-key" },
    };
    expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
    await expect(start(record(), native)).resolves.toBeUndefined();
  });

  it.each(["malformed", "exhausted"])(
    "retains %s history across unsupported probes until a complete valid read",
    async (kind) => {
      const full = (utilization: number | null) =>
        claudeUsageResponseToLimits({
          checkedAt: claude().checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization, resets_at: "2026-10-09T09:00:00Z" },
              seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
            },
          },
        }).limits;
      let published = full(kind === "malformed" ? null : 100);
      for (const probed of [
        unsupported(false),
        unsupported(true),
        undefined,
        { ...unsupported(), unavailable: { reason: "probeFailed" as const } },
      ]) {
        published = resolveUsageLimitsAfterProbe({ published, probed })!;
        expect(
          snapshot(record(), { ...claude(), usageLimits: published }).accounts[0]?.status,
        ).toBe("exhausted");
        await expect(start(record(), { ...claude(), usageLimits: published })).rejects.toThrow(
          /no remaining permitted usage/,
        );
      }
      const sparse = claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "five_hour", utilization: 0 },
        { overageIncluded: undefined },
      );
      published = applyUsageLimitsUpdate({
        previous: published,
        update: sparse!,
        checkedAt: claude().checkedAt,
      })!;
      await expect(start(record(), { ...claude(), usageLimits: published })).rejects.toThrow(
        /no remaining permitted usage/,
      );
      const recovered = resolveUsageLimitsAfterProbe({ published, probed: full(0) });
      const native = { ...claude(), usageLimits: recovered };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("unknown");
      expect(
        snapshot(record(), native).recommendations.every(
          (recommendation) => recommendation.id === null,
        ),
      ).toBe(true);
      await expect(start(record(), native)).resolves.toBeUndefined();
    },
  );

  it("keeps an expired error without quota evidence unknown and permits deliberate native retry", async () => {
    const account = record(),
      result = snapshot(account);
    expect(result.accounts[0]).toMatchObject({
      status: "unknown",
      providerInstanceId: "claudeAgent",
      authenticated: true,
      quota: { ...emptyQuota, freshness: "unknown" },
    });
    expect(result.recommendations.every((recommendation) => recommendation.id === null)).toBe(true);
    await expect(start(account)).resolves.toBeUndefined();
    expect(account).toEqual(record()); // The companion's stored observation is never rewritten.
  });

  it.each([
    ["fresh", DateTime.formatIso(DateTime.makeUnsafe(now - 1000))],
    [
      "at the validity boundary",
      DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS)),
    ],
    ["future", DateTime.formatIso(DateTime.makeUnsafe(now + 86400000))],
    ["malformed", "invalid"],
    ["missing", undefined],
  ])("keeps %s failure evidence blocked", async (_, lastQuotaErrorAt) => {
    const { lastQuotaErrorAt: _lastQuotaErrorAt, ...base } = record();
    const account = { ...base, ...(lastQuotaErrorAt === undefined ? {} : { lastQuotaErrorAt }) };
    expect(snapshot(account).accounts[0]?.status).toBe("exhausted");
    await expect(start(account)).rejects.toThrow(/no remaining permitted usage/);
  });

  it("expires only after the existing observation validity period", () => {
    const account = {
      ...record(),
      lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)),
    };
    expect(snapshot(account).accounts[0]?.status).toBe("unknown");
  });

  const currentNativeWindows = () => ({
    ...claude(),
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      windows: [
        {
          id: "five_hour",
          kind: "session" as const,
          label: "Session",
          usedPercent: 2,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
        },
        {
          id: "seven_day",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: 2,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 86400000)),
        },
        {
          id: "seven_day_example",
          kind: "weekly" as const,
          label: "Scoped",
          usedPercent: 3,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 86400000)),
        },
      ] as Array<ServerProviderUsageWindow>,
    },
  });

  it("allows a deliberate retry when complete current Claude usage contradicts an expired unobserved error", async () => {
    const account = record(),
      native = currentNativeWindows(),
      result = snapshot(account, native);
    expect(result.accounts[0]).toMatchObject({
      status: "unknown",
      authenticated: true,
      quota: { freshness: "unknown" },
    });
    expect(result.recommendations.every((recommendation) => recommendation.id === null)).toBe(true);
    await expect(start(account, native)).resolves.toBeUndefined();
    expect(account).toEqual(record());
  });

  it("permits an unused native session without a reset while keeping capacity unknown", async () => {
    const index = 0;
    const account = record(),
      native = currentNativeWindows();
    native.usageLimits.windows[index] = {
      ...native.usageLimits.windows[index]!,
      usedPercent: 0,
      resetsAt: undefined,
    };
    const result = snapshot(account, native);
    expect(result.accounts[0]?.status).toBe("unknown");
    expect(result.recommendations.every((recommendation) => recommendation.id === null)).toBe(true);
    await expect(start(account, native)).resolves.toBeUndefined();
    expect(account).toEqual(record());
  });

  it("permits the native zero/null response without treating unknown usage as zero", async () => {
    const usage = (utilization: number | null) =>
      claudeUsageResponseToLimits({
        checkedAt: claude().checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization, resets_at: null },
            seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
          },
        },
      }).limits;
    const native = { ...claude(), usageLimits: usage(0) };
    expect(native.usageLimits.windows).toHaveLength(2);
    expect(
      native.usageLimits.windows.find((window) => window.id === "five_hour")?.resetsAt,
    ).toBeUndefined();
    await expect(start(record(), native)).resolves.toBeUndefined();
    await expect(
      start({ ...record(), lastQuotaErrorAt: native.checkedAt }, native),
    ).rejects.toThrow(/no remaining permitted usage/);
    await expect(start(record(), { ...native, usageLimits: usage(null) })).rejects.toThrow(
      /no remaining permitted usage/,
    );
  });

  it.each([1, 2])("still requires a reset for zero-use weekly window %s", async (index) => {
    const native = currentNativeWindows();
    native.usageLimits.windows[index] = {
      ...native.usageLimits.windows[index]!,
      usedPercent: 0,
      resetsAt: undefined,
    };
    await expect(start(record(), native)).rejects.toThrow(/no remaining permitted usage/);
  });

  it.each([
    { utilization: 0, resets_at: "invalid" },
    { utilization: 0, resets_at: "" },
    { utilization: -1, resets_at: null },
    { utilization: NaN, resets_at: null },
    { utilization: Infinity, resets_at: null },
    { utilization: 101, resets_at: null },
    { utilization: null, resets_at: null },
  ])("does not normalize invalid native evidence into unused capacity: %j", async (five_hour) => {
    const usageLimits = claudeUsageResponseToLimits({
      checkedAt: claude().checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour,
          seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
        },
      },
    }).limits;
    expect(usageLimits.unavailable?.reason).toBe("probeFailed");
    await expect(start(record(), { ...claude(), usageLimits })).rejects.toThrow(
      /no remaining permitted usage/,
    );
  });

  it("does not clear an old failure when the native response has no complete account windows", async () => {
    for (const rate_limits of [
      {},
      {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
      },
    ]) {
      const usageLimits = claudeUsageResponseToLimits({
        checkedAt: claude().checkedAt,
        response: { rate_limits_available: true, rate_limits },
      }).limits;
      expect(usageLimits.windows).toHaveLength(0);
      expect(usageLimits.unavailable?.reason).toBe("probeFailed");
      await expect(start(record(), { ...claude(), usageLimits })).rejects.toThrow(
        /no remaining permitted usage/,
      );
    }
  });

  it.each(
    [
      [{ display_name: "Example", utilization: null, resets_at: null }],
      [{ display_name: "Example", utilization: -1, resets_at: null }],
      [{ display_name: "Example", utilization: 0, resets_at: "invalid" }],
      [{ display_name: "", utilization: 0, resets_at: null }],
      [{}],
      [null],
      "invalid",
    ].map((model_scoped) => ({ model_scoped })),
  )("keeps present unknown or malformed scoped usage unavailable: %j", async ({ model_scoped }) => {
    const usageLimits = claudeUsageResponseToLimits({
      checkedAt: claude().checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
          ...({ model_scoped } as object),
        },
      },
    }).limits;
    expect(usageLimits.unavailable?.reason).toBe("probeFailed");
    await expect(start(record(), { ...claude(), usageLimits })).rejects.toThrow(
      /no remaining permitted usage/,
    );
  });

  it("requires a complete probe to recover invalid scoped evidence after sparse usage updates", async () => {
    const probe = (utilization: number | null) =>
      claudeUsageResponseToLimits({
        checkedAt: claude().checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
            ...({
              model_scoped: [
                { display_name: "Example", utilization, resets_at: "2026-10-10T08:00:00Z" },
              ],
            } as object),
          },
        },
      }).limits;
    const healthy = probe(3);
    const invalid = resolveUsageLimitsAfterProbe({ published: healthy, probed: probe(null) });
    expect(invalid?.unavailable?.invalidResponse).toBe(true);
    expect(invalid?.windows).toEqual(healthy.windows);
    await expect(start(record(), { ...claude(), usageLimits: invalid })).rejects.toThrow(
      /no remaining permitted usage/,
    );
    expect(resolveUsageLimitsAfterProbe({ published: invalid, probed: undefined })).toBe(invalid);
    const failedRefresh = resolveUsageLimitsAfterProbe({
      published: invalid,
      probed: {
        checkedAt: claude().checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    });
    expect(failedRefresh?.unavailable?.invalidResponse).toBe(true);
    const partial = applyUsageLimitsUpdate({
      previous: failedRefresh,
      checkedAt: claude().checkedAt,
      update: {
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 1,
            resetsAt: "2026-10-09T09:00:00Z",
          },
        ],
      },
    });
    expect(partial?.windows.find((window) => window.id === "five_hour")?.usedPercent).toBe(1);
    expect(partial?.unavailable?.reason).toBe("probeFailed");
    await expect(start(record(), { ...claude(), usageLimits: partial })).rejects.toThrow(
      /no remaining permitted usage/,
    );
    const denied = applyUsageLimitsUpdate({
      previous: partial,
      checkedAt: claude().checkedAt,
      update: { windows: [], ordinaryUsageAllowed: false },
    });
    expect(denied?.ordinaryUsageAllowed).toBe(false);
    expect(denied?.unavailable?.reason).toBe("probeFailed");
    await expect(start(record(), { ...claude(), usageLimits: denied })).rejects.toThrow(
      /Claude's usage limit is used up\./,
    );
    const complete = resolveUsageLimitsAfterProbe({ published: partial, probed: probe(3) });
    expect(complete?.unavailable).toBeUndefined();
    await expect(start(record(), { ...claude(), usageLimits: complete })).resolves.toBeUndefined();
  });

  it.each([-1, 1.01, NaN, Infinity])(
    "never lets malformed streamed utilization %s clear an exhausted session",
    async (utilization) => {
      const native = currentNativeWindows();
      native.usageLimits.windows[0] = { ...native.usageLimits.windows[0]!, usedPercent: 100 };
      const update = claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "five_hour", utilization },
        { overageIncluded: undefined },
      );
      expect(update).toBeUndefined();
      const usageLimits = update
        ? applyUsageLimitsUpdate({
            previous: native.usageLimits,
            update,
            checkedAt: claude().checkedAt,
          })
        : native.usageLimits;
      expect(usageLimits?.windows[0]?.usedPercent).toBe(100);
      await expect(start(record(), { ...native, usageLimits })).rejects.toThrow(
        /no remaining permitted usage/,
      );
    },
  );

  it.each([-1, 0, NaN, Infinity, Number.MAX_VALUE])(
    "never inherits a cached reset when the stream supplies malformed reset %s",
    async (resetsAt) => {
      const native = currentNativeWindows();
      native.usageLimits.windows[0] = { ...native.usageLimits.windows[0]!, usedPercent: 100 };
      const update = claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "five_hour", utilization: 0, resetsAt },
        { overageIncluded: undefined },
      );
      expect(update).toBeUndefined();
      const usageLimits = update
        ? applyUsageLimitsUpdate({
            previous: native.usageLimits,
            update,
            checkedAt: claude().checkedAt,
          })
        : native.usageLimits;
      expect(usageLimits?.windows[0]?.usedPercent).toBe(100);
      await expect(start(record(), { ...native, usageLimits })).rejects.toThrow(
        /no remaining permitted usage/,
      );
    },
  );

  it.each(["supported", "unsupported"])(
    "fences a streamed rejection from %s usage until a strictly later complete valid native read",
    async (initial) => {
      const probe = (at: number, utilization: number | null = 0) =>
        claudeUsageResponseToLimits({
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
          response: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization, resets_at: null },
              seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
            },
          },
        }).limits;
      const healthy =
        initial === "supported"
          ? probe(now - 2000)
          : claudeUsageResponseToLimits({
              checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 2000)),
              response: { rate_limits_available: false, rate_limits: null },
            }).limits;
      const update = claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: "five_hour" },
        { overageIncluded: undefined },
      );
      expect(update?.ordinaryUsageAllowed).toBe(false);
      const denied = applyUsageLimitsUpdate({
        previous: healthy,
        update: update!,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)),
      });
      await expect(start(record(), { ...claude(), usageLimits: denied })).rejects.toThrow(
        /Claude's 5-hour limit is used up\./,
      );
      for (const companion of ["unavailable", "invalid"] as const) {
        await expect(
          start(record(), { ...claude(), usageLimits: denied }, companion),
        ).rejects.toThrow(/Claude's 5-hour limit is used up\./);
      }
      const allowed = claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "five_hour", utilization: 0 },
        { overageIncluded: undefined },
      );
      const partial = applyUsageLimitsUpdate({
        previous: denied,
        update: allowed!,
        checkedAt: claude().checkedAt,
      });
      expect(partial?.ordinaryUsageAllowed).toBe(false);
      await expect(start(record(), { ...claude(), usageLimits: partial })).rejects.toThrow(
        /Claude's usage limit is used up\./,
      );
      const unsupported = claudeUsageResponseToLimits({
        checkedAt: claude().checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits;
      for (const incomplete of [
        undefined,
        unsupported,
        probe(now - 1000),
        probe(now, 100),
        probe(now, null),
      ]) {
        const retained = resolveUsageLimitsAfterProbe({ published: partial, probed: incomplete });
        expect(retained?.ordinaryUsageAllowed).toBe(false);
        await expect(start(record(), { ...claude(), usageLimits: retained })).rejects.toThrow(
          /Claude's usage limit is used up\./,
        );
      }
      const recovered = resolveUsageLimitsAfterProbe({ published: partial, probed: probe(now) });
      expect(recovered?.ordinaryUsageAllowed).toBeUndefined();
      expect(recovered?.nativeDenialObservedAt).toBeUndefined();
      expect(recovered?.nativeDenialRequiresFullRead).toBeUndefined();
      expect(recovered?.nativeAllowanceObservedAt).toBe(claude().checkedAt);
      const native = { ...claude(), usageLimits: recovered };
      expect(snapshot(record(), native).accounts[0]).toMatchObject({
        status: "unknown",
        quota: { freshness: "unknown", ordinaryUsageAllowed: null },
      });
      expect(
        snapshot(record(), native).recommendations.every(
          (recommendation) => recommendation.id === null,
        ),
      ).toBe(true);
      await expect(start(record(), native)).resolves.toBeUndefined();
      for (const companion of ["unavailable", "invalid"] as const) {
        await expect(start(record(), native, companion)).resolves.toBeUndefined();
      }
    },
  );

  it.each(["probeFailed", "unsupported"] as const)(
    "retains a Claude refusal beyond cache freshness after %s and positive sparse usage",
    async (reason) => {
      const later = now + 20 * 60000,
        checkedAt = DateTime.formatIso(DateTime.makeUnsafe(later));
      const rejected = claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: "five_hour" },
        { overageIncluded: undefined },
      );
      const denied = applyUsageLimitsUpdate({
        previous: currentNativeWindows().usageLimits,
        update: rejected!,
        checkedAt: claude().checkedAt,
      });
      const failed = resolveUsageLimitsAfterProbe({
        published: denied,
        probed: { checkedAt, windows: [], unavailable: { reason } },
      });
      const allowed = claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.01,
          resetsAt: (later + 3600000) / 1000,
        },
        { overageIncluded: undefined },
      );
      const partial = applyUsageLimitsUpdate({ previous: failed, update: allowed!, checkedAt });
      const native = { ...claude(), checkedAt, usageLimits: partial };
      expect(snapshot(record(), native, later).accounts[0]?.status).toBe("exhausted");
      expect(
        snapshot(record(), native, later).recommendations.every(
          (recommendation) => recommendation.id === null,
        ),
      ).toBe(true);
      for (const companion of ["available", "unavailable", "invalid"] as const) {
        await expect(start(record(), native, companion, later)).rejects.toThrow(
          /Claude's (?:5-hour|usage) limit is used up\./,
        );
      }
      const full = claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
          },
        },
      }).limits;
      const recovered = {
        ...native,
        usageLimits: resolveUsageLimitsAfterProbe({ published: partial, probed: full }),
      };
      expect(snapshot(record(), recovered, later).accounts[0]?.status).toBe("unknown");
      await expect(start(record(), recovered, "available", later)).resolves.toBeUndefined();
    },
  );

  it("does not let a sparse update renew a stale complete read for legacy manual retry", async () => {
    const later = now + 20 * 60000,
      checkedAt = DateTime.formatIso(DateTime.makeUnsafe(later));
    const probe = (at: string) =>
      claudeUsageResponseToLimits({
        checkedAt: at,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 2, resets_at: "2026-10-10T08:00:00Z" },
          },
        },
      }).limits;
    const complete = probe(claude().checkedAt);
    const failed = resolveUsageLimitsAfterProbe({
      published: complete,
      probed: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.01,
        resetsAt: (later + 3600000) / 1000,
      },
      { overageIncluded: undefined },
    );
    const partial = applyUsageLimitsUpdate({ previous: failed, update: update!, checkedAt });
    expect(partial?.checkedAt).toBe(checkedAt);
    expect(partial?.nativeAllowanceObservedAt).toBe(claude().checkedAt);
    const native = { ...claude(), checkedAt, usageLimits: partial };
    expect(snapshot(record(), native, later).accounts[0]?.status).toBe("exhausted");
    await expect(start(record(), native, "available", later)).rejects.toThrow(
      /no remaining permitted usage/,
    );
    const recovered = {
      ...native,
      usageLimits: resolveUsageLimitsAfterProbe({ published: partial, probed: probe(checkedAt) }),
    };
    expect(snapshot(record(), recovered, later).accounts[0]?.status).toBe("unknown");
    await expect(start(record(), recovered, "available", later)).resolves.toBeUndefined();
  });

  it("does not mistake windows assembled from sparse events after a failed probe for a complete read", async () => {
    let usageLimits = {
      checkedAt: claude().checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    } as NonNullable<ReturnType<typeof claude>["usageLimits"]>;
    for (const rateLimitType of ["five_hour", "seven_day"] as const) {
      const update = claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType, utilization: 0.02, resetsAt: (now + 86400000) / 1000 },
        { overageIncluded: undefined },
      );
      usageLimits = applyUsageLimitsUpdate({
        previous: usageLimits,
        update: update!,
        checkedAt: claude().checkedAt,
      })!;
    }
    expect(usageLimits.windows).toHaveLength(2);
    expect(usageLimits.unavailable).toBeUndefined();
    expect(usageLimits.nativeAllowanceObservedAt).toBeUndefined();
    await expect(start(record(), { ...claude(), usageLimits })).rejects.toThrow(
      /no remaining permitted usage/,
    );
  });

  it.each(["invalid", "", "2026-10-09T08:00:00Z", "2026-10-08T08:00:00Z"])(
    "rejects zero-use windows with supplied invalid or elapsed reset %s",
    async (resetsAt) => {
      const native = currentNativeWindows();
      native.usageLimits.windows[0] = {
        ...native.usageLimits.windows[0]!,
        usedPercent: 0,
        resetsAt,
      };
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/no remaining permitted usage/);
    },
  );

  it.each([
    [
      "stale",
      { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)) },
    ],
    ["future", { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 86400000)) }],
    ["malformed time", { checkedAt: "invalid" }],
    ["unavailable", { unavailable: { reason: "probeFailed" as const } }],
  ])("keeps %s native usage from clearing an old failure", async (_, change) => {
    const native = currentNativeWindows();
    const changed = { ...native, usageLimits: { ...native.usageLimits, ...change } };
    expect(snapshot(record(), changed).accounts[0]?.status).toBe("exhausted");
    await expect(start(record(), changed)).rejects.toThrow(/no remaining permitted usage/);
  });

  it.each([
    undefined,
    "invalid",
    DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)),
    DateTime.formatIso(DateTime.makeUnsafe(now + 86400000)),
  ])(
    "requires a fresh complete witness instead of fresh sparse checkedAt: %s",
    async (nativeAllowanceObservedAt) => {
      const native = currentNativeWindows();
      const changed = {
        ...native,
        usageLimits: { ...native.usageLimits, nativeAllowanceObservedAt },
      };
      expect(snapshot(record(), changed).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), changed)).rejects.toThrow(/no remaining permitted usage/);
    },
  );

  it.each([
    ["exhausted", { usedPercent: 100 }],
    ["negative", { usedPercent: -1 }],
    ["over range", { usedPercent: 101 }],
    ["nonfinite", { usedPercent: NaN }],
    ["expired reset", { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now)) }],
    ["invalid reset", { resetsAt: "invalid" }],
    ["missing reset", { resetsAt: undefined }],
  ])("preserves denial when any scoped window is %s", (_, change) => {
    const native = currentNativeWindows();
    native.usageLimits.windows[2] = {
      ...native.usageLimits.windows[2]!,
      ...change,
    } as (typeof native.usageLimits.windows)[number];
    expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
  });

  it("requires both unique native account-wide windows and preserves newer or observed failures", () => {
    for (const index of [0, 1]) {
      const native = currentNativeWindows();
      native.usageLimits.windows.splice(index, 1);
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
    }
    const duplicate = currentNativeWindows();
    duplicate.usageLimits.windows.push(duplicate.usageLimits.windows[0]!);
    expect(snapshot(record(), duplicate).accounts[0]?.status).toBe("exhausted");
    expect(
      snapshot(
        { ...record(), lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)) },
        currentNativeWindows(),
      ).accounts[0]?.status,
    ).toBe("exhausted");
    expect(
      snapshot(
        { ...record(), quota: { ...emptyQuota, source: "native-app-server" } },
        currentNativeWindows(),
      ).accounts[0]?.status,
    ).toBe("exhausted");
  });

  it.each([
    { window: { usedPercent: 100, resetsAt: now / 1000 + 3600 } },
    { weekly: { usedPercent: 100, resetsAt: now / 1000 + 86400 } },
    { observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
    { expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)) },
    { source: "native-app-server" },
    { windows: [{ id: "primary", usedPercent: 100 }] },
    { source: "native-app-server", ordinaryUsageAllowed: false },
    { source: "native-app-server", spendControlReached: true },
    { source: "native-app-server", rateLimitReachedType: "usage_limit_reached" },
    { source: "native-app-server", credits: { hasCredits: true, unlimited: true } },
    { denied: true },
    { denied: false },
    { ordinaryUsageAllowed: false },
    { ordinaryUsageAllowed: true },
    { spendControlReached: false },
    { spendControlReached: true },
  ])("preserves quota-backed failure evidence: %j", (evidence) => {
    const account = { ...record(), quota: { ...emptyQuota, ...evidence } };
    expect(snapshot(account).accounts[0]?.status).toBe("exhausted");
  });

  it("preserves native quota windows and fresh native denials", () => {
    const base = claude();
    const native: ReturnType<typeof claude> = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
          },
        ],
      },
    };
    expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
    const denied = {
      ...native,
      usageLimits: {
        ...native.usageLimits!,
        windows: [],
        ordinaryUsageAllowed: false,
        nativeDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      },
    };
    expect(snapshot(record(), denied).accounts[0]?.status).toBe("exhausted");
  });

  it.each(["active", "blocked", "auth-required", "error"])(
    "preserves %s admission state",
    async (status) => {
      const account = { ...record(), status };
      expect(snapshot(account).accounts[0]?.status).toBe(status === "error" ? "blocked" : status);
      await expect(start(account)).rejects.toThrow(/blocked, busy/);
    },
  );

  it("never clears Codex exhaustion or authorizes an unverified Claude profile", async () => {
    const codex = { ...record(), id: "codex-1", provider: "codex", authKind: "chatgpt" };
    expect(snapshot(codex, provider("codex", "codex", now)).accounts[0]?.status).toBe("exhausted");
    for (const native of [
      { ...claude(), auth: { status: "unknown" as const } },
      {
        ...claude(),
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - CAPACITY_MAX_AGE_MS - 1)),
      },
    ]) {
      expect(snapshot(record(), native).accounts[0]?.status).toBe("exhausted");
      await expect(start(record(), native)).rejects.toThrow(/authorization is unverified/);
    }
  });

  it("does not treat malformed or absent quota as an empty valid observation", () => {
    for (const quota of [undefined, [], "invalid", { window: {} }]) {
      expect(snapshot({ ...record(), quota }).accounts[0]?.status).toBe("exhausted");
    }
  });
});
