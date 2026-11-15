/**
 * Closed quota periods: what each account's weekly or monthly window had used
 * when it reset, and so what was left unused. Each environment records the
 * resets it sees in its own reads and keeps them for a year; clients merge
 * environments by account key.
 *
 * @module usageResetLedger
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/**
 * Why the window started over: at its announced time, before it (the provider
 * reset limits early), or because a banked reset was redeemed.
 */
export const UsageResetCause = Schema.Literals(["scheduled", "early", "redeemed"]);
export type UsageResetCause = typeof UsageResetCause.Type;

export const UsageResetPeriod = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  windowId: TrimmedNonEmptyString,
  windowKind: ServerProviderUsageWindow.fields.kind,
  /** The model family the window is limited to; absent for an account-wide window. */
  modelScope: Schema.optional(TrimmedNonEmptyString),
  windowDurationMins: Schema.optional(NonNegativeInt),
  /** Absent for the first period seen of a window: its start was never observed. */
  startedAt: Schema.optional(IsoDateTime),
  endedAt: IsoDateTime,
  /**
   * The last read before the reset. Spend after it is unknown, so
   * `lostPercent` is an upper bound that is exact only when this is close to
   * `endedAt`.
   */
  lastReadAt: IsoDateTime,
  usedPercentAtReset: Percent,
  lostPercent: Percent,
  cause: UsageResetCause,
});
export type UsageResetPeriod = typeof UsageResetPeriod.Type;

/** At most a year is kept, so a longer range returns the same. */
export const UsageResetLedgerInput = Schema.Struct({
  sinceDays: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 366 }))),
});
export type UsageResetLedgerInput = typeof UsageResetLedgerInput.Type;

/** An account with a window being followed: it was read here, whether or not a period closed. */
export const UsageResetLedgerAccount = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
});
export type UsageResetLedgerAccount = typeof UsageResetLedgerAccount.Type;

export const UsageResetLedgerResult = Schema.Struct({
  createdAt: IsoDateTime,
  periods: Schema.Array(UsageResetPeriod),
  /**
   * Accounts read in the last sixty days. One that spent tokens without
   * closing a period still shared its provider's token counts. Absent from
   * servers older than this field.
   */
  openAccounts: Schema.optional(Schema.Array(UsageResetLedgerAccount)),
});
export type UsageResetLedgerResult = typeof UsageResetLedgerResult.Type;

export const USAGE_RESET_LEDGER_RPC_METHODS = {
  usageLimitsResets: "usageLimits.resets",
} as const;

export const usageResetLedgerRpcs = [
  Rpc.make(USAGE_RESET_LEDGER_RPC_METHODS.usageLimitsResets, {
    payload: UsageResetLedgerInput,
    success: UsageResetLedgerResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;
