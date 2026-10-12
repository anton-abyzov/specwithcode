import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { ProviderInstanceId, type ManualCodexCreditIntent } from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import { residentCreditPermission } from "./codexManualCredits.ts";

const now = Date.parse("2026-10-09T07:00:00Z");
const intent: ManualCodexCreditIntent = {
  type: "human-submit-existing-credits",
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  expectedQuotaPoolId: `codex:sha256:${createHash("sha256").update("expected-account").digest("hex")}`,
  observedAt: new Date(now).toISOString(),
};
const funded: CodexSchema.V2GetAccountRateLimitsResponse = {
  accountId: "expected-account",
  ordinaryUsageAllowed: false,
  rateLimits: {
    spendControlReached: false,
    rateLimitReachedType: "rate_limit_reached",
    credits: { hasCredits: true, unlimited: false, balance: "746" },
  },
};
describe("resident native credit admission", () => {
  it("accepts only the actual process account with ordinary or funded permission", () => {
    expect(residentCreditPermission(intent, funded, now, intent)).toBe(true);
    expect(residentCreditPermission(intent, funded, now + 60_001, intent)).toBe(false);
    expect(residentCreditPermission(intent, funded, now, { ...intent, model: "changed" })).toBe(
      false,
    );
    expect(
      residentCreditPermission(
        intent,
        { ...funded, ordinaryUsageAllowed: true, rateLimits: { spendControlReached: false } },
        now,
        intent,
      ),
    ).toBe(true);
  });
  it.each([
    { ...funded, accountId: "old-resident-account" },
    { ...funded, accountId: null },
    { ...funded, ordinaryUsageAllowed: null },
    { ...funded, rateLimits: { ...funded.rateLimits, spendControlReached: true } },
    {
      ...funded,
      ordinaryUsageAllowed: true,
      rateLimits: {
        ...funded.rateLimits,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      },
    },
    { ...funded, rateLimits: { ...funded.rateLimits, rateLimitReachedType: null } },
    {
      ...funded,
      rateLimits: {
        ...funded.rateLimits,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
    },
    { ...funded, rateLimitsByLimitId: { codex: { spendControlReached: true } } },
  ] satisfies Array<CodexSchema.V2GetAccountRateLimitsResponse>)(
    "refuses resident mismatch, unknown or denied permission %#",
    (response) => {
      expect(residentCreditPermission(intent, response, now, intent)).toBe(false);
    },
  );
});
