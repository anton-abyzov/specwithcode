import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
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
  resolveUsageLimitsAfterProbe,
} from "../provider/providerUsageLimits.ts";
import * as Capacity from "./Capacity.ts";
import * as NativeRoute from "./NativeRoute.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import { capacitySnapshot, nativeQuotaDenied } from "./capacitySnapshot.ts";
import { provider, rawAccount, settings } from "./fixtures.ts";

/**
 * The 2026-10-21 incident: native Claude hit its 5-hour limit at 06:44Z with
 * a reset at 09:30Z, and the rejected event carried its utilization only in
 * `unifiedWindows`. Threads never auto-resumed because the start refusal had
 * no reset and the denial outlived it.
 */
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const probedAt = at("2026-10-21T06:30:00Z");
const deniedAt = at("2026-10-21T06:44:00Z");
const beforeReset = at("2026-10-21T09:00:00Z");
const afterReset = at("2026-10-21T09:31:00Z");
const RESET = "2026-10-21T09:30:00.000Z";
const WEEKLY_RESET = "2026-10-26T07:33:20.000Z";
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const names = { overageIncluded: "Fable" } as const;

const incident = {
  status: "rejected" as const,
  rateLimitType: "five_hour" as const,
  resetsAt: 1_792_575_000,
  unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: 1_792_575_000 },
    seven_day: { utilization: 0.42, resetsAt: 1_793_000_000 },
  },
};

const probe = (
  checkedAt: number,
  fiveHour: number,
  options: { readonly sevenDay?: number; readonly fable?: number } = {},
) =>
  claudeUsageResponseToLimits({
    checkedAt: iso(checkedAt),
    response: {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: fiveHour, resets_at: "2026-10-21T14:00:00Z" },
        seven_day: { utilization: options.sevenDay ?? 42, resets_at: WEEKLY_RESET },
        ...({
          model_scoped: [
            { display_name: "Fable", utilization: options.fable ?? 30, resets_at: WEEKLY_RESET },
          ],
        } as object),
      },
    },
  }).limits;

const deny = (
  event: Parameters<typeof claudeRateLimitEventToUpdate>[0],
  previous: ServerProviderUsageLimits = probe(probedAt, 99),
) =>
  applyUsageLimitsUpdate({
    previous,
    update: claudeRateLimitEventToUpdate(event, names)!,
    checkedAt: iso(deniedAt),
  })!;

const claude = (now: number, usageLimits: ServerProviderUsageLimits): ServerProvider => ({
  ...provider("claudeAgent", "claudeAgent", now),
  usageLimits,
});

const readyCompanion = (now: number) => ({
  accounts: [rawAccount("claude-1", now)],
  policy: { mode: "balanced", preferredProvider: null, selectedAccount: null },
});

const start = (input: {
  readonly native: ServerProvider;
  readonly now: number;
  readonly model?: string;
  readonly refresh?: "same" | "timeout";
  readonly companion?: "ready" | "unavailable";
  readonly refreshes?: { count: number };
}) =>
  Clock.clockWith((clock) =>
    Effect.flatMap(Capacity.Capacity, (capacity) =>
      capacity.assertNativeStart(
        ProviderInstanceId.make("claudeAgent"),
        "/synthetic/workspace",
        undefined,
        input.model,
      ),
    ).pipe(
      Effect.provideService(
        Clock.Clock,
        Object.assign(Object.create(clock), {
          currentTimeMillis: Effect.succeed(input.now),
          currentTimeMillisUnsafe: () => input.now,
          // The status-check timeout elapses at once instead of after a minute.
          sleep: () => Effect.void,
        }),
      ),
    ),
  ).pipe(
    Effect.provide(
      Capacity.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(NativeRoute.NativeRoute, { verify: () => Effect.succeed(true) }),
            Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
            Layer.mock(Providers.ProviderRegistry)({
              getProviders: Effect.succeed([input.native]),
              refreshInstance: () => {
                if (input.refreshes) input.refreshes.count += 1;
                return input.refresh === "timeout" ? Effect.never : Effect.succeed([input.native]);
              },
            }),
            Layer.succeed(HostProcessEnvironment, {}),
            Layer.succeed(SwitchFetch, (async () => {
              if ((input.companion ?? "unavailable") === "unavailable")
                throw new Error("Synthetic companion offline");
              return Response.json(readyCompanion(input.now));
            }) as typeof fetch),
          ),
        ),
      ),
    ),
  );

describe("a real Claude 5-hour rejection", () => {
  const denied = deny(incident);

  it("records the spent window, the other windows and the denial's reset", () => {
    expect(denied.windows.find((window) => window.id === "five_hour")).toMatchObject({
      usedPercent: 100,
      resetsAt: RESET,
    });
    expect(denied.windows.find((window) => window.id === "seven_day")?.usedPercent).toBe(42);
    expect(denied).toMatchObject({
      ordinaryUsageAllowed: false,
      nativeDenialRequiresFullRead: true,
      nativeDenialResetsAt: RESET,
    });
  });

  it.effect("refuses before the reset naming the window and carrying the reset time", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(start({ native: claude(beforeReset, denied), now: beforeReset })),
      ).toMatchObject({
        _tag: "ProviderSetupError",
        detail: `Claude's 5-hour limit is used up; it resets at ${RESET}.`,
        usageLimit: { resetAt: RESET },
      });
      // A status check that cannot finish before the reset still refuses.
      const timedOut = yield* Effect.flip(
        start({ native: claude(beforeReset, denied), now: beforeReset, refresh: "timeout" }),
      );
      expect(timedOut.detail).toMatch(/status check timed out/);
    }),
  );

  it.effect("stops denying once the reset passes, still re-reading native status first", () =>
    Effect.gen(function* () {
      expect(nativeQuotaDenied(denied, beforeReset)).toBe(true);
      expect(nativeQuotaDenied(denied, afterReset)).toBe(false);
      for (const refresh of ["same", "timeout"] as const) {
        const refreshes = { count: 0 };
        yield* start({ native: claude(afterReset, denied), now: afterReset, refresh, refreshes });
        expect(refreshes.count).toBe(1);
      }
      yield* start({ native: claude(afterReset, denied), now: afterReset, companion: "ready" });
    }),
  );

  it("no longer reports the account exhausted once the reset passes", () => {
    const status = (now: number) =>
      capacitySnapshot({
        raw: readyCompanion(now),
        providers: [claude(now, denied)],
        settings,
        baseEnv: {},
        now,
      }).accounts[0]?.status;
    expect(status(beforeReset)).toBe("exhausted");
    expect(status(afterReset)).toBe("ready");
  });

  it("after the reset, lets only a read with room in every account-wide window replace the denial", () => {
    const resolve = (probed: ServerProviderUsageLimits) =>
      resolveUsageLimitsAfterProbe({ driver: claudeDriver, published: denied, probed });
    // A newer read showing the session still full moves the lapse to its reset.
    for (const now of [beforeReset, afterReset]) {
      const stillFull = resolve(probe(now, 100));
      expect(stillFull).toMatchObject({
        ordinaryUsageAllowed: false,
        nativeDenialResetsAt: "2026-10-21T14:00:00.000Z",
      });
      expect(nativeQuotaDenied(stillFull, afterReset)).toBe(true);
    }
    // A full weekly after the session reset keeps the fence until the weekly resets.
    const weeklyFull = resolve(probe(afterReset, 0, { sevenDay: 100 }));
    expect(weeklyFull).toMatchObject({
      ordinaryUsageAllowed: false,
      nativeDenialResetsAt: WEEKLY_RESET,
    });
    expect(nativeQuotaDenied(weeklyFull, afterReset)).toBe(true);
    expect(nativeQuotaDenied(weeklyFull, at(WEEKLY_RESET) + 1)).toBe(false);
    // A valid read that is incomplete only because a window's reset already
    // passed, with room everywhere, replaces the denial once its reset passed.
    const stale = claudeUsageResponseToLimits({
      checkedAt: iso(afterReset),
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: "2026-10-21T14:00:00Z" },
          seven_day: { utilization: 42, resets_at: "2026-10-21T09:00:00Z" },
        },
      },
    }).limits;
    expect(stale.unavailable).toBeUndefined();
    expect(stale.nativeAllowanceObservedAt).toBeUndefined();
    expect(resolve(stale)).toBe(stale);
    // A failed read after the reset keeps the history; the denial has lapsed anyway.
    const failed = resolve({
      checkedAt: iso(afterReset),
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
    expect(failed?.ordinaryUsageAllowed).toBe(false);
    expect(nativeQuotaDenied(failed, afterReset)).toBe(false);
  });

  it("keeps denying past the reported reset while a spent weekly it carries is live", () => {
    // The event names only the session; the weekly reading comes from the last probe.
    const weekly = deny(
      Object.assign({}, incident, {
        unifiedWindows: { five_hour: incident.unifiedWindows.five_hour },
      }),
      probe(probedAt, 99, { sevenDay: 100 }),
    );
    expect(weekly.nativeDenialResetsAt).toBe(RESET);
    expect(nativeQuotaDenied(weekly, afterReset)).toBe(true);
    expect(nativeQuotaDenied(weekly, at(WEEKLY_RESET) + 1)).toBe(false);
  });

  it("clears on a complete read whose spent model weekly is the only full window", () => {
    const read = probe(beforeReset, 10, { fable: 100 });
    expect(read.nativeAllowanceObservedAt).toBe(iso(beforeReset));
    const cleared = resolveUsageLimitsAfterProbe({
      driver: claudeDriver,
      published: denied,
      probed: read,
    });
    expect(cleared).toBe(read);
    expect(nativeQuotaDenied(cleared, beforeReset, "claude-opus-5.5")).toBe(false);
    expect(nativeQuotaDenied(cleared, beforeReset, "claude-fable-5")).toBe(true);
    // A full account-wide weekly still keeps the read incomplete.
    expect(probe(beforeReset, 10, { sevenDay: 100 }).nativeAllowanceObservedAt).toBeUndefined();
  });

  it.effect("keeps a denial without a reported reset until a complete read", () =>
    Effect.gen(function* () {
      const { resetsAt: _top, unifiedWindows: _unified, ...bare } = incident;
      const unbounded = deny(bare);
      const later = afterReset + 7 * 86_400_000;
      expect(unbounded.nativeDenialResetsAt).toBeUndefined();
      expect(nativeQuotaDenied(unbounded, later)).toBe(true);
      // The window keeps the reset the last probe read, so the stop still says when.
      expect(
        yield* Effect.flip(start({ native: claude(afterReset, unbounded), now: afterReset })),
      ).toMatchObject({
        detail: "Claude's 5-hour limit is used up; it resets at 2026-10-21T14:00:00.000Z.",
        usageLimit: { resetAt: "2026-10-21T14:00:00.000Z" },
      });
      const stopped = yield* Effect.flip(start({ native: claude(later, unbounded), now: later }));
      expect(stopped.detail).toBe("Claude's usage limit is used up.");
      expect(stopped.usageLimit).toEqual({});
    }),
  );
});

describe("a model-scoped Claude rejection", () => {
  const denied = deny({
    status: "rejected",
    rateLimitType: "seven_day_overage_included",
    resetsAt: 1_793_000_000,
  });

  // Start gates do not pass the model yet, so a rejected model weekly still
  // fences the account, now only until its own reset.
  it.effect("fences every start until its window resets, naming the model weekly", () =>
    Effect.gen(function* () {
      expect(denied).toMatchObject({
        ordinaryUsageAllowed: false,
        nativeDenialRequiresFullRead: true,
        nativeDenialResetsAt: WEEKLY_RESET,
      });
      expect(denied.windows.find((window) => window.id === "seven_day_fable")?.usedPercent).toBe(
        100,
      );
      const native = claude(beforeReset, denied);
      for (const model of [undefined, "claude-opus-5.5", "claude-fable-5"]) {
        expect(nativeQuotaDenied(denied, beforeReset, model)).toBe(true);
        expect(
          yield* Effect.flip(start({ native, now: beforeReset, ...(model ? { model } : {}) })),
        ).toMatchObject({
          detail: `Claude's weekly Fable limit is used up; it resets at ${WEEKLY_RESET}.`,
          usageLimit: { resetAt: WEEKLY_RESET },
        });
      }
    }),
  );

  it("marks the account exhausted", () => {
    expect(
      capacitySnapshot({
        raw: readyCompanion(beforeReset),
        providers: [claude(beforeReset, denied)],
        settings,
        baseEnv: {},
        now: beforeReset,
      }).accounts[0]?.status,
    ).toBe("exhausted");
  });

  it("is not cleared by a complete read that still shows the model weekly spent", () => {
    const resolve = (probed: ServerProviderUsageLimits) =>
      resolveUsageLimitsAfterProbe({ driver: claudeDriver, published: denied, probed });
    const spent = probe(beforeReset, 10, { fable: 100 });
    expect(spent.nativeAllowanceObservedAt).toBe(iso(beforeReset));
    expect(resolve(spent)).toMatchObject({ ordinaryUsageAllowed: false });
    const room = probe(beforeReset, 10);
    expect(resolve(room)).toBe(room);
  });

  it("expires with the window's own reset", () => {
    for (const model of [undefined, "claude-opus-5.5", "claude-fable-5"])
      expect(nativeQuotaDenied(denied, at(WEEKLY_RESET) + 1, model)).toBe(false);
  });
});
