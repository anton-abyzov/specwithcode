import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderCredits } from "./providerUsageLimits.ts";

export const StudioCapacityProvider = Schema.Literals(["codex", "claude"]);
export type StudioCapacityProvider = typeof StudioCapacityProvider.Type;
export const StudioCapacityMode = Schema.Literals(["balanced", "reset-first", "spend-first"]);
export type StudioCapacityMode = typeof StudioCapacityMode.Type;
export const StudioCapacityAccountId = Schema.Literals([
  "codex-1", "codex-2", "codex-3", "codex-4", "claude-1", "claude-2", "claude-3",
]);
export type StudioCapacityAccountId = typeof StudioCapacityAccountId.Type;
export const StudioCapacityWindow = Schema.Struct({
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  windowDurationMins: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  resetsAt: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
});
export const StudioCapacityQuotaWindow = Schema.Struct({
  ...StudioCapacityWindow.fields,
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_:-]{1,100}$/)),
  bucketId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
  appliesToSelection: Schema.Boolean,
  observedAt: Schema.optionalKey(IsoDateTime),
});
export const StudioCapacityAccount = Schema.Struct({
  id: StudioCapacityAccountId,
  provider: StudioCapacityProvider,
  label: Schema.String,
  authenticated: Schema.NullOr(Schema.Boolean),
  status: Schema.Literals(["ready", "active", "auth-required", "unknown", "stale", "exhausted", "blocked"]),
  authError: Schema.NullOr(Schema.Literals([
    "subscription-auth-unverified", "profile-isolation-unverified", "native-auth-unverified",
    "api-auth-not-subscription", "provider-instance-unavailable",
  ])),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  /** A supported native account hash, never a credential/token/email fingerprint. */
  quotaPoolId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^codex:sha256:[a-f0-9]{64}$/))),
  /** Independent of quota observations: turn updates cannot renew identity. */
  quotaPoolObservedAt: Schema.NullOr(IsoDateTime),
  quota: Schema.Struct({
    window: Schema.NullOr(StudioCapacityWindow),
    weekly: Schema.NullOr(StudioCapacityWindow),
    windows: Schema.optionalKey(Schema.Array(StudioCapacityQuotaWindow).check(Schema.isMaxLength(32))),
    ordinaryUsageAllowed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    spendControlReached: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    rateLimitReachedType: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z_]{1,80}$/)))),
    credits: Schema.optionalKey(Schema.NullOr(ServerProviderCredits)),
    resetCredits: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      availableCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1000000 })),
      nextExpiresAt: Schema.optionalKey(IsoDateTime),
    }))),
    observedAt: Schema.NullOr(IsoDateTime),
    expiresAt: Schema.NullOr(IsoDateTime),
    source: Schema.NullOr(Schema.Literals(["native-app-server", "manual"])),
    freshness: Schema.Literals(["fresh", "stale", "unknown"]),
  }),
});
export type StudioCapacityAccount = typeof StudioCapacityAccount.Type;
export const StudioCapacityPolicy = Schema.Struct({
  mode: StudioCapacityMode,
  preferredProvider: Schema.NullOr(StudioCapacityProvider),
  selectedAccount: Schema.NullOr(StudioCapacityAccountId),
});
export type StudioCapacityPolicy = typeof StudioCapacityPolicy.Type;
export const StudioCapacitySnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** Retrieval time; does not imply that quota or auth was refreshed. */
  observedAt: IsoDateTime,
  source: Schema.Literal("specweave-switch"),
  scope: Schema.Literal("environment-local"),
  available: Schema.Boolean,
  error: Schema.NullOr(Schema.Literals(["switch-unavailable", "switch-timeout", "switch-invalid-response"])),
  quotaPoolIdentity: Schema.Literals(["unavailable", "partial", "available"]),
  /** Counts only fresh verified hashes. Partial coverage is not a subscription total. */
  verifiedQuotaPoolCount: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  accounts: Schema.Array(StudioCapacityAccount),
  policy: Schema.NullOr(StudioCapacityPolicy),
  recommendations: Schema.Array(Schema.Struct({
    provider: Schema.Literals(["any", "codex", "claude"]),
    id: Schema.NullOr(StudioCapacityAccountId),
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    reason: Schema.String,
  })),
});
export type StudioCapacitySnapshot = typeof StudioCapacitySnapshot.Type;
// An empty Struct is optimized to accept any object; a Never-valued record
// rejects every supplied key before the HTTP decoder can discard it.
export const StudioCapacityRefreshInput = Schema.Record(Schema.String, Schema.Never);
export const StudioCapacityPolicyInput = Schema.StructWithRest(Schema.Struct({
  mode: StudioCapacityMode,
  preferredProvider: Schema.optionalKey(Schema.NullOr(StudioCapacityProvider)),
}), [Schema.Record(Schema.String, Schema.Unknown)]).check(Schema.makeFilter((input) =>
  Object.keys(input).every((key) => key === "mode" || key === "preferredProvider"), { message: "Unexpected capacity policy field." }));
export type StudioCapacityPolicyInput = typeof StudioCapacityPolicyInput.Type;
export const StudioCapacitySelectInput = Schema.StructWithRest(Schema.Struct({ id: Schema.NullOr(StudioCapacityAccountId) }),
  [Schema.Record(Schema.String, Schema.Unknown)]).check(Schema.makeFilter((input) =>
    Object.keys(input).every((key) => key === "id"), { message: "Unexpected capacity selection field." }));
export type StudioCapacitySelectInput = typeof StudioCapacitySelectInput.Type;
