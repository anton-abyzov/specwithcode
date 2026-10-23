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
  type ModelSelection,
  type OrchestratorMcpMachine,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderLimitMachineTarget,
  type ProviderLimitTargetOrder,
} from "@specweave-studio/contracts";

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
