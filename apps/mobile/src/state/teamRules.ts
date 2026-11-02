import type {
  ModelSelection,
  OrchestrationV2ThreadOrigin,
  RuntimeMode,
  ServerConfig,
  TeamRulesCarried,
  TeamRulesSummary,
} from "@specweave-studio/contracts";
import {
  TEAM_RULES_NONE,
  teamRulesCarriedRefusal,
  teamRulesCeiling,
  teamRulesClampRoutineMode,
  teamRulesMachines,
  teamRulesModeLabel,
  teamRulesModeRefusal,
  teamRulesReachOff,
  teamRulesRoutineCeiling,
  teamRulesSetByLabel,
  teamRulesStateFromSummary,
  teamRulesToolOff,
  teamRulesTurnRefusal,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";

/** Answers who locked a permission mode; null when it can be picked. */
export type RuntimeModeLock = (mode: RuntimeMode) => string | null;

/** What rule checks need from a machine's config. Older servers leave the field out. */
type TeamRulesConfig = { readonly teamRules?: TeamRulesSummary | undefined } | null | undefined;

export const teamRulesStateOf = (config: TeamRulesConfig): TeamRulesState =>
  config?.teamRules === undefined ? TEAM_RULES_NONE : teamRulesStateFromSummary(config.teamRules);

/** The ceiling a thread brought from another machine, absent on every other thread. */
export function threadCarriedCeiling(
  thread: object | null | undefined,
): TeamRulesCarried | undefined {
  return (thread as { readonly origin?: OrchestrationV2ThreadOrigin } | null | undefined)?.origin
    ?.carried;
}

/** The lock for a thread's picker. Undefined when nothing limits it, so the picker is unchanged. */
export function threadRuntimeModeLock(
  config: TeamRulesConfig,
  thread: object | null | undefined,
): RuntimeModeLock | undefined {
  const state = teamRulesStateOf(config);
  const carried = threadCarriedCeiling(thread);
  if (teamRulesCeiling(state) === undefined && carried === undefined) return undefined;
  return (mode) => {
    const refused = teamRulesModeRefusal(state, mode) ?? teamRulesCarriedRefusal(carried, mode);
    return refused === null ? null : teamRulesSetByLabel(refused.owner);
  };
}

/** The lock for a routine's picker: the tighter of the ceiling and the routine limit. */
export function routineRuntimeModeLock(config: TeamRulesConfig): RuntimeModeLock | undefined {
  const state = teamRulesStateOf(config);
  if (teamRulesRoutineCeiling(state) === undefined) return undefined;
  return (mode) =>
    teamRulesClampRoutineMode(state, mode) === mode
      ? null
      : teamRulesSetByLabel(config?.teamRules?.owner);
}

/** The lock for a default that several selected machines share: any machine's limit counts. */
export function sharedRuntimeModeLock(
  configs: ReadonlyArray<TeamRulesConfig>,
): RuntimeModeLock | undefined {
  const locks = configs.flatMap((config) => threadRuntimeModeLock(config, null) ?? []);
  if (locks.length === 0) return undefined;
  return (mode) => {
    for (const lock of locks) {
      const lockedBy = lock(mode);
      if (lockedBy !== null) return lockedBy;
    }
    return null;
  };
}

/** Why a turn cannot start, judged before anything is sent; null when it can. */
export function queuedTurnTeamRulesRefusal(
  config: Pick<ServerConfig, "providers" | "settings" | "teamRules">,
  thread: object | null,
  settings: { readonly runtimeMode: RuntimeMode; readonly modelSelection: ModelSelection },
): string | null {
  const { instanceId, model } = settings.modelSelection;
  const driver =
    config.providers.find((provider) => provider.instanceId === instanceId)?.driver ??
    config.settings?.providerInstances[instanceId]?.driver ??
    instanceId;
  return (
    teamRulesTurnRefusal(teamRulesStateOf(config), {
      runtimeMode: settings.runtimeMode,
      driver,
      model,
      carried: threadCarriedCeiling(thread),
    })?.message ?? null
  );
}

/** A routine failure's text: the server's sentence on a machine with rules, as before otherwise. */
export function routineFailureText(config: TeamRulesConfig, failure: unknown): string {
  return config?.teamRules !== undefined && failure instanceof Error
    ? failure.message
    : String(failure);
}

/** The note beside Agent browser access. Preview stays available when Chrome is turned off. */
export function chromeOffNote(configs: ReadonlyArray<TeamRulesConfig>): string | null {
  const off = configs.find((config) => teamRulesToolOff(teamRulesStateOf(config), "chrome"));
  return off === undefined
    ? null
    : `Agent use of Chrome is off. ${teamRulesSetByLabel(off?.teamRules?.owner)}.`;
}

export type TeamRulesRow = { readonly title: string; readonly value: string };

const listed = (values: ReadonlyArray<string> | undefined) =>
  values === undefined ? null : values.length === 0 ? "None" : values.join(", ");

const MACHINE_RULE_LABELS = { none: "Off", "same-rules": "Only machines with the same rules" };

/** The rows the Team rules section shows, each only when the rules set it. */
export function teamRulesRows(summary: TeamRulesSummary): ReadonlyArray<TeamRulesRow> {
  const state = teamRulesStateFromSummary(summary);
  const ceiling = teamRulesCeiling(state);
  const routines = teamRulesRoutineCeiling(state);
  const providers = listed(summary.providers);
  const models = listed(summary.models);
  const machines = teamRulesMachines(state);
  const off = (title: string, isOff: boolean) => (isOff ? [{ title, value: "Off" }] : []);
  return [
    ...(ceiling === undefined
      ? []
      : [{ title: "Broadest permission", value: teamRulesModeLabel(ceiling) }]),
    ...(routines === undefined ? [] : [{ title: "Routines", value: teamRulesModeLabel(routines) }]),
    ...(providers === null ? [] : [{ title: "Approved providers", value: providers }]),
    ...(models === null
      ? []
      : [
          {
            title: "Approved models",
            value: `${models}. Fallback at a usage limit stays inside this list.`,
          },
        ]),
    ...(summary.ownsProviderLaunch === true || (summary.pinnedProviders?.length ?? 0) > 0
      ? [
          {
            title: "Provider launch",
            value: "Launch arguments, environment and binary path come from the rules.",
          },
        ]
      : []),
    ...off("Telemetry export", summary.telemetryExport === false),
    ...off("Phones", teamRulesReachOff(state, "phones")),
    ...off("SpecWithCode Connect", teamRulesReachOff(state, "connect")),
    ...(machines === "any"
      ? []
      : [{ title: "Other machines", value: MACHINE_RULE_LABELS[machines] }]),
    ...off("Webhooks", teamRulesReachOff(state, "webhooks")),
    ...off("Agent use of Chrome", teamRulesToolOff(state, "chrome")),
    ...off("Agent use of this computer", teamRulesToolOff(state, "computerUse")),
    ...off("Google accounts", teamRulesToolOff(state, "google")),
    ...off("Telegram", teamRulesToolOff(state, "telegram")),
  ];
}
