/**
 * Builds the team usage summary (0898 AC-02) from what this machine already
 * reads: the published provider snapshots, the quota history and the
 * projection counts. Every field is copied by name into a fresh object, so a
 * new field on a provider snapshot can never ride along.
 *
 * @module teamUsage/teamUsageSummary
 */
import type {
  ServerProvider,
  TeamUsageAccount,
  TeamUsageConfig,
  TeamUsageSummary,
  TeamUsageWindow,
  UsageLimitHistorySeries,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { limitAccountKey } from "@specweave-studio/shared/usageLimits";

import { emptyCounts, type TeamUsageInstanceCounts, utcDayBounds } from "./teamUsageCounts.ts";

const MAX_LABEL = 80;

/** Trimmed and cut to the label limit; null when nothing is left. */
export function teamUsageLabel(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL).trim();
  return trimmed.length > 0 ? trimmed : null;
}

const roundPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10) / 10));

/** The account label: the member's own text, else the instance's name, else the driver. */
export function teamUsageAccountLabel(provider: ServerProvider, config: TeamUsageConfig): string {
  return (
    teamUsageLabel(config.accountLabels?.[provider.instanceId]) ??
    teamUsageLabel(provider.displayName) ??
    String(provider.driver)
  );
}

function windowsFor(
  provider: ServerProvider,
  history: readonly UsageLimitHistorySeries[],
  nowMs: number,
): TeamUsageWindow[] {
  const limits = provider.usageLimits;
  if (limits === undefined || limits.unavailable !== undefined) return [];
  const accountKey = limitAccountKey(provider.driver, provider.auth.email, limits);
  const { start } = utcDayBounds(nowMs);
  const dayStartMs = Date.parse(start);
  const windows: TeamUsageWindow[] = [];
  for (const window of limits.windows) {
    // Account-wide windows only; a model family's own weekly would read as a second seat.
    if (window.modelScope !== undefined) continue;
    const series =
      accountKey === null
        ? undefined
        : history.find((entry) => entry.accountKey === accountKey && entry.windowId === window.id);
    let highestUsed = window.usedPercent;
    for (const sample of series?.samples ?? []) {
      if (Date.parse(sample.at) >= dayStartMs) highestUsed = Math.max(highestUsed, sample.usedPercent);
    }
    windows.push({
      kind: window.kind,
      remainingPercent: roundPercent(100 - window.usedPercent),
      lowestRemainingPercent: roundPercent(100 - highestUsed),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    });
  }
  return windows;
}

export interface TeamUsageSummaryInput {
  readonly providers: readonly ServerProvider[];
  readonly config: TeamUsageConfig;
  /** The machine's name in SpecWithCode, used when the member set no label. */
  readonly defaultMachineLabel: string;
  readonly history: readonly UsageLimitHistorySeries[];
  readonly counts: ReadonlyMap<string, TeamUsageInstanceCounts>;
  readonly nowMs: number;
}

/** The provider instances a summary covers: every enabled, installed one. */
export const teamUsageProviders = (providers: readonly ServerProvider[]) =>
  providers.filter((provider) => provider.enabled && provider.installed);

export function buildTeamUsageSummary(input: TeamUsageSummaryInput): TeamUsageSummary {
  // A seat is provider + label on the team, so two instances never share a label.
  const taken = new Set<string>();
  const accounts: TeamUsageAccount[] = teamUsageProviders(input.providers).map((provider) => {
    const counts = input.counts.get(provider.instanceId) ?? emptyCounts;
    const planTier = teamUsageLabel(provider.usageLimits?.planLabel);
    const base = teamUsageAccountLabel(provider, input.config);
    let accountLabel = base;
    for (let n = 2; taken.has(`${provider.driver}\n${accountLabel}`); n += 1)
      accountLabel = `${base.slice(0, MAX_LABEL - String(n).length - 1)} ${n}`;
    taken.add(`${provider.driver}\n${accountLabel}`);
    return {
      provider: provider.driver,
      accountLabel,
      ...(planTier === null ? {} : { planTier }),
      windows: windowsFor(provider, input.history, input.nowMs),
      limitHits: counts.limitHits,
      handoffs: counts.handoffs,
      providerSwitches: counts.providerSwitches,
    };
  });
  return {
    machineLabel:
      teamUsageLabel(input.config.machineLabel) ??
      teamUsageLabel(input.defaultMachineLabel) ??
      "This machine",
    at: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
    accounts,
  };
}
