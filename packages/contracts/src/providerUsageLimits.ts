import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * One rolling quota window a subscription provider reports for the signed-in
 * account, e.g. Claude's five-hour session or Codex's weekly allowance.
 *
 * `id` is stable per provider (`five_hour`, `seven_day_opus`, `primary`) so a
 * sparse turn-driven update lands on the same row a full probe produced.
 * `kind` only orders and labels the bar.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  /**
   * The model family this window limits (Claude's "Fable" weekly), on top of
   * the account-wide windows. Absent for windows that cap every model.
   */
  modelScope: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/**
 * Earned resets reported by the provider. A banked count is not restored
 * quota: consume an eligible credit, then refetch the provider snapshot.
 * Only present when the provider reports them at all.
 */
export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/**
 * Subscription usage the provider knows about the signed-in account.
 *
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 */
/** Native extra-credit observation. Availability is not spending consent. */
export const ServerProviderCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  // Native Codex reports more than eight fractional digits. Preserve its exact
  // decimal text while bounding both parts and excluding arbitrary strings.
  balance: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{1,24}(?:\.\d{1,24})?$/))),
  ),
});
export type ServerProviderCredits = typeof ServerProviderCredits.Type;

export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  /** Full native read only; sparse window updates never renew this proof. */
  nativeAllowanceObservedAt: Schema.optional(IsoDateTime),
  /** Main-bucket negative notification only; never grants or renews permission. */
  nativeDenialObservedAt: Schema.optional(IsoDateTime),
  /** Claude rejection persists through unsupported probes until a complete valid read. */
  nativeDenialRequiresFullRead: Schema.optional(Schema.Literal(true)),
  /** Credit-only withdrawal; does not revoke ordinary included usage. */
  nativeCreditDenialObservedAt: Schema.optional(IsoDateTime),
  ordinaryUsageAllowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  spendControlReached: Schema.optional(Schema.NullOr(Schema.Boolean)),
  rateLimitReachedType: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  credits: Schema.optional(Schema.NullOr(ServerProviderCredits)),
  /** SHA-256 of the supported native quota accountId, never a token/email. */
  quotaPoolId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^codex:sha256:[a-f0-9]{64}$/)),
  ),
  /** Turn notifications do not renew this independent identity observation. */
  quotaPoolObservedAt: Schema.optional(IsoDateTime),
  /** Supported config/read route observation; usage notifications never renew it. */
  nativeRouteVerified: Schema.optional(Schema.Boolean),
  nativeRouteObservedAt: Schema.optional(IsoDateTime),
  /** Opaque credential identity when the provider does not report an account. */
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  /** Provider-owned usage settings when quota windows are not available to the client. */
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      /** Malformed/incomplete evidence must survive cache and sparse updates. */
      invalidResponse: Schema.optional(Schema.Literal(true)),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * What an adapter reports when its runtime pushes a rate-limit update during
 * a turn. Sparse by contract: Claude's `rate_limit_event` names one window at
 * a time and Codex documents its notification as a partial. Windows merge by
 * `id` onto the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
  /** Sparse notifications may revoke prior permission, never restore it. */
  ordinaryUsageAllowed: Schema.optional(Schema.Literal(false)),
  /** Negative-only fence; an unsupported probe cannot clear this rejection. */
  nativeDenialRequiresFullRead: Schema.optional(Schema.Literal(true)),
  spendControlReached: Schema.optional(Schema.Literal(true)),
  /** Main credit/workspace/spend withdrawal only; sparse positives cannot clear it. */
  nativeCreditDenied: Schema.optional(Schema.Literal(true)),
  /** Explanation accompanying an explicit main-bucket denial. */
  rateLimitReachedType: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

/**
 * One account a usage-limit source reports on. `driver` is the provider the
 * account belongs to, for the icon and colour clients already have; the
 * account itself is not something this environment can run turns on.
 */
export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** The signed-in address, when the source names one; clients blur it like provider auth. */
  email: Schema.optional(TrimmedNonEmptyString),
  /** Plan as the matching provider would label it (`ChatGPT Pro 20x Subscription`). */
  plan: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

/**
 * The published state of one configured `usageLimitSources` entry. A source
 * that could not be read keeps `error` beside an empty account list rather
 * than vanishing, so the user can see it is configured but failing.
 */
export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

/**
 * A CLIProxyAPI found installed on the server's own machine. Detection reports
 * where it is and whether it answers; the management key never leaves the
 * server, which reads it itself when the hub is adopted.
 */
export const LocalUsageHubId = Schema.Literals(["specweave", "home", "homebrew"]);
export type LocalUsageHubId = typeof LocalUsageHubId.Type;
export const LocalUsageHub = Schema.Struct({
  /** The install layout it was found in; stable across calls. */
  id: LocalUsageHubId,
  url: Schema.String,
  configPath: Schema.String,
  running: Schema.Boolean,
  /** Whether the server can read the management key from the install itself. */
  keyAvailable: Schema.Boolean,
  /** The configured usage source that already points at this hub. */
  sourceId: Schema.NullOr(UsageLimitSourceId),
});
export type LocalUsageHub = typeof LocalUsageHub.Type;
export const LocalUsageHubsResult = Schema.Struct({ hubs: Schema.Array(LocalUsageHub) });
export type LocalUsageHubsResult = typeof LocalUsageHubsResult.Type;
export const LocalUsageHubAdoptInput = Schema.Struct({ id: LocalUsageHubId });
export type LocalUsageHubAdoptInput = typeof LocalUsageHubAdoptInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Mirrors Codex's own outcome set; other providers map onto it. */
export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  /** Redemption succeeded, but a follow-up such as clearing the hub cooldown failed. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/** A point-in-time view of one provider's limits, built for the /usage-limits panel. */
export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
