import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { provider } from "./fixtures.ts";
import { nativeCreditContinuationAllowed } from "./nativeCreditContinuation.ts";

const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
const funded = () => ({ ...provider("codex", "codex", now).usageLimits!,
  nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), ordinaryUsageAllowed: false,
  spendControlReached: false, rateLimitReachedType: "rate_limit_reached",
  credits: { hasCredits: true, unlimited: false, balance: "68.7550445000" },
});

describe("native existing-credit continuation", () => {
  it("accepts the observed M3 included-exhausted funded state", () => {
    expect(nativeCreditContinuationAllowed(funded(), now)).toBe(true);
  });
  it.each([
    { spendControlReached: true }, { spendControlReached: null },
    { ordinaryUsageAllowed: null }, { ordinaryUsageAllowed: true },
    { credits: null }, { credits: { hasCredits: false, unlimited: false, balance: "9" } },
    { credits: { hasCredits: true, unlimited: false, balance: "0" } },
    { rateLimitReachedType: "workspace_owner_credits_depleted" },
    { rateLimitReachedType: "workspace_member_usage_limit_reached" },
    { rateLimitReachedType: "future_unknown_denial" },
    { rateLimitReachedType: null }, { rateLimitReachedType: undefined },
    { credits: { hasCredits: true, unlimited: true } },
    { credits: { hasCredits: true, unlimited: false, balance: "NaN" } },
    { credits: { hasCredits: true, unlimited: false, balance: "-2" } },
    { quotaPoolId: undefined }, { quotaPoolObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1)) },
    { nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 60_001)) },
    { nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) },
    { nativeDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
    { nativeDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) },
    { nativeCreditDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
    { nativeCreditDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) },
    { nativeCreditDenialObservedAt: "invalid" },
    { unavailable: { reason: "probeFailed" as const } },
  ])("refuses a contradictory, stale, unknown or denied observation %j", (change) => {
    expect(nativeCreditContinuationAllowed({ ...funded(), ...change }, now)).toBe(false);
  });
  it("accepts a newer full read after a historical denial", () => {
    expect(nativeCreditContinuationAllowed({ ...funded(), nativeDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1)) }, now)).toBe(true);
    expect(nativeCreditContinuationAllowed({ ...funded(), nativeCreditDenialObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1)) }, now)).toBe(true);
  });
  it("compares positive decimal strings without rounding or inferring monetary units", () => {
    expect(nativeCreditContinuationAllowed({ ...funded(), credits: { hasCredits: true, unlimited: false, balance: "0.000000000000000000000001" } }, now)).toBe(true);
  });
});
