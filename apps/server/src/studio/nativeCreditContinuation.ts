import type { ServerProviderUsageLimits } from "@specweave-studio/contracts";

/** The display projection intentionally omits this companion failure timestamp. */
export function companionCreditFailureCleared(raw: unknown, accountId: string, observedAt: string | undefined): boolean {
  if (!raw || typeof raw !== "object" || !("accounts" in raw) || !Array.isArray(raw.accounts)) return false;
  const account: unknown = raw.accounts.find((row: unknown) => row !== null && typeof row === "object" && "id" in row && row.id === accountId);
  if (!account || typeof account !== "object") return false;
  if (!("lastQuotaErrorAt" in account) || account.lastQuotaErrorAt == null) return true;
  if (typeof account.lastQuotaErrorAt !== "string") return false;
  const failed = Date.parse(account.lastQuotaErrorAt), observed = Date.parse(observedAt ?? "");
  return Number.isFinite(failed) && Number.isFinite(observed) && failed < observed;
}

/** A fresh native observation may admit an explicit session using existing credits.
 * Included-usage recovery and background metadata must not opt into this path.
 * The provider remains authoritative when the actual turn is submitted.
 */
export function nativeCreditContinuationAllowed(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  if (!limits || limits.unavailable || limits.ordinaryUsageAllowed !== false
    || limits.spendControlReached !== false) return false;
  if (limits.rateLimitReachedType !== "rate_limit_reached")
    return false;
  const observed = Date.parse(limits.nativeAllowanceObservedAt ?? "");
  const identityAt = Date.parse(limits.quotaPoolObservedAt ?? "");
  const supersedingDenial = [limits.nativeDenialObservedAt, limits.nativeCreditDenialObservedAt]
    .some((value) => value !== undefined && (!Number.isFinite(Date.parse(value)) || Date.parse(value) >= observed));
  if (!Number.isFinite(observed) || observed > now || now - observed > 60_000
    || !Number.isFinite(identityAt) || identityAt !== observed
    || !/^codex:sha256:[a-f0-9]{64}$/.test(limits.quotaPoolId ?? "")
    || supersedingDenial)
    return false;
  const credits = limits.credits;
  // This initial path only covers the finite, funded state verified on M3.
  // Decimal text avoids float rounding/underflow and never infers currency.
  return credits?.hasCredits === true && typeof credits.balance === "string"
    && /^\d{1,24}(?:\.\d{1,24})?$/.test(credits.balance) && /[1-9]/.test(credits.balance);
}
