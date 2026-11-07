/**
 * Team rules: limits a company sets for everyone using the app on a machine.
 *
 * Capabilities, not settings paths, so a rename inside the app never silently
 * unlocks a rule. A repository or a zone can only add to these limits.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const TEAM_RULES_VERSION = 1;
export const TEAM_RULES_FILE_NAME = "team-rules.json";
export const TEAM_RULES_MAX_BYTES = 256 * 1024;
/** Where a repository commits its rules, read from the default branch and never the working tree. */
export const TEAM_RULES_REPOSITORY_PATH = `.specwithcode/${TEAM_RULES_FILE_NAME}`;

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

export const TeamRulesMachines = Schema.Literals(["any", "same-rules", "none"]);
export type TeamRulesMachines = typeof TeamRulesMachines.Type;

/** What may reach this machine, and what it may reach. False or `none` turns a path off. */
export const TeamRulesReach = Schema.Struct({
  phones: Schema.optionalKey(Schema.Boolean),
  connect: Schema.optionalKey(Schema.Boolean),
  machines: Schema.optionalKey(TeamRulesMachines),
  webhooks: Schema.optionalKey(Schema.Boolean),
});
export type TeamRulesReach = typeof TeamRulesReach.Type;

/** Tools agents may drive. False stops the tool here, whoever asks. */
export const TeamRulesTools = Schema.Struct({
  chrome: Schema.optionalKey(Schema.Boolean),
  computerUse: Schema.optionalKey(Schema.Boolean),
  google: Schema.optionalKey(Schema.Boolean),
  telegram: Schema.optionalKey(Schema.Boolean),
});
export type TeamRulesTools = typeof TeamRulesTools.Type;

export const TeamRulesConnections = Schema.Struct({
  /** Connection names that may be used; `*` matches any text. Absent: any connection. */
  allow: Schema.optionalKey(Schema.Array(RuleText)),
});
export type TeamRulesConnections = typeof TeamRulesConnections.Type;

export const TeamRulesUpdates = Schema.Struct({
  /** False stops automatic checks and downloads; true keeps them on. Either locks the preference. */
  automatic: Schema.optionalKey(Schema.Boolean),
  /** The company's own feed. The app stops using the public feed and names this one. */
  feed: Schema.optionalKey(RuleText),
});
export type TeamRulesUpdates = typeof TeamRulesUpdates.Type;

/** What a zone or repository may limit. No pin: one instance launches for every folder. */
export const TeamRulesScopedAi = Schema.Struct({
  providers: Schema.optionalKey(Schema.Array(ProviderName)),
  models: Schema.optionalKey(Schema.Array(RuleText)),
});
export type TeamRulesScopedAi = typeof TeamRulesScopedAi.Type;

export const TeamRulesZone = Schema.Struct({
  /** A Git remote without its scheme or user, such as `github.com/acme/payments*`. */
  remote: RuleText,
  agents: Schema.optionalKey(TeamRulesAgents),
  ai: Schema.optionalKey(TeamRulesScopedAi),
  connections: Schema.optionalKey(TeamRulesConnections),
});
export type TeamRulesZone = typeof TeamRulesZone.Type;

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

/**
 * A repository's committed rules: a team agreement, not a security boundary, so
 * it limits work in that repository and nothing about the machine.
 */
export const TeamRulesRepositoryFile = Schema.Struct({
  version: Schema.Literal(TEAM_RULES_VERSION),
  owner: RuleText,
  contact: Schema.optionalKey(RuleText),
  agents: Schema.optionalKey(TeamRulesAgents),
  ai: Schema.optionalKey(TeamRulesScopedAi),
  connections: Schema.optionalKey(TeamRulesConnections),
});
export type TeamRulesRepositoryFile = typeof TeamRulesRepositoryFile.Type;

/** A source that adds limits for one working folder, as clients name it. */
export const TeamRulesSource = Schema.Struct({
  source: Schema.Literals(["zone", "repository"]),
  owner: Schema.String,
  contact: Schema.optionalKey(Schema.String),
});
export type TeamRulesSource = typeof TeamRulesSource.Type;

/** What clients need to explain and lock a control. Holds no pinned values. */
export const TeamRulesSummary = Schema.Struct({
  status: Schema.Literals(["active", "hold"]),
  /** Who set the rules; absent when a broken file does not say. */
  owner: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(Schema.String),
  fingerprint: Schema.optionalKey(Schema.String),
  ceiling: Schema.optionalKey(RuntimeMode),
  /** The zone or repository that set the ceiling, when the machine's rules did not. */
  ceilingBy: Schema.optionalKey(TeamRulesSource),
  routinesCeiling: Schema.optionalKey(RuntimeMode),
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  pinnedProviders: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Launch args, environment and binary path come from the rules. */
  ownsProviderLaunch: Schema.optionalKey(Schema.Boolean),
  telemetryExport: Schema.optionalKey(Schema.Boolean),
  reach: Schema.optionalKey(TeamRulesReach),
  tools: Schema.optionalKey(TeamRulesTools),
  connections: Schema.optionalKey(Schema.Array(Schema.String)),
  updates: Schema.optionalKey(TeamRulesUpdates),
  /** Further lists a model or connection must also fit, for one working folder. */
  modelLists: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
  connectionLists: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
  /** The zones and repository adding limits for one working folder. */
  sources: Schema.optionalKey(Schema.Array(TeamRulesSource)),
  /** Why the rules are on hold. */
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Set when only one working folder is on hold, not the machine. */
  holdScope: Schema.optionalKey(Schema.Literals(["zone", "repository"])),
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
  "reach",
  "machines",
  "tools",
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

/**
 * The ceiling a thread brought from another machine. The machine doing the work
 * enforces the stricter of its own and this one, even with no rules of its own.
 */
export const TeamRulesCarried = Schema.Struct({
  ceiling: RuntimeMode,
  /** Who set it, for the refusal's wording. */
  owner: RuleText,
  contact: Schema.optional(RuleText),
  /** The machine whose rules set it. Back there, its live rules apply instead. */
  from: EnvironmentId,
});
export type TeamRulesCarried = typeof TeamRulesCarried.Type;

/** A machine's rules as other machines read them, from its environment descriptor. */
export const TeamRulesPeerRules = Schema.Struct({
  status: Schema.Literals(["active", "hold"]),
  fingerprint: Schema.optionalKey(Schema.String),
});
export type TeamRulesPeerRules = typeof TeamRulesPeerRules.Type;

/** The header a machine names its rules with on a call to another machine. */
export const TEAM_RULES_FINGERPRINT_HEADER = "x-specwithcode-team-rules";

/** On a machine's refusal, so the caller reads it as a rule rather than a dead credential. */
export const TEAM_RULES_REFUSED_HEADER = "x-specwithcode-team-rules-refused";
