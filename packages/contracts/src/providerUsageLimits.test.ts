import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderUsageLimitsUpdate, ServerProviderUsageLimits } from "./providerUsageLimits.ts";

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
