import {
  manualCreditBindingMatches,
  type ManualCodexCreditIntent,
  type ModelSelection,
} from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import { codexRateLimitsToLimits } from "../../provider/codexUsageLimits.ts";
import { nativeCreditContinuationAllowed } from "../../studio/nativeCreditContinuation.ts";

/** Bind to the resident process, which can outlive an external CLI sign-in change. */
export function residentCreditPermission(
  intent: ManualCodexCreditIntent,
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  now: number,
  selection: ModelSelection,
): boolean {
  if (!manualCreditBindingMatches(intent, selection, now)) return false;
  const limits = codexRateLimitsToLimits({
    snapshot: response.rateLimits,
    rateLimitsByLimitId: response.rateLimitsByLimitId,
    checkedAt: new Date(now).toISOString(),
    ...(response.accountId === undefined ? {} : { accountId: response.accountId }),
    ...(response.ordinaryUsageAllowed === undefined
      ? {}
      : { ordinaryUsageAllowed: response.ordinaryUsageAllowed }),
  });
  if (limits.quotaPoolId !== intent.expectedQuotaPoolId || limits.spendControlReached !== false)
    return false;
  const reached = limits.rateLimitReachedType;
  if (reached != null && reached !== "rate_limit_reached") return false;
  return limits.ordinaryUsageAllowed === true || nativeCreditContinuationAllowed(limits, now);
}
