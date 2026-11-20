/**
 * Team usage (0898): the daily usage summary an opted-in machine sends to its
 * team, and the settings that decide whether, where and under which labels.
 *
 * The summary is a privacy boundary. It carries only provider, the member's
 * own account label, plan tier, window remaining, reset times, limit-hit,
 * handoff and provider-switch counts, the machine label and a timestamp. No
 * email, account key, subscription hash, credential fingerprint, thread,
 * message, run, project, path or prompt leaves the machine.
 * `TEAM_USAGE_SUMMARY_KEYS` is the allowlist the sender and its test check
 * every outgoing body against, recursively.
 *
 * @module teamUsage
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const TeamUsageWindow = Schema.Struct({
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  /** Newest read. */
  remainingPercent: Percent,
  /** The lowest remaining read during the summary's UTC day. */
  lowestRemainingPercent: Percent,
  resetsAt: Schema.optional(IsoDateTime),
});
export type TeamUsageWindow = typeof TeamUsageWindow.Type;

export const TeamUsageAccount = Schema.Struct({
  provider: ProviderDriverKind,
  /** The member's own name for this account; never an email or account id. */
  accountLabel: Label,
  /** The plan as the provider names it ("Max 20x"), when it says. */
  planTier: Schema.optional(Label),
  /** Empty when this machine has no usage reading: "usage not readable yet". */
  windows: Schema.Array(TeamUsageWindow),
  limitHits: NonNegativeInt,
  handoffs: NonNegativeInt,
  providerSwitches: NonNegativeInt,
});
export type TeamUsageAccount = typeof TeamUsageAccount.Type;

export const TeamUsageSummary = Schema.Struct({
  machineLabel: Label,
  /** When the summary was made; its UTC date is the day it covers. */
  at: IsoDateTime,
  accounts: Schema.Array(TeamUsageAccount),
});
export type TeamUsageSummary = typeof TeamUsageSummary.Type;

/**
 * Every key a summary may carry, per level. Nothing outside these lists is
 * ever sent; the sender refuses a body that has one.
 */
export const TEAM_USAGE_SUMMARY_KEYS = {
  summary: ["machineLabel", "at", "accounts"],
  account: [
    "provider",
    "accountLabel",
    "planTier",
    "windows",
    "limitHits",
    "handoffs",
    "providerSwitches",
  ],
  window: ["kind", "remainingPercent", "lowestRemainingPercent", "resetsAt"],
} as const;

/** Keys in `value` (recursively) that the summary allowlist does not name. */
export function teamUsageSummaryExtraKeys(value: unknown): string[] {
  const extra: string[] = [];
  const check = (node: unknown, allowed: readonly string[], at: string) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      extra.push(`${at}:not-an-object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) extra.push(at === "" ? key : `${at}.${key}`);
    }
  };
  check(value, TEAM_USAGE_SUMMARY_KEYS.summary, "");
  const accounts = (value as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts)) return extra;
  accounts.forEach((account, index) => {
    const at = `accounts[${index}]`;
    check(account, TEAM_USAGE_SUMMARY_KEYS.account, at);
    const windows = (account as { windows?: unknown } | null)?.windows;
    if (!Array.isArray(windows)) return;
    windows.forEach((window, windowIndex) =>
      check(window, TEAM_USAGE_SUMMARY_KEYS.window, `${at}.windows[${windowIndex}]`),
    );
  });
  return extra;
}

/** The hosted team view on verified-skill.com. */
export const TEAM_USAGE_HOSTED_ORIGIN = "https://verified-skill.com";

/** Hosted (a verified-skill.com tenant) or a self-hosted HTTPS endpoint. */
export const TeamUsageEndpoint = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hosted"),
    tenantId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    /** The org as the member picked it, for display. */
    orgLabel: Schema.optional(Label),
  }),
  Schema.Struct({
    kind: Schema.Literal("selfHosted"),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048), Schema.isPattern(/^https:\/\//)),
  }),
]);
export type TeamUsageEndpoint = typeof TeamUsageEndpoint.Type;

export const TeamUsageConfig = Schema.Struct({
  enabled: Schema.Boolean,
  endpoint: Schema.optional(TeamUsageEndpoint),
  machineLabel: Schema.optional(Label),
  /** The member's label per provider instance; absent ones use the instance's name. */
  accountLabels: Schema.optional(Schema.Record(ProviderInstanceId, Label)),
});
export type TeamUsageConfig = typeof TeamUsageConfig.Type;

export const TeamUsageStatus = Schema.Struct({
  config: TeamUsageConfig,
  /** A self-hosted credential is stored; the value never leaves the server. */
  selfHostedCredentialSet: Schema.Boolean,
  /** The member's `vsk_` sign-in was found; false asks for `vskill auth login`. */
  hostedSignedIn: Schema.optional(Schema.Boolean),
  lastSentAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(TrimmedNonEmptyString),
  /** A machine label whose history removal the team has not confirmed yet. */
  removalPending: Schema.optional(Label),
  /** Exactly what the next send would carry. */
  preview: TeamUsageSummary,
});
export type TeamUsageStatus = typeof TeamUsageStatus.Type;

export const TeamUsageUpdateInput = Schema.Struct({
  config: TeamUsageConfig,
  /** Write-only: a new bearer credential for a self-hosted endpoint. */
  selfHostedCredential: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
});
export type TeamUsageUpdateInput = typeof TeamUsageUpdateInput.Type;

export const TeamUsageOrg = Schema.Struct({
  tenantId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type TeamUsageOrg = typeof TeamUsageOrg.Type;

export const TeamUsageOrgsResult = Schema.Struct({
  orgs: Schema.Array(TeamUsageOrg),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type TeamUsageOrgsResult = typeof TeamUsageOrgsResult.Type;

export class TeamUsageError extends Schema.TaggedError<TeamUsageError>()("TeamUsageError", {
  message: Schema.String,
}) {}

export const TEAM_USAGE_RPC_METHODS = {
  teamUsageStatus: "teamUsage.status",
  teamUsageUpdate: "teamUsage.update",
  teamUsageOrgs: "teamUsage.orgs",
} as const;

export const teamUsageRpcs = [
  Rpc.make(TEAM_USAGE_RPC_METHODS.teamUsageStatus, {
    payload: Schema.Struct({}),
    success: TeamUsageStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(TEAM_USAGE_RPC_METHODS.teamUsageUpdate, {
    payload: TeamUsageUpdateInput,
    success: TeamUsageStatus,
    error: Schema.Union([EnvironmentAuthorizationError, TeamUsageError]),
  }),
  Rpc.make(TEAM_USAGE_RPC_METHODS.teamUsageOrgs, {
    payload: Schema.Struct({}),
    success: TeamUsageOrgsResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;
