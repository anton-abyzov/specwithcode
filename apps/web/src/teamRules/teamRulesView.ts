import type {
  RuntimeMode,
  TeamRulesCarried,
  TeamRulesPeerRules,
  TeamRulesRefusal,
  TeamRulesSummary,
} from "@specweave-studio/contracts";
import {
  TEAM_RULES_NONE,
  teamRulesCarriedRefusal,
  teamRulesCeiling,
  teamRulesClampMode,
  teamRulesClampToCarried,
  teamRulesDrift,
  teamRulesMachineLinkRefusal,
  teamRulesMachineRefusal,
  teamRulesModeAllowed,
  teamRulesModeLabel,
  teamRulesModelAllowed,
  teamRulesOutgoingWorkRefusal,
  teamRulesPeerRules,
  teamRulesProviderAllowed,
  teamRulesReachRefusal,
  teamRulesRoutineCeiling,
  teamRulesSetByLabel,
  teamRulesStateFromSummary,
  teamRulesThreadModeAllowed,
  teamRulesToolRefusal,
  type TeamRulesDrift,
  type TeamRulesReachPath,
  type TeamRulesState,
  type TeamRulesTool,
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

/**
 * What a chat must say: paused by a broken file, or above the limit with the way
 * down. The limit is this machine's or the one the thread brought with it.
 */
export function teamRulesThreadNotice(
  summary: TeamRulesSummary | undefined,
  mode: RuntimeMode,
  carried?: TeamRulesCarried,
): TeamRulesThreadNotice | null {
  const state = teamRulesStateFromSummary(summary);
  if (summary?.status === "hold") {
    const issue = summary.issues?.[0];
    const contact = summary.contact === undefined ? "" : ` See ${summary.contact}.`;
    return {
      kind: "hold",
      title: "Agents are paused by your team's rules",
      description: `${issue === undefined ? "The team rules file has an error." : issue} Fixing the file resumes agents without a restart.${contact}`,
    };
  }
  if (teamRulesThreadModeAllowed(state, carried, mode)) return null;
  const switchTo = teamRulesClampToCarried(teamRulesClampMode(state, mode), carried);
  return {
    kind: "above-ceiling",
    title: TEAM_RULES_ABOVE_LIMIT,
    description: teamRulesModeAllowed(state, mode)
      ? (teamRulesCarriedRefusal(carried, mode)?.message ?? "")
      : `${teamRulesSetByLabel(summary?.owner)}. This chat uses ${teamRulesModeLabel(mode)}.`,
    switchTo,
    switchLabel: `Switch to ${teamRulesModeLabel(switchTo)}`,
  };
}

export type TeamRulesRow = { readonly title: string; readonly value: string };

/** A row the rules turn off: who to name, and the sentence the server would refuse with. */
export type TeamRulesLock = { readonly setBy: string; readonly message: string };

const lockFrom = (
  summary: TeamRulesSummary | undefined,
  refused: TeamRulesRefusal | null,
): TeamRulesLock | null =>
  refused === null
    ? null
    : { setBy: teamRulesSetByLabel(summary?.owner), message: refused.message };

export const teamRulesReachLock = (
  summary: TeamRulesSummary | undefined,
  path: TeamRulesReachPath,
) => lockFrom(summary, teamRulesReachRefusal(teamRulesStateFromSummary(summary), path));

export const teamRulesToolLock = (summary: TeamRulesSummary | undefined, tool: TeamRulesTool) =>
  lockFrom(summary, teamRulesToolRefusal(teamRulesStateFromSummary(summary), tool));

/** The lock on linking any new machine, before the other machine is known. */
export const teamRulesMachineLinkLock = (summary: TeamRulesSummary | undefined) =>
  lockFrom(summary, teamRulesMachineLinkRefusal(teamRulesStateFromSummary(summary)));

/** The lock on connecting to this machine in particular, which `same-rules` decides per peer. */
export function teamRulesMachineLock(
  summary: TeamRulesSummary | undefined,
  peer: { readonly label?: string | undefined; readonly fingerprint: string | undefined },
): TeamRulesLock | null {
  const state = teamRulesStateFromSummary(summary);
  return lockFrom(
    summary,
    teamRulesMachineLinkRefusal(state) ?? teamRulesMachineRefusal(state, peer),
  );
}

/** A connected machine's summary as another machine reads it. */
export const teamRulesPeerFromSummary = (summary: TeamRulesSummary | undefined) =>
  teamRulesPeerRules(teamRulesStateFromSummary(summary));

/** How the Machines page shows one machine's rules. */
export type TeamRulesMachineView = {
  readonly status: TeamRulesDrift | "this-machine";
  readonly label: string;
  readonly tone: "success" | "warning" | "secondary";
  /** The short form people compare between machines. */
  readonly fingerprint: string | null;
  readonly detail: string | null;
};

const shortFingerprint = (fingerprint: string | undefined) =>
  fingerprint === undefined || fingerprint.length === 0 ? null : fingerprint.slice(0, 8);

const HOLD_DETAIL = "The team rules file there has an error.";

export function teamRulesOwnMachineView(
  summary: TeamRulesSummary | undefined,
): TeamRulesMachineView {
  if (summary === undefined) {
    return {
      status: "this-machine",
      label: "No rules",
      tone: "secondary",
      fingerprint: null,
      detail: null,
    };
  }
  return summary.status === "hold"
    ? {
        status: "this-machine",
        label: "On hold",
        tone: "warning",
        fingerprint: null,
        detail: "The team rules file here has an error.",
      }
    : {
        status: "this-machine",
        label: "Rules on this machine",
        tone: "secondary",
        fingerprint: shortFingerprint(summary.fingerprint),
        detail: null,
      };
}

/** Another machine's rules against this one's, and whether the rules refuse work there. */
export function teamRulesPeerMachineView(
  summary: TeamRulesSummary | undefined,
  peer: TeamRulesPeerRules | undefined,
  peerKnown: boolean,
): TeamRulesMachineView {
  const state = teamRulesStateFromSummary(summary);
  // With no rules here, the engine reads a silent machine as `none`; only a known one is.
  const status =
    peer === undefined && !peerKnown ? "unknown" : teamRulesDrift(state, peer, peerKnown);
  const fingerprint = shortFingerprint(peer?.fingerprint);
  const refused =
    teamRulesOutgoingWorkRefusal(state, { fingerprint: peer?.fingerprint }) === null
      ? null
      : "Work refused.";
  const detail = (own: string | null) => [own, refused].filter(Boolean).join(" ") || null;
  switch (status) {
    case "same":
      return { status, label: "Same rules", tone: "success", fingerprint, detail: detail(null) };
    case "different":
      return {
        status,
        label: peer === undefined ? "No rules" : "Different rules",
        tone: "warning",
        fingerprint,
        detail: detail(null),
      };
    case "hold":
      return {
        status,
        label: "On hold",
        tone: "warning",
        fingerprint,
        detail: detail(HOLD_DETAIL),
      };
    case "unknown":
      return {
        status,
        label: "Rules unknown",
        tone: "secondary",
        fingerprint,
        detail: detail("It has not said which rules it runs."),
      };
    case "none":
      return { status, label: "No rules", tone: "secondary", fingerprint, detail: detail(null) };
  }
}

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
    ...(summary.reach?.phones === false
      ? [
          {
            title: "Phones",
            value: "Off. No new pairing, and phones already paired stay out until this changes.",
          },
        ]
      : []),
    ...(summary.reach?.connect === false
      ? [{ title: "SpecWithCode Connect", value: "Off. Nothing reaches this machine through it." }]
      : []),
    ...(summary.reach?.machines === "none"
      ? [{ title: "Other machines", value: "Off. No work goes to or comes from other machines." }]
      : summary.reach?.machines === "same-rules"
        ? [{ title: "Other machines", value: "Only machines with exactly these rules." }]
        : []),
    ...(summary.reach?.webhooks === false
      ? [{ title: "Webhooks", value: "Off. No routine starts from a webhook." }]
      : []),
    ...(summary.tools?.chrome === false
      ? [{ title: "Chrome", value: "Off. Agents cannot drive Chrome; preview tools still work." }]
      : []),
    ...(summary.tools?.computerUse === false
      ? [{ title: "Computer use", value: "Off. Agents cannot control this desktop." }]
      : []),
    ...(summary.tools?.google === false
      ? [
          {
            title: "Google account",
            value: "Off. Signing in and agent access stop; disconnect stays.",
          },
        ]
      : []),
    ...(summary.tools?.telegram === false
      ? [{ title: "Telegram", value: "Off. The channel stops listening; unpair stays." }]
      : []),
  ];
}
