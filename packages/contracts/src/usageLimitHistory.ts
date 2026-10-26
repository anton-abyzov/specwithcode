/**
 * Recorded subscription quota: how each account's windows moved over time, so
 * clients can measure burn and project when an account, or a pool of them,
 * runs out. Each environment records what it can read itself (its own signed-in
 * instances and the hubs it polls); clients merge environments by account key.
 *
 * @module usageLimitHistory
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

/** One read of one window, stamped with the time the provider was read, not when it was stored. */
export const UsageLimitHistorySample = Schema.Struct({
  at: IsoDateTime,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
});
export type UsageLimitHistorySample = typeof UsageLimitHistorySample.Type;

/**
 * Every recorded read of one window of one account. `accountKey` is the same
 * key the pooled views use (`<driver>:<email>` or `<driver>:credential:<hash>`),
 * so a series lines up with its account on every machine.
 */
export const UsageLimitHistorySeries = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  windowId: TrimmedNonEmptyString,
  windowKind: ServerProviderUsageWindow.fields.kind,
  windowDurationMins: Schema.optional(NonNegativeInt),
  samples: Schema.Array(UsageLimitHistorySample),
});
export type UsageLimitHistorySeries = typeof UsageLimitHistorySeries.Type;

/** At most fourteen days are kept, so a longer range returns the same. */
export const UsageLimitHistoryInput = Schema.Struct({
  sinceHours: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 336 }))),
});
export type UsageLimitHistoryInput = typeof UsageLimitHistoryInput.Type;

export const UsageLimitHistoryResult = Schema.Struct({
  createdAt: IsoDateTime,
  series: Schema.Array(UsageLimitHistorySeries),
});
export type UsageLimitHistoryResult = typeof UsageLimitHistoryResult.Type;

export const USAGE_LIMIT_HISTORY_RPC_METHODS = {
  usageLimitsHistory: "usageLimits.history",
} as const;

export const usageLimitHistoryRpcs = [
  Rpc.make(USAGE_LIMIT_HISTORY_RPC_METHODS.usageLimitsHistory, {
    payload: UsageLimitHistoryInput,
    success: UsageLimitHistoryResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;
