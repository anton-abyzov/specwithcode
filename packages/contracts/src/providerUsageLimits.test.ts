import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderUsageLimitsUpdate, ServerProviderUsageLimits } from "./providerUsageLimits.ts";

// The window as it was before amounts (c46e2efe5), as an older client decodes it.
const LegacyWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  modelScope: Schema.optional(TrimmedNonEmptyString),
});
const LegacyLimits = Schema.Struct({ checkedAt: IsoDateTime, windows: ForwardCompatibleArray(LegacyWindow) });

describe("window amounts", () => {
  const window = {
    id: "premium_interactions",
    kind: "monthly",
    label: "Premium requests",
    usedPercent: 59,
    resetsAt: "2026-12-01T00:00:00Z",
  } as const;
  const reading = {
    checkedAt: "2026-11-19T08:00:00Z",
    windows: [{ ...window, used: 885, limit: 1500, unit: "premium requests" }],
  };

  it("decodes through the window schema before amounts and keeps the same window", () => {
    expect(Schema.decodeUnknownSync(LegacyLimits)(reading).windows).toEqual([window]);
  });

  it("carries the amounts through today's schema without checking their values", () => {
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(reading).windows).toEqual(reading.windows);
    const odd = { ...window, used: -3, limit: 0, unit: "" };
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)({ ...reading, windows: [odd] }).windows).toEqual([odd]);
  });
});

describe("native credit withdrawal contract", () => {
  it("preserves the full-read denial fence through sparse and published wire contracts", () => {
    const update = { windows: [], ordinaryUsageAllowed: false, nativeDenialRequiresFullRead: true };
    expect(Schema.decodeUnknownSync(ProviderUsageLimitsUpdate)(update)).toEqual(update);
    const limits = { ...update, checkedAt: "2026-10-09T08:00:00Z" };
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(limits)).toEqual(limits);
  });

  it.each([false, null, 0, "true"])("rejects a non-denial full-read fence %j", (nativeDenialRequiresFullRead) => {
    expect(() => Schema.decodeUnknownSync(ProviderUsageLimitsUpdate)({ windows: [], nativeDenialRequiresFullRead })).toThrow();
    expect(() => Schema.decodeUnknownSync(ServerProviderUsageLimits)({ checkedAt: "2026-10-09T08:00:00Z", windows: [], nativeDenialRequiresFullRead })).toThrow();
  });

  it("preserves an invalid usage response fence through the wire contract", () => {
    const limits = { checkedAt: "2026-10-09T08:00:00Z", windows: [], unavailable: { reason: "probeFailed", invalidResponse: true } };
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(limits)).toEqual(limits);
  });

  it.each([false, null, 0, "true"])("rejects a non-fence invalid response marker %j", (invalidResponse) => {
    expect(() => Schema.decodeUnknownSync(ServerProviderUsageLimits)({
      checkedAt: "2026-10-09T08:00:00Z", windows: [], unavailable: { reason: "probeFailed", invalidResponse },
    })).toThrow();
  });

  it("preserves the negative-only sparse marker without inventing credit metadata", () => {
    const update = { windows: [], nativeCreditDenied: true };
    expect(Schema.decodeUnknownSync(ProviderUsageLimitsUpdate)(update)).toEqual(update);
  });

  it.each([false, null, 0, "true"])("rejects a non-denial marker %j", (nativeCreditDenied) => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderUsageLimitsUpdate)({ windows: [], nativeCreditDenied }),
    ).toThrow();
  });

  it("retains an independently dated credit withdrawal alongside included permission", () => {
    const limits = {
      checkedAt: "2026-10-09T07:00:01Z",
      windows: [],
      ordinaryUsageAllowed: true,
      nativeAllowanceObservedAt: "2026-10-09T07:00:00Z",
      nativeCreditDenialObservedAt: "2026-10-09T07:00:01Z",
    };
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(limits)).toEqual(limits);
  });

  it("rejects a non-string credit withdrawal timestamp", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerProviderUsageLimits)({
        checkedAt: "2026-10-09T07:00:01Z",
        windows: [],
        nativeCreditDenialObservedAt: 0,
      }),
    ).toThrow();
  });

  it("retains an unorderable timestamp for the admission consumer to refuse", () => {
    // Shared IsoDateTime intentionally preserves wire strings. The fold and
    // admission checks must never treat an unorderable negative as recovered.
    const limits = {
      checkedAt: "2026-10-09T07:00:01Z",
      windows: [],
      nativeCreditDenialObservedAt: "invalid",
    };
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(limits)).toEqual(limits);
  });
});
