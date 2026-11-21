/**
 * What one machine recorded per subscription account: tokens, API-equivalent
 * cost and requests by day, model, project and origin. Clients ask every
 * machine they reach and merge by account key, which answers "which machine
 * used this subscription" and, set against the provider's own percent, how
 * much was used on no reporting machine at all.
 *
 * Providers that keep local transcripts (Claude, Codex, Grok) are read from
 * them, so sessions run outside SpecWithCode on the machine are included and
 * marked `native`. Providers that keep none (Copilot and other ACP agents) are
 * read from the turns SpecWithCode recorded.
 *
 * @module usageMachineReport
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { UsageDay, UsageReadError } from "./usage.ts";

/** Bumped when {@link UsageMachineReport} changes incompatibly. */
export const USAGE_MACHINE_REPORT_VERSION = 1 as const;

/** The hourly series reaches this far back: as long as limit history is kept. */
export const USAGE_MACHINE_REPORT_HOURLY_DAYS = 14 as const;

/** Longest range one request may ask for. */
export const USAGE_MACHINE_REPORT_MAX_DAYS = 92 as const;

/**
 * `app`: a SpecWithCode thread owns the session. `native`: a session on this
 * machine that no thread owns, such as the CLI in a terminal.
 */
export const UsageMachineOrigin = Schema.Literals(["app", "native"]);
export type UsageMachineOrigin = typeof UsageMachineOrigin.Type;

/**
 * How a session's account was named, weakest last:
 * - `recorded`: the account this machine saw signed in on that provider
 *   instance at that time;
 * - `history`: the nearest limit reading of the driver's only instance, for
 *   time before spans were recorded;
 * - `current`: the account signed in now;
 * - `unknown`: no account could be named.
 */
export const UsageAccountIdentityRule = Schema.Literals([
  "recorded",
  "history",
  "current",
  "unknown",
]);
export type UsageAccountIdentityRule = typeof UsageAccountIdentityRule.Type;

export const UsageMachineAccount = Schema.Struct({
  /** The Limits views' key where one exists (`<driver>:<email>`); see `usageAccountKey`. */
  accountKey: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** The provider instance's name, for an account no limits read names. */
  label: Schema.optional(TrimmedNonEmptyString),
  /** The weakest rule that named any of this account's cells. */
  identity: UsageAccountIdentityRule,
  /** An instance on this machine is signed in to it now. */
  signedIn: Schema.Boolean,
});
export type UsageMachineAccount = typeof UsageMachineAccount.Type;

/**
 * One transcript folder, named so two environments that read the same folder
 * count it once (`hostId`, provider, path and `device:inode`, joined).
 */
export const UsageMachineSource = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
});
export type UsageMachineSource = typeof UsageMachineSource.Type;

export const UsageMachineProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type UsageMachineProject = typeof UsageMachineProject.Type;

/**
 * One `(day, account, model, origin, project, source)` cell. `costUsd` is the
 * API-equivalent value of the tokens, not money spent. `requests` counts
 * assistant responses for transcript providers and turns for the others.
 */
export const UsageMachineCell = Schema.Struct({
  day: UsageDay,
  accountKey: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  origin: UsageMachineOrigin,
  /** The owning thread's project; absent for `native` and for chats without one. */
  projectId: Schema.optional(TrimmedNonEmptyString),
  /** Index into `sources`; absent for turns read from SpecWithCode's own records. */
  source: Schema.optional(NonNegativeInt),
  tokens: NonNegativeInt,
  costUsd: Schema.Number,
  requests: NonNegativeInt,
  /** Requests whose tokens count but for which no price is known. */
  unpricedRequests: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type UsageMachineCell = typeof UsageMachineCell.Type;

/**
 * One hour of one account and origin: for calibrating cost against the limit
 * percent, and for cutting a day at the instant a period starts inside it.
 */
export const UsageMachineHour = Schema.Struct({
  /** UTC start of the hour, epoch milliseconds. */
  hourStartMs: Schema.Number,
  accountKey: TrimmedNonEmptyString,
  /** Absent only from a report kept from before hours were split by origin. */
  origin: Schema.optional(UsageMachineOrigin),
  source: Schema.optional(NonNegativeInt),
  tokens: NonNegativeInt,
  costUsd: Schema.Number,
  requests: NonNegativeInt,
});
export type UsageMachineHour = typeof UsageMachineHour.Type;

export const UsageMachineReportInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA zone days are bucketed in. */
  timeZone: TrimmedNonEmptyString,
});
export type UsageMachineReportInput = typeof UsageMachineReportInput.Type;

export const UsageMachineReport = Schema.Struct({
  version: Schema.Number,
  readAt: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  accounts: Schema.Array(UsageMachineAccount),
  sources: Schema.Array(UsageMachineSource),
  projects: Schema.Array(UsageMachineProject),
  cells: Schema.Array(UsageMachineCell),
  /** Covers the last {@link USAGE_MACHINE_REPORT_HOURLY_DAYS} days, whatever the range. */
  hourly: Schema.Array(UsageMachineHour),
  /** First instant `hourly` covers, epoch milliseconds. */
  hourlySinceMs: Schema.Number,
});
export type UsageMachineReport = typeof UsageMachineReport.Type;

export const USAGE_MACHINE_REPORT_RPC_METHODS = {
  usageMachineReport: "usage.machineReport",
} as const;

export const usageMachineReportRpcs = [
  Rpc.make(USAGE_MACHINE_REPORT_RPC_METHODS.usageMachineReport, {
    payload: UsageMachineReportInput,
    success: UsageMachineReport,
    error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
  }),
] as const;
