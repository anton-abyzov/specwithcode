import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@specweave-studio/contracts";
import { mergeUsage, type DailyTotals } from "@specweave-studio/shared/usageMerge";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { forecastUsage, FORECAST_FRESH_MS } from "./usageForecast";
const NOW = Date.parse("2026-10-23T12:00:00Z");
function input() {
  const daily: DailyTotals[] = Array.from({ length: 8 }, (_, index) => ({
    day: `2026-10-${16 + index}`,
    costUsd: index === 7 ? 100_000 : index + 1,
    totalTokens: index === 7 ? 999_999_999 : (index + 1) * 100,
    records: 1,
    unpricedRecords: 0,
    byProvider: new Map(),
  }));
  const environments = [
    {
      environmentId: EnvironmentId.make("forecast-test"),
      label: "Test machine",
      isPending: false,
      canReadDiagnostics: true,
      error: null,
      needsCursorKeychainAccess: false,
      summary: {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: new Date(NOW - 60_000).toISOString(),
        sinceDay: UsageDay.make("2026-10-01"),
        untilDay: UsageDay.make("2026-10-23"),
        timeZone: "UTC",
        buckets: [],
        sources: [
          {
            fingerprint: {
              hostId: "test",
              provider: "claude",
              resolvedHomePath: "/fixture/claude",
              volumeId: "test",
            },
            status: "ok",
            scannedFiles: 1,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 1,
            message: null,
          },
        ],
        pricing: { status: "fresh", source: "fixture", fetchedAt: null, knownModels: 1 },
        scanDurationMs: 1,
      },
    },
  ] as readonly EnvironmentUsageStatus[];
  return {
    usage: { ...mergeUsage([], USAGE_CONTRACT_VERSION), daily },
    environments,
    window: {
      sinceDay: UsageDay.make("2026-10-01"),
      untilDay: UsageDay.make("2026-10-23"),
      timeZone: "UTC",
    },
    providers: new Set(["claude"] as const),
    nowMs: NOW,
    partial: false,
    pinned: false,
  };
}
describe("measured daily outlook", () => {
  it("uses exact completed days, excluding today's partial activity", () => {
    const result = forecastUsage(input());
    expect(result.kind).toBe("available");
    if (result.kind !== "available") throw Error("expected forecast");
    expect(result.days).toHaveLength(7);
    expect(result.dailyCost).toEqual({ mean: 4, low: 1, high: 7 });
    expect(result.dailyTokens).toEqual({ mean: 400, low: 100, high: 700 });
    expect(result.dailyCost!.mean * 7).toBe(28);
    expect(result.forecastSince).toBe("2026-10-24");
    expect(result.forecastUntil).toBe("2026-10-30");
    expect(result.readAt).toBe(new Date(NOW - 60_000).toISOString());
  });
  it("counts fully scanned quiet dates as zero recorded activity", () => {
    const args = input();
    args.usage.daily = args.usage.daily.slice(0, 3);
    const result = forecastUsage(args);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") throw Error("expected forecast");
    expect(result.activeDays).toBe(3);
    expect(result.dailyCost!.mean).toBeCloseTo(6 / 7);
    expect(result.dailyCost!.low).toBe(0);
  });
  it("keeps token projection but suppresses partly unpriced money", () => {
    const args = input();
    args.usage.daily = args.usage.daily.map((day, index) => ({
      ...day,
      unpricedRecords: index === 0 ? 1 : 0,
    }));
    const result = forecastUsage(args);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") throw Error("expected forecast");
    expect(result.dailyCost).toBeNull();
    expect(result.dailyTokens.mean).toBe(400);
    expect(result.costUnavailableReason).toContain("unpriced");
  });
  it("suppresses money when current rates are stale", () => {
    const args = input();
    args.environments = args.environments.map((env) => ({
      ...env,
      summary: { ...env.summary!, pricing: { ...env.summary!.pricing, status: "cached" } },
    }));
    const result = forecastUsage(args);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") throw Error("expected forecast");
    expect(result.dailyCost).toBeNull();
    expect(result.costUnavailableReason).toContain("rates");
  });
  it("requires five completed calendar dates and three active dates", () => {
    const short = input();
    short.window.sinceDay = UsageDay.make("2026-10-20");
    expect(forecastUsage(short)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("five"),
    });
    const sparse = input();
    sparse.usage.daily = sparse.usage.daily.slice(0, 2);
    expect(forecastUsage(sparse)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("three active"),
    });
  });
  it("refuses pinned, hourly and partial scopes", () => {
    expect(forecastUsage({ ...input(), pinned: true }).kind).toBe("unavailable");
    expect(
      forecastUsage({
        ...input(),
        window: { ...input().window, sinceTime: "2026-10-22T12:00:00Z" },
      }).kind,
    ).toBe("unavailable");
    expect(forecastUsage({ ...input(), partial: true }).kind).toBe("unavailable");
  });
  it("requires complete current-version reports with usable timestamps", () => {
    const mutations: Array<(env: EnvironmentUsageStatus) => EnvironmentUsageStatus> = [
      (env: EnvironmentUsageStatus) => ({ ...env, summary: null }),
      (env: EnvironmentUsageStatus) => ({ ...env, error: "offline" }),
      (env: EnvironmentUsageStatus) => ({
        ...env,
        summary: { ...env.summary!, readAt: new Date(NOW - FORECAST_FRESH_MS - 1).toISOString() },
      }),
      (env: EnvironmentUsageStatus) => ({
        ...env,
        summary: { ...env.summary!, readAt: new Date(NOW + 120_000).toISOString() },
      }),
      (env: EnvironmentUsageStatus) => ({
        ...env,
        summary: {
          ...env.summary!,
          sources: env.summary!.sources.map((source) => ({
            ...source,
            status: "partial" as const,
          })),
        },
      }),
      (env: EnvironmentUsageStatus) => ({
        ...env,
        summary: { ...env.summary!, contractVersion: USAGE_CONTRACT_VERSION + 1 },
      }),
    ];
    for (const mutation of mutations) {
      const args = input();
      args.environments = args.environments.map(mutation);
      expect(forecastUsage(args).kind).toBe("unavailable");
    }
  });
  it("ignores configured history directories that do not exist", () => {
    const args = input();
    args.environments = [
      ...args.environments.map((env) => ({
        ...env,
        summary: {
          ...env.summary!,
          sources: [
            ...env.summary!.sources,
            {
              ...env.summary!.sources[0]!,
              fingerprint: {
                ...env.summary!.sources[0]!.fingerprint,
                resolvedHomePath: "/fixture/claude-second",
              },
              status: "missing" as const,
            },
          ],
        },
      })),
      // A second machine with no Claude history at all.
      ...args.environments.map((env) => ({
        ...env,
        environmentId: EnvironmentId.make("forecast-second"),
        summary: {
          ...env.summary!,
          sources: env.summary!.sources.map((source) => ({
            ...source,
            fingerprint: { ...source.fingerprint, hostId: "second" },
            status: "missing" as const,
          })),
        },
      })),
    ];
    expect(forecastUsage(args).kind).toBe("available");

    const none = input();
    none.environments = none.environments.map((env) => ({
      ...env,
      summary: {
        ...env.summary!,
        sources: env.summary!.sources.map((source) => ({ ...source, status: "missing" as const })),
      },
    }));
    expect(forecastUsage(none).kind).toBe("unavailable");
  });
  it("uses the viewer's calendar across time zones", () => {
    const args = input();
    args.nowMs = Date.parse("2026-10-23T01:00:00Z");
    args.window.timeZone = "America/New_York";
    args.environments = args.environments.map((env) => ({
      ...env,
      summary: { ...env.summary!, readAt: new Date(args.nowMs).toISOString() },
    }));
    const result = forecastUsage(args);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") throw Error("expected forecast");
    expect(result.days.at(-1)!.day).toBe("2026-10-21");
    expect(result.forecastSince).toBe("2026-10-23");
  });
});
