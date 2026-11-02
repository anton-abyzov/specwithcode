import type { RuntimeMode, TeamRulesSummary } from "@specweave-studio/contracts";
import {
  TEAM_RULES_NONE,
  teamRulesCeiling,
  teamRulesClampMode,
  teamRulesModeAllowed,
  teamRulesModeLabel,
  teamRulesModelAllowed,
  teamRulesProviderAllowed,
  teamRulesRoutineCeiling,
  teamRulesSetByLabel,
  teamRulesStateFromSummary,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";

export const TEAM_RULES_ABOVE_LIMIT = "Above your team's limit";

/** What every lock needs from a machine's summary. No summary reads as no rules. */
export const teamRulesFromSummary = (summary: TeamRulesSummary | undefined) => ({
  summary,
  state: summary === undefined ? TEAM_RULES_NONE : teamRulesStateFromSummary(summary),
  setBy: teamRulesSetByLabel(summary?.owner),
});

/** Who to name on a lock, or null when the rules do not touch this provider's launch. */
export function teamRulesProviderLock(
  summary: TeamRulesSummary | undefined,
  driver: string,
): string | null {
  if (summary?.status !== "active") return null;
  const state = teamRulesStateFromSummary(summary);
  return summary.ownsProviderLaunch === true ||
    summary.pinnedProviders?.includes(driver) === true ||
    !teamRulesProviderAllowed(state, driver)
    ? teamRulesSetByLabel(summary.owner)
    : null;
}

/** The lock on a decision model, whose hosted router is a provider on the same list. */
export function teamRulesDecisionModelLock(
  summary: TeamRulesSummary | undefined,
  provider: string,
  model: string,
): string | null {
  if (summary?.status !== "active") return null;
  const state = teamRulesStateFromSummary(summary);
  const providerAllowed = provider === "off" || teamRulesProviderAllowed(state, provider);
  const modelAllowed = provider === "off" || teamRulesModelAllowed(state, model);
  return providerAllowed && modelAllowed ? null : teamRulesSetByLabel(summary.owner);
}

export type TeamRulesThreadNotice =
  | { readonly kind: "hold"; readonly title: string; readonly description: string }
  | {
      readonly kind: "above-ceiling";
      readonly title: string;
      readonly description: string;
      readonly switchTo: RuntimeMode;
      readonly switchLabel: string;
    };

/** What a chat must say: paused by a broken file, or above the limit with the way down. */
export function teamRulesThreadNotice(
  summary: TeamRulesSummary | undefined,
  mode: RuntimeMode,
): TeamRulesThreadNotice | null {
  if (summary === undefined) return null;
  const state = teamRulesStateFromSummary(summary);
  if (summary.status === "hold") {
    const issue = summary.issues?.[0];
    const contact = summary.contact === undefined ? "" : ` See ${summary.contact}.`;
    return {
      kind: "hold",
      title: "Agents are paused by your team's rules",
      description: `${issue === undefined ? "The team rules file has an error." : issue} Fixing the file resumes agents without a restart.${contact}`,
    };
  }
  if (teamRulesModeAllowed(state, mode)) return null;
  const switchTo = teamRulesClampMode(state, mode);
  return {
    kind: "above-ceiling",
    title: TEAM_RULES_ABOVE_LIMIT,
    description: `${teamRulesSetByLabel(summary.owner)}. This chat uses ${teamRulesModeLabel(mode)}.`,
    switchTo,
    switchLabel: `Switch to ${teamRulesModeLabel(switchTo)}`,
  };
}

export type TeamRulesRow = { readonly title: string; readonly value: string };

const listed = (values: readonly string[] | undefined) =>
  values === undefined ? null : values.length === 0 ? "None" : values.join(", ");

/** The rows the Team rules section shows, each only when the rules set it. */
export function teamRulesRows(summary: TeamRulesSummary): readonly TeamRulesRow[] {
  const state = teamRulesStateFromSummary(summary);
  const ceiling = teamRulesCeiling(state);
  const routines = teamRulesRoutineCeiling(state);
  const providers = listed(summary.providers);
  const models = listed(summary.models);
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
    ...(summary.telemetryExport === false ? [{ title: "Telemetry export", value: "Off" }] : []),
  ];
}
