/**
 * Team rules: limits a company sets for everyone using the app on a machine.
 *
 * Capabilities, not settings paths, so a rename inside the app never silently
 * unlocks a rule. `reach`, `tools`, `connections`, `updates` and `zones` are
 * validated now and enforced by later releases; `rules show` says which.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const TEAM_RULES_VERSION = 1;
export const TEAM_RULES_FILE_NAME = "team-rules.json";
export const TEAM_RULES_MAX_BYTES = 256 * 1024;

const RuleText = TrimmedNonEmptyString;
const ProviderName = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/));
const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));

export const TeamRulesProviderPin = Schema.Struct({
  environment: Schema.optionalKey(Schema.Record(EnvironmentName, Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
  binaryPath: Schema.optionalKey(RuleText),
});
export type TeamRulesProviderPin = typeof TeamRulesProviderPin.Type;

export const TeamRulesAi = Schema.Struct({
  /** Provider drivers that may run. Absent: any driver. */
  providers: Schema.optionalKey(Schema.Array(ProviderName)),
  /** Model patterns that may run; `*` matches any text. Absent: any model. */
  models: Schema.optionalKey(Schema.Array(RuleText)),
  /** What a driver launches with. Rules own these values for a pinned driver. */
  pin: Schema.optionalKey(Schema.Record(ProviderName, TeamRulesProviderPin)),
});
export type TeamRulesAi = typeof TeamRulesAi.Type;

export const TeamRulesAgents = Schema.Struct({
  /** The broadest permission anyone on this machine may run with. */
  ceiling: Schema.optionalKey(RuntimeMode),
  /** The broadest permission a routine may run with, inside the ceiling. */
  routines: Schema.optionalKey(RuntimeMode),
});
export type TeamRulesAgents = typeof TeamRulesAgents.Type;

export const TeamRulesTelemetry = Schema.Struct({
  /** False stops the app exporting traces, metrics and logs to any OTLP URL. */
  export: Schema.optionalKey(Schema.Boolean),
});

export const TeamRulesReach = Schema.Struct({
  phones: Schema.optionalKey(Schema.Boolean),
  connect: Schema.optionalKey(Schema.Boolean),
  machines: Schema.optionalKey(Schema.Literals(["any", "same-rules", "none"])),
  webhooks: Schema.optionalKey(Schema.Boolean),
});

export const TeamRulesTools = Schema.Struct({
  chrome: Schema.optionalKey(Schema.Boolean),
  computerUse: Schema.optionalKey(Schema.Boolean),
  google: Schema.optionalKey(Schema.Boolean),
  telegram: Schema.optionalKey(Schema.Boolean),
});

export const TeamRulesConnections = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(RuleText)),
});

export const TeamRulesUpdates = Schema.Struct({
  automatic: Schema.optionalKey(Schema.Boolean),
  feed: Schema.optionalKey(RuleText),
});

export const TeamRulesZone = Schema.Struct({
  remote: RuleText,
  agents: Schema.optionalKey(TeamRulesAgents),
  ai: Schema.optionalKey(TeamRulesAi),
});

export const TeamRulesFile = Schema.Struct({
  version: Schema.Literal(TEAM_RULES_VERSION),
  owner: RuleText,
  contact: Schema.optionalKey(RuleText),
  ai: Schema.optionalKey(TeamRulesAi),
  agents: Schema.optionalKey(TeamRulesAgents),
  telemetry: Schema.optionalKey(TeamRulesTelemetry),
  reach: Schema.optionalKey(TeamRulesReach),
  tools: Schema.optionalKey(TeamRulesTools),
  connections: Schema.optionalKey(TeamRulesConnections),
  updates: Schema.optionalKey(TeamRulesUpdates),
  zones: Schema.optionalKey(Schema.Array(TeamRulesZone)),
});
export type TeamRulesFile = typeof TeamRulesFile.Type;

/** What clients need to explain and lock a control. Holds no pinned values. */
export const TeamRulesSummary = Schema.Struct({
  status: Schema.Literals(["active", "hold"]),
  /** Who set the rules; absent when a broken file does not say. */
  owner: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(Schema.String),
  fingerprint: Schema.optionalKey(Schema.String),
  ceiling: Schema.optionalKey(RuntimeMode),
  routinesCeiling: Schema.optionalKey(RuntimeMode),
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  pinnedProviders: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Launch args, environment and binary path come from the rules. */
  ownsProviderLaunch: Schema.optionalKey(Schema.Boolean),
  telemetryExport: Schema.optionalKey(Schema.Boolean),
  /** Why the rules are on hold. */
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type TeamRulesSummary = typeof TeamRulesSummary.Type;

export const TeamRulesRefusalReason = Schema.Literals([
  "hold",
  "ceiling",
  "routine-ceiling",
  "provider",
  "model",
  "provider-launch",
  "telemetry",
]);
export type TeamRulesRefusalReason = typeof TeamRulesRefusalReason.Type;

export const TeamRulesRefusal = Schema.Struct({
  reason: TeamRulesRefusalReason,
  message: Schema.String,
  owner: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(Schema.String),
  /** The broadest mode allowed, when the refusal is about a mode. */
  allowedMode: Schema.optionalKey(RuntimeMode),
});
export type TeamRulesRefusal = typeof TeamRulesRefusal.Type;
