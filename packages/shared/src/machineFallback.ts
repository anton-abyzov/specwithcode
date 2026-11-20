/**
 * Which paired machine a thread may hand off to when its provider nears or
 * hits its usage limit. Shared by the server's automatic handoff and the limit
 * banner, so both name the same target and the same reason for each skip.
 *
 * A machine counts only with real room: another account pool, usage below the
 * threshold, the machine online, the provider signed in, and the work grant
 * covering both the project and the sign-in.
 *
 * @module machineFallback
 */
import {
  type LimitHandoffCandidateReason,
  type LimitHandoffTrackDecision,
  MODEL_TRACK_LABELS,
  type ModelSelection,
  type OrchestratorMcpMachine,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderLimitMachineTarget,
  type ProviderLimitTargetOrder,
} from "@specweave-studio/contracts";

import { type ExcludedFallbackModel, isExcludedFallbackModel } from "./providerFallback.ts";

/** Usage read longer ago than this counts as unknown. Matches the fleet capacity snapshot. */
export const MACHINE_USAGE_MAX_AGE_MS = 15 * 60_000;

export type MachineCandidateReason = LimitHandoffCandidateReason;

/** Reasons that mean only "we can't tell"; the unknown-usage policy may accept them. */
const UNKNOWN_REASONS: ReadonlySet<MachineCandidateReason> = new Set([
  "unknown_account",
  "unknown_usage",
  "stale_usage",
]);

export interface MachineCandidateVerdict {
  readonly target: ProviderLimitMachineTarget;
  readonly machineLabel: string;
  readonly eligible: boolean;
  readonly reason: MachineCandidateReason;
  /** "Minis: same Claude account as M4". */
  readonly text: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
}

/** The provider the thread runs out on. */
export interface MachineCandidateSource {
  readonly machineLabel: string;
  readonly driverKind: string;
  readonly accountFingerprint: string | null;
}

export type MachineView = Pick<
  OrchestratorMcpMachine,
  "label" | "environmentId" | "status" | "project" | "providers"
>;

export function providerName(driverKind: string): string {
  return PROVIDER_DISPLAY_NAMES[driverKind as ProviderDriverKind] ?? driverKind;
}

/** The fullest view of a target's machine name: its live label, else the saved one. */
export function targetMachineLabel(
  target: ProviderLimitMachineTarget,
  machine: Pick<MachineView, "label"> | undefined,
): string {
  return machine?.label ?? target.label ?? "Unknown machine";
}

/**
 * Whether `target` may take the thread now, and why not when it can't.
 * `thresholdPercent` null means "only at the limit" (100).
 */
export function judgeMachineCandidate(input: {
  readonly target: ProviderLimitMachineTarget;
  readonly machine: MachineView | undefined;
  readonly source: MachineCandidateSource;
  readonly projectTitle: string | null;
  /** Machines the project is linked to; null for a project without a logical identity. */
  readonly linkedEnvironmentIds?: ReadonlyArray<string> | null;
  readonly thresholdPercent: number | null;
  readonly unknownUsageEligible: boolean;
  readonly nowMs: number;
  /**
   * The user's excluded fallback models. Only entries without an instance
   * apply: an instance id names an account on this machine, not the target's.
   */
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
}): MachineCandidateVerdict {
  const { target, machine, source } = input;
  const label = targetMachineLabel(target, machine);
  const verdict = (
    reason: MachineCandidateReason,
    detail: string,
    usage?: { readonly usedPercent: number | null; readonly resetsAt: string | null },
  ): MachineCandidateVerdict => ({
    target,
    machineLabel: label,
    eligible: reason === "eligible" || (input.unknownUsageEligible && UNKNOWN_REASONS.has(reason)),
    reason,
    text: `${label}: ${detail}`,
    usedPercent: usage?.usedPercent ?? null,
    resetsAt: usage?.resetsAt ?? null,
  });

  if (machine === undefined) return verdict("not_paired", "not paired");
  switch (machine.status) {
    case "unreachable":
      return verdict("offline", "offline");
    case "needs_grant":
      return verdict("needs_grant", "no work grant");
    case "grant_revoked":
      return verdict("grant_revoked", "work grant revoked");
    case "grant_expired":
      return verdict("grant_expired", "work grant expired");
    case "identity_mismatch":
      return verdict("pair_again", "pair again, its identity changed");
    case "unsupported":
      return verdict("update_needed", "update SpecWithCode there");
    case "ready":
    case "grant_expiring":
    // The grant is live but leaves this project out; the project match below says how.
    case "project_not_in_grant":
      break;
  }
  const project = machine.project;
  const projectName = input.projectTitle ?? "this project";
  if (project?.match === "none")
    return input.linkedEnvironmentIds != null &&
      !input.linkedEnvironmentIds.includes(target.environmentId)
      ? verdict("not_linked", `${projectName} isn't linked there`)
      : verdict("no_project_grant", `no work grant for ${projectName}`);
  if (project?.match === "ambiguous")
    return verdict("ambiguous_project", `more than one project matches ${projectName}`);
  if (machine.providers === undefined) return verdict("not_checked", "not checked yet");

  const selection = target.modelSelection;
  const provider = machine.providers.find((row) => row.providerInstanceId === selection.instanceId);
  if (provider === undefined) return verdict("not_installed", `${selection.instanceId} not set up`);
  const name = providerName(provider.driverKind);
  if (provider.allowedByGrant === false)
    return verdict("account_not_granted", `work grant excludes its ${name} sign-in`);
  if (!provider.available) return verdict("unavailable", `${name} unavailable`);
  if (!provider.models.includes(selection.model))
    return verdict("model_missing", `${name} has no ${target.modelLabel ?? selection.model}`);
  // Never eligible, whatever the unknown-usage policy says. An existing reason
  // keeps older clients able to decode the verdict.
  if (
    isExcludedFallbackModel(
      input.excludedModels?.filter((entry) => entry.instanceId === undefined),
      selection.instanceId,
      selection.model,
    )
  )
    return verdict(
      "unavailable",
      `${target.modelLabel ?? selection.model} is excluded from automatic fallback`,
    );
  if (provider.paidModels?.includes(selection.model))
    return verdict("unavailable", `${target.modelLabel ?? selection.model} is billed per token`);

  const usage = provider.usage;
  if (usage === undefined) return verdict("unknown_usage", `doesn't report ${name} usage`);
  const shown = { usedPercent: usage.usedPercent, resetsAt: usage.resetsAt };
  if (!usage.signedIn) return verdict("signed_out", `${name} not signed in`, shown);
  const sameDriver = provider.driverKind === source.driverKind;
  if (
    sameDriver &&
    usage.accountFingerprint !== null &&
    usage.accountFingerprint === source.accountFingerprint
  )
    return verdict("same_account", `same ${name} account as ${source.machineLabel}`, shown);
  if (usage.limited === true) return verdict("limited", `${name} limit reached`, shown);

  const observedMs = usage.observedAt === null ? Number.NaN : Date.parse(usage.observedAt);
  const fresh = Number.isFinite(observedMs) && input.nowMs - observedMs <= MACHINE_USAGE_MAX_AGE_MS;
  const resetMs = usage.resetsAt === null ? Number.NaN : Date.parse(usage.resetsAt);
  // Usage only rises until its window resets, so an old reading at the threshold still holds.
  const stillCounts = fresh || (Number.isFinite(resetMs) && resetMs > input.nowMs);
  const threshold = input.thresholdPercent ?? 100;
  if (usage.usedPercent !== null && stillCounts && usage.usedPercent >= threshold)
    return verdict("at_threshold", `${name} at ${Math.round(usage.usedPercent)}%`, shown);
  if (sameDriver && (usage.accountFingerprint === null || source.accountFingerprint === null))
    return verdict(
      "unknown_account",
      `can't tell whether ${name} uses another account than ${source.machineLabel}`,
      shown,
    );
  if (usage.usedPercent === null) return verdict("unknown_usage", `${name} usage unknown`, shown);
  if (!fresh) return verdict("stale_usage", `${name} usage not read recently`, shown);
  return verdict("eligible", `${name} at ${Math.round(usage.usedPercent)}%`, shown);
}

export type FallbackCandidate =
  | { readonly kind: "local"; readonly modelSelection: ModelSelection }
  | { readonly kind: "machine"; readonly target: ProviderLimitMachineTarget };

/** The full fallback order a limited thread tries, as Settings shows it. */
export function orderFallbackCandidates(
  order: ProviderLimitTargetOrder,
  local: ReadonlyArray<ModelSelection>,
  machines: ReadonlyArray<ProviderLimitMachineTarget>,
): ReadonlyArray<FallbackCandidate> {
  const here = local.map((modelSelection) => ({ kind: "local", modelSelection }) as const);
  const there = machines.map((target) => ({ kind: "machine", target }) as const);
  return order === "same-machine-first" ? [...here, ...there] : [...there, ...here];
}

/** The first eligible verdict, in the order given. */
export function firstEligibleMachine(
  verdicts: ReadonlyArray<MachineCandidateVerdict>,
): MachineCandidateVerdict | undefined {
  return verdicts.find((verdict) => verdict.eligible);
}

/** "No other machine has room: Minis: same Claude account as M4; M3: offline." */
export function describeMachineWait(verdicts: ReadonlyArray<MachineCandidateVerdict>): string {
  if (verdicts.length === 0) return "No other machine is set up to take over.";
  return `No other machine has room: ${verdicts.map((verdict) => verdict.text).join("; ")}.`;
}

/** Whether two machine targets name the same machine and model. */
export function sameMachineTarget(
  left: Pick<ProviderLimitMachineTarget, "environmentId" | "modelSelection">,
  right: Pick<ProviderLimitMachineTarget, "environmentId" | "modelSelection">,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.modelSelection.instanceId === right.modelSelection.instanceId &&
    left.modelSelection.model === right.modelSelection.model
  );
}

/**
 * What a target's sign-in adds for a thread that leaves `source` (1390). It is
 * the line the target picker shows and the rule both starts share: by hand a
 * shared or unknown account is allowed with its line, automatically only a
 * different account with a fresh reading below the threshold qualifies.
 */
export type AccountEvidenceKind = "different-account" | "same-account" | "usage-unknown";

export interface AccountEvidence {
  readonly kind: AccountEvidenceKind;
  /** "Different Claude account · 60% left". */
  readonly line: string;
  readonly percentLeft: number | null;
  /** An automatic move may pick this sign-in. */
  readonly automatic: boolean;
  /** A person may pick it, reading the line. False when no turn could run on it. */
  readonly byHand: boolean;
  readonly reason: MachineCandidateReason;
}

type UsageReading = NonNullable<NonNullable<MachineView["providers"]>[number]["usage"]>;

/**
 * Unlike `judgeMachineCandidate`, no policy turns an unknown reading into room,
 * and a reading older than `MACHINE_USAGE_MAX_AGE_MS` is unknown however long
 * its window still runs: usage only rises, so an old low reading proves nothing.
 */
export function judgeAccountEvidence(input: {
  readonly providerName: string;
  readonly sourceLabel: string;
  /** The sign-in runs on the provider the thread ran out on. */
  readonly sameDriver: boolean;
  /** The account pools the thread's track is out on at the source. */
  readonly sourceFingerprints: ReadonlyArray<string>;
  readonly usage: UsageReading | undefined;
  /** Null means "only at the limit" (100). */
  readonly thresholdPercent: number | null;
  readonly nowMs: number;
}): AccountEvidence {
  const { usage } = input;
  const name = input.providerName;
  const unknown = (reason: MachineCandidateReason, byHand = true): AccountEvidence => ({
    kind: "usage-unknown",
    line: "Usage unknown",
    percentLeft: null,
    automatic: false,
    byHand,
    reason,
  });
  if (usage === undefined) return unknown("unknown_usage");
  if (!usage.signedIn) return { ...unknown("signed_out", false), line: `${name} not signed in` };
  // A fingerprint is salted from the provider and the account, so an exact match
  // is that pool whichever provider the thread stopped on.
  const shared =
    usage.accountFingerprint !== null &&
    input.sourceFingerprints.includes(usage.accountFingerprint);
  if (shared)
    return {
      kind: "same-account",
      line: `Same ${name} account as ${input.sourceLabel}: adds no usage`,
      percentLeft: null,
      automatic: false,
      byHand: true,
      reason: "same_account",
    };
  const left = usage.usedPercent === null ? null : Math.max(0, Math.round(100 - usage.usedPercent));
  if (usage.limited === true)
    return {
      kind: "different-account",
      line: `${name} limit reached`,
      percentLeft: left,
      automatic: false,
      byHand: false,
      reason: "limited",
    };
  if (
    input.sameDriver &&
    (usage.accountFingerprint === null || input.sourceFingerprints.length === 0)
  )
    return unknown("unknown_account");
  if (usage.usedPercent === null || left === null) return unknown("unknown_usage");
  const observedMs = usage.observedAt === null ? Number.NaN : Date.parse(usage.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > MACHINE_USAGE_MAX_AGE_MS)
    return unknown("stale_usage");
  const room = usage.usedPercent < (input.thresholdPercent ?? 100);
  return {
    kind: "different-account",
    line: `Different ${name} account · ${left}% left`,
    percentLeft: left,
    automatic: room,
    byHand: true,
    reason: room ? "eligible" : "at_threshold",
  };
}

/**
 * Shown under the order in Settings: a thread on a track ignores the order
 * until its track is out on this machine (1390).
 */
export const TRACK_BEFORE_ORDER_LINE =
  "Threads on a track try every model of their track on this machine first, whatever this order says. They hand off only when that track is out here.";

/**
 * What a thread shows while no machine has its track: "Daily track is out on
 * every machine", then "Next reset: Minis at 14:02" or "Reset unknown". Null
 * unless every machine that could take the track answered with no room.
 */
export function describeTrackWait(
  decision: Pick<
    LimitHandoffTrackDecision,
    "track" | "target" | "everyMachineOut" | "earliestReset"
  >,
  formatTime: (at: string) => string,
): { readonly title: string; readonly detail: string } | null {
  if (!decision.everyMachineOut || decision.target !== null) return null;
  const reset = decision.earliestReset;
  return {
    title: `${MODEL_TRACK_LABELS[decision.track]} track is out on every machine`,
    detail:
      reset === null
        ? "Reset unknown"
        : `Next reset: ${reset.machineLabel} at ${formatTime(reset.at)}`,
  };
}
