import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind } from "@specweave-studio/contracts";
import type { ServerProvider } from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { CodexNativeRouteCheckError } from "../provider/CodexProvider.ts";
import * as NativeRoute from "./NativeRoute.ts";
import * as Capacity from "./Capacity.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import { provider, rawAccount, rawSnapshot, settings } from "./fixtures.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, Capacity.Capacity>,
  raw: unknown,
  native = [provider()],
  config = settings,
  unavailable = false,
  routeVerified: boolean | CodexNativeRouteCheckError = true,
  refreshed = native,
  refreshIds: string[] = [],
  switchOptions: {
    refreshedRaw?: unknown;
    refreshBusy?: boolean;
    requests?: string[];
    malformedJson?: boolean;
    refreshFailures?: number;
  } = {},
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Capacity.layer),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(NativeRoute.NativeRoute, {
            verify: () =>
              typeof routeVerified === "boolean"
                ? Effect.succeed(routeVerified)
                : Effect.fail(routeVerified),
          }),
          Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(config) }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Effect.succeed(native),
            refreshInstance: (id) =>
              Effect.sync(() => {
                refreshIds.push(id);
                return refreshed;
              }),
          }),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {}),
      Effect.provideService(SwitchFetch, (async (url) => {
        if (unavailable) throw new Error("synthetic-secret-error");
        if (switchOptions.malformedJson)
          return new Response("{", { headers: { "Content-Type": "application/json" } });
        const path = new URL(String(url)).pathname;
        switchOptions.requests?.push(path);
        if (path === "/api/refresh" && switchOptions.refreshBusy)
          return Response.json({}, { status: 409 });
        if (path === "/api/refresh" && (switchOptions.refreshFailures ?? 0) > 0) {
          switchOptions.refreshFailures! -= 1;
          return Response.json({}, { status: 500 });
        }
        return Response.json(
          path === "/api/refresh" && "refreshedRaw" in switchOptions
            ? switchOptions.refreshedRaw
            : raw,
        );
      }) as typeof fetch),
    ),
  );
const start = (id = "codex") =>
  Effect.flatMap(Capacity.Capacity, (capacity) =>
    capacity.assertNativeStart(ProviderInstanceId.make(id), "/workspace"),
  );
describe("blocking usage reset estimates", () => {
  const scenarios = [
    {
      name: "weekly exhaustion ignores an earlier session reset",
      session: 10,
      weekly: 100,
      sessionHours: 1,
      weeklyHours: 72,
      expectedHours: 72,
    },
    {
      name: "every exhausted window must reset",
      session: 100,
      weekly: 100,
      sessionHours: 4,
      weeklyHours: 2,
      expectedHours: 4,
    },
    {
      name: "an unknown blocker reset makes recovery unknown",
      session: 100,
      weekly: 100,
      sessionHours: 1,
      weeklyHours: null,
      expectedHours: null,
    },
    {
      name: "an expired blocker observation cannot predict recovery",
      session: 100,
      weekly: 100,
      sessionHours: 1,
      weeklyHours: -1,
      expectedHours: null,
    },
    {
      name: "below-limit windows cannot explain a denial",
      session: 10,
      weekly: 25,
      sessionHours: 1,
      weeklyHours: 72,
      expectedHours: null,
    },
    {
      name: "spend controls do not recover with a usage window",
      session: 100,
      weekly: 100,
      sessionHours: 1,
      weeklyHours: 72,
      expectedHours: null,
      spendControlReached: true,
    },
    {
      name: "workspace denials have no inferred window recovery",
      session: 100,
      weekly: 100,
      sessionHours: 1,
      weeklyHours: 72,
      expectedHours: null,
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    },
  ] as const;
  it.each(scenarios)("native: $name", async (scenario) => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(now + hours * 3600000));
    const base = provider("codex", "codex", now);
    const native = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        ordinaryUsageAllowed: false,
        spendControlReached: "spendControlReached" in scenario,
        rateLimitReachedType:
          "rateLimitReachedType" in scenario ? scenario.rateLimitReachedType : "rate_limit_reached",
        windows: [
          {
            id: "primary",
            kind: "session" as const,
            label: "Session",
            usedPercent: scenario.session,
            resetsAt: at(scenario.sessionHours),
          },
          {
            id: "secondary",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: scenario.weekly,
            ...(scenario.weeklyHours === null ? {} : { resetsAt: at(scenario.weeklyHours) }),
          },
          {
            id: "other:primary",
            kind: "session" as const,
            label: "Other bucket",
            usedPercent: 100,
            resetsAt: at(200),
          },
        ],
      },
    };
    const error = await run(start(), null, [native], settings, true).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ _tag: "ProviderSetupError", usageLimit: {} });
    expect((error as { usageLimit: { resetAt?: string } }).usageLimit.resetAt).toBe(
      scenario.expectedHours === null ? undefined : at(scenario.expectedHours),
    );
    expect((error as { detail: string }).detail.includes("Next observed reset")).toBe(
      scenario.expectedHours !== null,
    );
  });
  it("reads a Claude denial's reset from Claude's own window ids", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(now + hours * 3600000));
    const base = provider("claudeAgent", "claudeAgent", now);
    const native = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        ordinaryUsageAllowed: false,
        rateLimitReachedType: "rate_limit_reached",
        windows: [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent: 100,
            resetsAt: at(3),
          },
          {
            id: "seven_day",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 40,
            resetsAt: at(90),
          },
          {
            id: "seven_day_fable",
            kind: "weekly" as const,
            label: "Weekly · Fable",
            modelScope: "Fable",
            usedPercent: 100,
            resetsAt: at(120),
          },
        ],
      },
    };
    const error = await run(start("claudeAgent"), null, [native], settings, true).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ _tag: "ProviderSetupError", usageLimit: { resetAt: at(3) } });
  });
  it.each(scenarios)("companion: $name", async (scenario) => {
    const now = Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000) * 1000;
    const at = (hours: number) => now / 1000 + hours * 3600;
    const raw = rawSnapshot(now);
    const base = raw.accounts[0]!;
    const snapshot = {
      ...raw,
      accounts: [
        {
          ...base,
          status: "exhausted",
          quota: {
            ...base.quota,
            ordinaryUsageAllowed: false,
            spendControlReached: "spendControlReached" in scenario,
            rateLimitReachedType:
              "rateLimitReachedType" in scenario
                ? scenario.rateLimitReachedType
                : "rate_limit_reached",
            window: { usedPercent: scenario.session, resetsAt: at(scenario.sessionHours) },
            weekly: {
              usedPercent: scenario.weekly,
              resetsAt: scenario.weeklyHours === null ? null : at(scenario.weeklyHours),
            },
            windows: [
              {
                id: "other:primary",
                bucketId: "other",
                appliesToSelection: false,
                usedPercent: 100,
                resetsAt: at(200),
              },
            ],
          },
        },
      ],
    };
    const error = await run(start(), snapshot).catch((error: unknown) => error);
    expect(error).toMatchObject({ _tag: "ProviderSetupError", usageLimit: {} });
    expect((error as { usageLimit: { resetAt?: string } }).usageLimit.resetAt).toBe(
      scenario.expectedHours === null
        ? undefined
        : DateTime.formatIso(DateTime.makeUnsafe(at(scenario.expectedHours) * 1000)),
    );
    expect((error as { detail: string }).detail.includes("Next observed reset")).toBe(
      scenario.expectedHours !== null,
    );
  });
  it("includes every applicable companion window beyond its summary pair", async () => {
    const now = Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000) * 1000;
    const raw = rawSnapshot(now),
      account = raw.accounts[0]!,
      later = now / 1000 + 72 * 3600;
    account.quota.window.usedPercent = 100;
    Object.assign(account.quota, {
      windows: [
        {
          id: "codex:additional",
          bucketId: "codex",
          appliesToSelection: true,
          usedPercent: 100,
          resetsAt: later,
        },
      ],
    });
    await expect(run(start(), raw)).rejects.toMatchObject({
      usageLimit: { resetAt: DateTime.formatIso(DateTime.makeUnsafe(later * 1000)) },
    });
  });
});
describe("native session admission", () => {
  const creditStart = (now: number) =>
    Clock.clockWith((clock) =>
      Effect.flatMap(Capacity.Capacity, (capacity) =>
        capacity.assertNativeStart(ProviderInstanceId.make("codex"), "/workspace", {
          allowCredits: true,
          expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
        }),
      ).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillis: Effect.succeed(now),
          currentTimeMillisUnsafe: () => now,
        }),
      ),
    );
  const fundedProvider = (now: number) => {
    const base = provider("codex", "codex", now);
    return {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        ordinaryUsageAllowed: false,
        spendControlReached: false,
        rateLimitReachedType: "rate_limit_reached",
        credits: { hasCredits: true, unlimited: false, balance: "68.7550445000" },
        windows: [
          {
            id: "primary",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 100,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
            windowDurationMins: 10080,
          },
        ],
      },
    };
  };
  it("admits an explicitly credit-enabled start after refreshing the exact selected provider", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now),
      refreshIds: string[] = [];
    const raw = rawSnapshot(now - 1000);
    raw.accounts[0]!.status = "exhausted";
    await expect(
      run(
        creditStart(Date.parse(native.checkedAt)),
        raw,
        [native],
        settings,
        false,
        true,
        [native],
        refreshIds,
      ),
    ).resolves.toBeUndefined();
    expect(refreshIds).toEqual(["codex"]);
    await expect(run(start(), raw, [native])).rejects.toThrow(/no remaining permitted usage/);
  });
  it("admits fresh native existing credits with no optional companion", async () => {
    const native = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    await expect(
      run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true),
    ).resolves.toBeUndefined();
  });
  it.each(["blocked", "active", "auth-required"])(
    "keeps companion %s authoritative for funded starts",
    async (status) => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
        native = fundedProvider(now),
        raw = rawSnapshot(now - 1000);
      raw.accounts[0]!.status = status;
      await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native])).rejects.toThrow(
        /blocked, busy/,
      );
    },
  );
  it("does not permit paid fallback when refresh loses credit permission", async () => {
    const native = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    const depleted = {
      ...native,
      usageLimits: {
        ...native.usageLimits,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
    };
    await expect(
      run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true, true, [
        depleted,
      ]),
    ).rejects.toThrow(/Existing credits/);
  });
  it("rejects a refreshed native account different from the explicit credit request", async () => {
    const native = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    const other = {
      ...native,
      usageLimits: { ...native.usageLimits, quotaPoolId: `codex:sha256:${"b".repeat(64)}` },
    };
    await expect(
      run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true, true, [other]),
    ).rejects.toThrow(/native account changed/);
  });
  it("rejects cached permission returned by a failed explicit refresh even within the 60-second age limit", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now - 1000);
    await expect(run(creditStart(now), null, [native], settings, true)).rejects.toThrow(
      /Existing credits/,
    );
  });
  it("does not use a stale full credit read even if authentication and a negative notification are fresh", async () => {
    const native = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe()));
    native.usageLimits.nativeAllowanceObservedAt = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 60_001),
    );
    await expect(
      run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true),
    ).rejects.toThrow(/Existing credits/);
  });
  it("does not clear real native spend or workspace denials when credit mode is requested", async () => {
    for (const change of [
      { spendControlReached: true },
      { rateLimitReachedType: "workspace_owner_usage_limit_reached" },
    ]) {
      const native = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe()));
      Object.assign(native.usageLimits, change);
      await expect(
        run(creditStart(Date.parse(native.checkedAt)), null, [native], settings, true),
      ).rejects.toThrow(/Existing credits/);
    }
  });
  it.each(["newer", "equal", "invalid"])(
    "keeps a %s companion quota failure authoritative over banked credits",
    async (kind) => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
        native = fundedProvider(now - 1000),
        raw = rawSnapshot(now - 2000);
      Object.assign(raw.accounts[0]!, {
        lastQuotaErrorAt:
          kind === "invalid"
            ? "invalid"
            : DateTime.formatIso(DateTime.makeUnsafe(kind === "equal" ? now - 1000 : now)),
      });
      await expect(run(creditStart(Date.parse(native.checkedAt)), raw, [native])).rejects.toThrow(
        /no remaining permitted usage/,
      );
    },
  );
  it("accepts a new full credit observation after a historical companion failure", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now),
      raw = rawSnapshot(now - 2000);
    Object.assign(raw.accounts[0]!, {
      lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)),
    });
    await expect(
      run(creditStart(Date.parse(native.checkedAt)), raw, [native]),
    ).resolves.toBeUndefined();
  });
  it("refuses malformed companion failure evidence instead of treating it as an absent service", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now),
      raw = rawSnapshot(now - 2000);
    Object.assign(raw.accounts[0]!, { lastQuotaErrorAt: 42 });
    await expect(run(creditStart(now), raw, [native])).rejects.toThrow(
      /capacity response is invalid/,
    );
  });
  it("refuses malformed JSON from a responding companion", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now);
    await expect(
      run(creditStart(now), null, [native], settings, false, true, [native], [], {
        malformedJson: true,
      }),
    ).rejects.toThrow(/capacity response is invalid/);
  });
  it("rejects a credit-bound instance reconfigured as an API route", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      native = fundedProvider(now);
    const config = {
      ...settings,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "OPENAI_API_KEY", value: "synthetic-api-key", sensitive: true }],
          config: {},
        },
      },
    };
    await expect(run(creditStart(now), null, [native], config, true)).rejects.toThrow(
      /API or managed provider route/,
    );
  });

  it("keeps verified native default usable when optional Switch is absent", async () => {
    await expect(run(start(), null, [provider()], settings, true)).resolves.toBeUndefined();
    const snapshot = await run(
      Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current),
      null,
      [provider()],
      settings,
      true,
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.policy).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret-error");
  });
  it.each(["ordinary-denied", "spend-denied"])(
    "fences fresh native %s before unavailable Switch or unbound-home fallback",
    async (kind) => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
        base = provider("codex", "codex", now);
      const native: ReturnType<typeof provider> = {
        ...base,
        usageLimits: {
          ...base.usageLimits!,
          nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          ordinaryUsageAllowed: kind === "ordinary-denied" ? false : true,
          spendControlReached: kind === "spend-denied",
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 20,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
              windowDurationMins: 300,
            },
          ],
        },
      };
      const custom = {
        ...settings,
        providers: {
          ...settings.providers,
          codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" },
        },
      };
      for (const [config, unavailable] of [
        [settings, true],
        [custom, false],
      ] as const) {
        await expect(run(start(), rawSnapshot(), [native], config, unavailable)).rejects.toThrow(
          /limit|spend/i,
        );
        // Neither a 20%-used window nor a spend denial proves when permission returns.
        await expect(
          run(start(), rawSnapshot(), [native], config, unavailable),
        ).rejects.toMatchObject({
          usageLimit: {},
          detail: expect.not.stringContaining("Next observed reset"),
        });
      }
    },
  );
  it("preserves the deliberate unbound native-home fallback when quota is unknown", async () => {
    const requests: string[] = [];
    const custom = {
      ...settings,
      providers: {
        ...settings.providers,
        codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" },
      },
    };
    await expect(
      run(start(), null, [provider()], custom, false, true, [provider()], [], { requests }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
  it("does not turn an old native denial into fresh quota proof for optional fallbacks", async () => {
    const base = provider(),
      staleAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
      );
    const native: ReturnType<typeof provider> = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: staleAt,
        ordinaryUsageAllowed: false,
        spendControlReached: true,
      },
    };
    const custom = {
      ...settings,
      providers: {
        ...settings.providers,
        codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" },
      },
    };
    for (const config of [settings, custom])
      await expect(run(start(), null, [native], config, true)).resolves.toBeUndefined();
  });
  it("fences a fresh live spend denial without renewing an expired full-read allowance", async () => {
    const base = provider(),
      oldAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
      );
    const native: ReturnType<typeof provider> = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: oldAt,
        ordinaryUsageAllowed: true,
        spendControlReached: true,
        nativeDenialObservedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      },
    };
    const custom = {
      ...settings,
      providers: {
        ...settings.providers,
        codex: { ...settings.providers.codex, homePath: "/tmp/explicit-native-home" },
      },
    };
    for (const config of [settings, custom])
      await expect(run(start(), null, [native], config, true)).rejects.toThrow(/spend control/);
  });
  it("rechecks a cached native denial once and admits a newly allowed selected account", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      denied = fundedProvider(now - 1000),
      allowed = provider("codex", "codex", now);
    Object.assign(allowed.usageLimits!, {
      ordinaryUsageAllowed: true,
      nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    });
    const checks: string[] = [];
    const effect = Clock.clockWith((clock) =>
      start().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillis: Effect.succeed(now),
          currentTimeMillisUnsafe: () => now,
        }),
      ),
    );
    await expect(
      run(effect, null, [denied], settings, true, true, [allowed], checks),
    ).resolves.toBeUndefined();
    expect(checks).toEqual(["codex"]);
  });
  it("keeps a current denial structured after its bounded refresh", async () => {
    const denied = fundedProvider(DateTime.toEpochMillis(DateTime.nowUnsafe())),
      checks: string[] = [];
    await expect(
      run(start(), null, [denied], settings, true, true, [denied], checks),
    ).rejects.toMatchObject({
      _tag: "ProviderSetupError",
      usageLimit: { resetAt: denied.usageLimits.windows[0]!.resetsAt },
    });
    expect(checks).toEqual(["codex"]);
  });
  it("does not clear a cached denial with a failed or incomplete refresh", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      denied = fundedProvider(now - 1000);
    for (const next of [
      { ...provider(), status: "error" as const },
      {
        ...provider(),
        usageLimits: { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), windows: [] },
      },
      {
        ...provider(),
        usageLimits: {
          ...provider().usageLimits!,
          nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)),
          ordinaryUsageAllowed: true,
        },
      },
    ]) {
      const checks: string[] = [];
      await expect(
        run(start(), null, [denied], settings, true, true, [next], checks),
      ).rejects.toThrow(/status check failed|permission could not be verified/);
      expect(checks).toEqual(["codex"]);
    }
  });
  it("rejects effective custom routes even when native account and quota are fresh", async () => {
    await expect(run(start(), rawSnapshot(), [provider()], settings, false, false)).rejects.toThrow(
      /effective Codex route/,
    );
  });
  it.each(["timeout", "unavailable"] as const)(
    "denies %s route verification with retry guidance",
    async (reason) => {
      const error = await run(
        start(),
        rawSnapshot(),
        [provider()],
        settings,
        false,
        new CodexNativeRouteCheckError({ reason }),
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({
        _tag: "ProviderSetupError",
        detail: expect.stringContaining(
          reason === "timeout" ? "route check timed out" : "route check failed",
        ),
      });
      expect((error as { detail: string }).detail).toContain(
        "Refresh Providers on this machine and try again",
      );
      expect((error as { detail: string }).detail).not.toContain("custom endpoints");
    },
  );
  it("rejects failed refreshed native status with status guidance rather than asking an authenticated user to sign in", async () => {
    const attempts: string[] = [];
    const native = [{ ...provider(), status: "error" as const }];
    await expect(
      run(start(), rawSnapshot(), native, settings, false, true, native, attempts),
    ).rejects.toThrow(/native provider status check failed/);
    expect(attempts).toEqual(["codex"]);
  });
  it("says a timed-out sign-in probe did not finish instead of asking a signed-in user to sign in", async () => {
    const native = [
      {
        ...provider(),
        status: "warning" as const,
        auth: {
          status: "unknown" as const,
          type: "status-check-failed",
          label: "Status check did not finish",
        },
      },
    ];
    const error = await run(start(), rawSnapshot(), native, settings, false, true, native).catch(
      (cause: unknown) => cause,
    );
    expect((error as { detail: string }).detail).toMatch(/sign-in status check did not finish/);
    expect((error as { detail: string }).detail).not.toMatch(/authorization is unverified/);
  });
  it("rejects unavailable native status despite a fresh authenticated account", async () => {
    await expect(
      run(start(), rawSnapshot(), [{ ...provider(), availability: "unavailable" as const }]),
    ).rejects.toThrow(/authorization is unverified/);
  });
  it.each(["stale", "error"])(
    "refreshes only the selected shared provider once when its cache is %s",
    async (kind) => {
      const current = {
        ...provider(),
        ...(kind === "stale"
          ? {
              checkedAt: DateTime.formatIso(
                DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
              ),
            }
          : { status: "error" as const, auth: { status: "unknown" as const } }),
      };
      const attempts: string[] = [];
      await expect(
        run(start(), rawSnapshot(), [current], settings, false, true, [provider()], attempts),
      ).resolves.toBeUndefined();
      expect(attempts).toEqual(["codex"]);
    },
  );
  it("does not refresh a fresh authorized snapshot or bypass quota after a stale one is refreshed", async () => {
    const attempts: string[] = [];
    await run(start(), rawSnapshot(), [provider()], settings, false, true, [provider()], attempts);
    expect(attempts).toEqual([]);
    const raw = rawSnapshot();
    raw.accounts[0]!.status = "exhausted";
    const stale = {
      ...provider(),
      checkedAt: DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
      ),
    };
    // The companion's exhausted status is binding, but its below-limit windows do not explain the denial.
    await expect(
      run(start(), raw, [stale], settings, false, true, [provider()], attempts),
    ).rejects.toMatchObject({
      usageLimit: {},
      detail: expect.stringMatching(
        /no remaining permitted usage under its current usage limit\. Select/,
      ),
    });
    expect(attempts).toEqual(["codex"]);
  });
  it.each([
    ["admits", "20 seconds"],
    ["still bounds", "61 seconds"],
  ] as const)("%s a slow native status refresh on a loaded host (%s)", async (outcome, delay) => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      stale = {
        ...provider(),
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 16 * 60000)),
      };
    const slowStart = Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const fiber = yield* Effect.forkChild(start());
      yield* TestClock.adjust(delay);
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(Capacity.layer),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(NativeRoute.NativeRoute, { verify: () => Effect.succeed(true) }),
          Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Effect.succeed([stale]),
            refreshInstance: () =>
              Effect.sleep(delay).pipe(
                Effect.as([
                  { ...provider(), checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
                ]),
              ),
          }),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {}),
      Effect.provideService(SwitchFetch, (async () =>
        Response.json(rawSnapshot(now))) as unknown as typeof fetch),
      Effect.provide(TestClock.layer()),
    );
    const result = expect(Effect.runPromise(slowStart));
    if (outcome === "admits") await result.resolves.toBeUndefined();
    else await result.rejects.toThrow(/status check timed out/);
  });
  it("never authorizes a refresh that remains stale", async () => {
    const old = [
      {
        ...provider(),
        checkedAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
        ),
      },
    ];
    await expect(run(start(), rawSnapshot(), old, settings, false, true, old)).rejects.toThrow(
      /authorization is unverified/,
    );
  });
  it("recovers an idle host by refreshing stale native status and stale local quota exactly once", async () => {
    const old = DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000;
    const attempts: string[] = [],
      requests: string[] = [];
    await expect(
      run(
        start(),
        rawSnapshot(old),
        [{ ...provider(), checkedAt: DateTime.formatIso(DateTime.makeUnsafe(old)) }],
        settings,
        false,
        true,
        [provider()],
        attempts,
        { refreshedRaw: rawSnapshot(), requests },
      ),
    ).resolves.toBeUndefined();
    expect(attempts).toEqual(["codex"]);
    expect(requests).toEqual(["/api/state", "/api/refresh"]);
  });
  it("waits out a busy stale quota refresh, then reads its result instead of refreshing again", async () => {
    const requests: string[] = [];
    const exhausted = rawSnapshot(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000);
    exhausted.accounts[0]!.quota.weekly.usedPercent = 100;
    await expect(
      run(start(), exhausted, [provider()], settings, false, true, [provider()], [], {
        refreshBusy: true,
        requests,
      }),
    ).rejects.toThrow(/blocked, busy, exhausted or unverified/);
    expect(requests).toEqual(["/api/state", "/api/refresh", "/api/state"]);
  });
  it("does not admit an exhausted refreshed quota or a malformed refresh response", async () => {
    const stale = rawSnapshot(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
      exhausted = rawSnapshot();
    exhausted.accounts[0]!.status = "exhausted";
    await expect(
      run(start(), stale, [provider()], settings, false, true, [provider()], [], {
        refreshedRaw: exhausted,
      }),
    ).rejects.toMatchObject({
      usageLimit: {},
      detail: expect.stringMatching(
        /no remaining permitted usage under its current usage limit\. Select/,
      ),
    });
    const full = rawSnapshot(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000);
    full.accounts[0]!.quota.window.usedPercent = 100;
    await expect(
      run(start(), full, [provider()], settings, false, true, [provider()], [], {
        refreshedRaw: {},
      }),
    ).rejects.toThrow(/Fresh subscription capacity could not be verified/);
  });
  it("keeps ordinary background capacity reads passive when the local quota cache expires", async () => {
    const requests: string[] = [];
    const snapshot = await run(
      Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current),
      rawSnapshot(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
      [provider()],
      settings,
      false,
      true,
      [provider()],
      [],
      { requests },
    );
    expect(snapshot.accounts[0]?.status).toBe("stale");
    expect(requests).toEqual(["/api/state"]);
  });
  it("admits fresh explicit native ordinary permission despite a 100%-used window and explanatory reached type", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
      base = provider("codex", "codex", now),
      requests: string[] = [];
    const native: ReturnType<typeof provider> = {
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        ordinaryUsageAllowed: true,
        spendControlReached: false,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
            windowDurationMins: 300,
          },
        ],
      },
    };
    await expect(
      run(start(), rawSnapshot(now - 1000), [native], settings, false, true, [native], [], {
        requests,
      }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual(["/api/state"]);
  });
  it.each(["ordinary-denied", "spend-denied"])(
    "does not let banked credits override fresh native %s",
    async (kind) => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
        base = provider("codex", "codex", now);
      const native: ReturnType<typeof provider> = {
        ...base,
        usageLimits: {
          ...base.usageLimits!,
          nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          ordinaryUsageAllowed: kind === "ordinary-denied" ? false : true,
          spendControlReached: kind === "spend-denied",
          credits: { hasCredits: true, unlimited: false, balance: "1000" },
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
              windowDurationMins: 300,
            },
          ],
        },
      };
      await expect(run(start(), rawSnapshot(now - 1000), [native])).rejects.toThrow(
        /no remaining permitted usage/,
      );
    },
  );
  it("does not authorize an unknown, stale or legacy native snapshot on absence", async () => {
    for (const native of [
      { ...provider(), auth: { status: "unknown" as const } },
      {
        ...provider(),
        checkedAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 16 * 60000),
        ),
      },
      {
        ...provider("claudeAgent", "claudeAgent"),
        auth: { status: "authenticated" as const, type: "subscription-auth-unverified" },
      },
    ]) {
      await expect(run(start(native.instanceId), null, [native], settings, true)).rejects.toThrow(
        /authorization is unverified/,
      );
    }
  });
  it.each(["exhausted", "active", "stale"])(
    "rechecks current source %s before native launch",
    async (status) => {
      const raw = rawSnapshot();
      raw.accounts[0]!.status = status;
      // A stale verdict alone falls back to the reading; a full one still refuses.
      if (status === "stale") raw.accounts[0]!.quota.weekly.usedPercent = 100;
      await expect(run(start(), raw)).rejects.toThrow(
        status === "exhausted"
          ? /no remaining permitted usage/
          : /blocked, busy, exhausted or unverified/,
      );
    },
  );
  it("rejects legacy/manual source and malformed quota at the native operation boundary", async () => {
    const raw = rawSnapshot();
    raw.accounts[0]!.authKind = "oauth_token";
    raw.accounts[0]!.quota.source = "manual";
    await expect(run(start(), raw)).rejects.toThrow(/blocked/);
    const invalid = rawSnapshot();
    invalid.accounts[0]!.quota.expiresAt = "invalid";
    await expect(run(start(), invalid)).rejects.toThrow(/blocked/);
  });
  it.each(["blocked", "error", "auth-required"])(
    "does not admit authoritative source %s even when percentages are unknown",
    async (status) => {
      const raw = { ...rawSnapshot(), accounts: [{ ...rawAccount(), status, quota: null }] };
      await expect(run(start(), raw)).rejects.toThrow(/blocked/);
    },
  );
  describe("a stale reading the local service cannot re-verify", () => {
    const minutesAgo = (minutes: number) =>
      rawSnapshot(DateTime.toEpochMillis(DateTime.nowUnsafe()) - minutes * 60000);
    const full = (minutes: number) => {
      const raw = minutesAgo(minutes);
      raw.accounts[0]!.quota.weekly.usedPercent = 100;
      return raw;
    };
    const startWith = (raw: unknown, options: Parameters<typeof run>[8] = {}) =>
      run(start(), raw, [provider()], settings, false, true, [provider()], [], options);

    it("admits a roomy last reading when the refresh is busy", async () => {
      await expect(startWith(minutesAgo(16), { refreshBusy: true })).resolves.toBeUndefined();
    });
    it("retries a failed refresh once and enforces its answer", async () => {
      const requests: string[] = [];
      const exhausted = rawSnapshot();
      exhausted.accounts[0]!.status = "exhausted";
      await expect(
        startWith(minutesAgo(16), { refreshFailures: 1, refreshedRaw: exhausted, requests }),
      ).rejects.toThrow(/no remaining permitted usage/);
      expect(requests).toEqual(["/api/state", "/api/refresh", "/api/refresh"]);
    });
    it("admits a roomy last reading when both refresh attempts fail", async () => {
      const requests: string[] = [];
      await expect(
        startWith(minutesAgo(16), { refreshFailures: 2, requests }),
      ).resolves.toBeUndefined();
      expect(requests).toEqual(["/api/state", "/api/refresh", "/api/refresh"]);
    });
    it("refuses a full last reading when both refresh attempts fail", async () => {
      await expect(startWith(full(16), { refreshFailures: 2 })).rejects.toThrow(
        /Fresh subscription capacity could not be verified/,
      );
    });
    it("admits a roomy last reading when the refresh returns an unverifiable answer", async () => {
      await expect(startWith(minutesAgo(16), { refreshedRaw: {} })).resolves.toBeUndefined();
      await expect(
        startWith(minutesAgo(16), { refreshedRaw: minutesAgo(20) }),
      ).resolves.toBeUndefined();
    });
    it("does not trust a reading older than twelve hours", async () => {
      await expect(startWith(minutesAgo(13 * 60), { refreshFailures: 2 })).rejects.toThrow(
        /Fresh subscription capacity could not be verified/,
      );
    });
    it.each(["active", "blocked", "auth-required"])(
      "still refuses a %s profile whose reading has room",
      async (status) => {
        const raw = minutesAgo(16);
        raw.accounts[0]!.status = status;
        await expect(startWith(raw, { refreshFailures: 2 })).rejects.toThrow(
          /could not be verified/,
        );
      },
    );
    it("still refuses when the native provider denies new work", async () => {
      const denied = {
        ...provider(),
        usageLimits: {
          ...provider().usageLimits!,
          ordinaryUsageAllowed: false,
          nativeAllowanceObservedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        },
      };
      await expect(
        run(start(), minutesAgo(16), [denied], settings, false, true, [denied], [], {
          refreshFailures: 2,
        }),
      ).rejects.toThrow(/no remaining permitted usage/);
    });
  });
  describe("a Claude CLI billed to API credits", () => {
    // Claude Code signed in to the Claude Console reports "API Usage Billing":
    // the probe sees a key and no plan, so the snapshot carries auth type apiKey.
    const consoleSignIn = (now: number, overrides: Partial<ServerProvider["auth"]> = {}) => {
      const base = provider("claudeAgent", "claudeAgent", now);
      return {
        ...base,
        auth: {
          status: "authenticated" as const,
          type: "apiKey",
          label: "Claude API Key",
          ...overrides,
        },
        usageLimits: { checkedAt: base.checkedAt, windows: [] },
      } satisfies ServerProvider;
    };

    it("admits a Console sign-in without a subscription or capacity check", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const requests: string[] = [];
      const refreshed: string[] = [];
      const native = [consoleSignIn(now)];
      await expect(
        run(
          start("claudeAgent"),
          rawSnapshot(now),
          native,
          settings,
          false,
          true,
          native,
          refreshed,
          {
            requests,
          },
        ),
      ).resolves.toBeUndefined();
      expect(requests).toEqual([]);
      expect(refreshed).toEqual([]);
    });

    it("re-reads an expired status once, then admits the Console sign-in", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const refreshed: string[] = [];
      await expect(
        run(
          start("claudeAgent"),
          rawSnapshot(now),
          [consoleSignIn(now - 16 * 60_000)],
          settings,
          false,
          true,
          [consoleSignIn(now)],
          refreshed,
        ),
      ).resolves.toBeUndefined();
      expect(refreshed).toEqual(["claudeAgent"]);
    });

    it("still refuses a CLI that is not signed in", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const native = [consoleSignIn(now, { status: "unauthenticated" })];
      await expect(
        run(start("claudeAgent"), rawSnapshot(now), native, settings, false, true, native),
      ).rejects.toThrow(/authorization is unverified/);
    });
  });
  describe("an exhausted Claude profile after a new sign-in", () => {
    // The local service still holds the read of the account signed in before:
    // weekly limit reached, reset in four days. The person has since signed in
    // with an account that has room, which only a new read shows.
    const exhausted = (now: number) => {
      const raw = rawSnapshot(now);
      const account = rawAccount("claude-1", now);
      account.status = "exhausted";
      account.quota.weekly = { usedPercent: 100, resetsAt: Math.floor(now / 1000) + 4 * 86400 };
      return { ...raw, accounts: [account] };
    };
    const signedIn = (now: number) => ({
      ...rawSnapshot(now),
      accounts: [rawAccount("claude-1", now)],
    });

    it("re-reads before refusing and admits the account that has room", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const requests: string[] = [];
      const refreshed: string[] = [];
      const native = [provider("claudeAgent", "claudeAgent", now)];
      await expect(
        run(
          start("claudeAgent"),
          exhausted(now),
          native,
          settings,
          false,
          true,
          native,
          refreshed,
          {
            refreshedRaw: signedIn(now),
            requests,
          },
        ),
      ).resolves.toBeUndefined();
      expect(requests).toEqual(["/api/state", "/api/refresh"]);
      expect(refreshed).toEqual(["claudeAgent"]);
    });

    it("keeps a limit the re-read confirms, and re-reads at most once a minute", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const requests: string[] = [];
      const native = [provider("claudeAgent", "claudeAgent", now)];
      const twice = Effect.flip(start("claudeAgent")).pipe(
        Effect.zip(Effect.flip(start("claudeAgent"))),
      );
      const [first, second] = await run(
        twice,
        exhausted(now),
        native,
        settings,
        false,
        true,
        native,
        [],
        {
          refreshedRaw: exhausted(now),
          requests,
        },
      );
      for (const error of [first, second])
        expect(error).toMatchObject({
          _tag: "ProviderSetupError",
          usageLimit: {
            resetAt: DateTime.formatIso(
              DateTime.makeUnsafe((Math.floor(now / 1000) + 4 * 86400) * 1000),
            ),
          },
        });
      expect(requests).toEqual(["/api/state", "/api/refresh", "/api/state"]);
    });

    it("refuses on the cached read when the re-read fails", async () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const native = [provider("claudeAgent", "claudeAgent", now)];
      await expect(
        run(start("claudeAgent"), exhausted(now), native, settings, false, true, native, [], {
          refreshBusy: true,
        }),
      ).rejects.toMatchObject({ _tag: "ProviderSetupError", usageLimit: {} });
    });
  });
  it("permits supported consumer auth with explicitly unknown quotas, without inventing ready capacity", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const raw = {
      ...rawSnapshot(now),
      accounts: [{ ...rawAccount("claude-1", now), status: "unknown", quota: null }],
    };
    const native = [provider("claudeAgent", "claudeAgent", now)];
    await expect(run(start("claudeAgent"), raw, native)).resolves.toBeUndefined();
    const snapshot = await run(
      Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current),
      raw,
      native,
    );
    expect(snapshot.accounts[0]?.status).toBe("unknown");
    expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
  });
  it("keeps deliberate API instances separate and rejects unverified custom Claude isolation", async () => {
    const apiId = ProviderInstanceId.make("explicit-api");
    const config = {
      ...settings,
      providerInstances: {
        [apiId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "synthetic-explicit-api", sensitive: true },
          ],
          config: {},
        },
      },
    };
    await expect(run(start(apiId), null, [], config, true)).resolves.toBeUndefined();
    const native = provider("isolated", "claudeAgent");
    const custom = {
      ...settings,
      providerInstances: {
        [native.instanceId]: { driver: native.driver, config: { homePath: "/tmp/custom-claude" } },
      },
    };
    await expect(run(start(native.instanceId), null, [native], custom, true)).rejects.toThrow(
      /isolation is unverified/,
    );
  });
  it("rejects pinning an ineligible profile but Automatic clears the pin", async () => {
    const raw = rawSnapshot();
    raw.accounts[0]!.status = "exhausted";
    await expect(
      run(
        Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: "codex-1" })),
        raw,
      ),
    ).rejects.toThrow(/not eligible/);
    const automatic = await run(
      Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: null })),
      raw,
    );
    expect(automatic.available).toBe(true);
  });
});
