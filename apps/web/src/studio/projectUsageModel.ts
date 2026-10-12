/**
 * Project usage as people read it: Studio threads plus the CLI sessions run
 * in the project folder, per provider. Each source keeps its own subtotal so
 * nothing is counted twice and the reader can tell where tokens went.
 */
import type { ProjectUsageSummary, ProjectUsageTotals } from "@specweave-studio/contracts";

export interface ProviderUsageRow {
  /** claude, codex, copilot, grok, or a driver kind for anything else. */
  readonly provider: string;
  readonly label: string;
  readonly studioTokens: number;
  readonly cliTokens: number;
  readonly totalTokens: number;
  readonly cliSessions: number;
  readonly lastActiveAt: string | null;
}

const LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  grok: "Grok",
};
const ORDER = ["claude", "codex", "copilot", "grok"];

/** A Studio driver as the CLI it runs: `claudeAgent` is Claude, an ACP Copilot agent is Copilot. */
export function cliOfDriver(driver: string, providerInstanceId: string): string {
  if (driver === "claudeAgent") return "claude";
  if (driver === "acpRegistry" && /copilot/i.test(providerInstanceId)) return "copilot";
  if (driver === "acpRegistry" && /grok/i.test(providerInstanceId)) return "grok";
  return driver;
}

export function providerLabel(provider: string): string {
  return LABELS[provider] ?? provider;
}

export function projectProviderRows(summary: ProjectUsageSummary): readonly ProviderUsageRow[] {
  const rows = new Map<
    string,
    { studio: number; cli: number; sessions: number; last: string | null }
  >();
  const row = (provider: string) => {
    const current = rows.get(provider) ?? { studio: 0, cli: 0, sessions: 0, last: null };
    rows.set(provider, current);
    return current;
  };
  for (const model of summary.models) {
    row(cliOfDriver(model.provider, model.providerInstanceId)).studio += model.totals.totalTokens;
  }
  for (const provider of summary.folderSessions?.providers ?? []) {
    const current = row(provider.provider);
    current.cli += provider.totals.totalTokens;
    current.sessions += provider.sessions;
    current.last = provider.lastActiveAt;
  }
  const rank = (provider: string) => {
    const index = ORDER.indexOf(provider);
    return index < 0 ? ORDER.length : index;
  };
  return [...rows]
    .map(([provider, value]) => ({
      provider,
      label: providerLabel(provider),
      studioTokens: value.studio,
      cliTokens: value.cli,
      totalTokens: value.studio + value.cli,
      cliSessions: value.sessions,
      lastActiveAt: value.last,
    }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || b.totalTokens - a.totalTokens);
}

function sumNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

/** Studio threads and folder sessions together. Unknown categories stay unknown. */
export function combinedProjectTotals(summary: ProjectUsageSummary): ProjectUsageTotals {
  const folder = summary.folderSessions?.totals;
  if (!folder) return summary.totals;
  const threads = summary.totals;
  // With no Studio turns at all, an all-zero thread subtotal must not hide folder categories.
  const noThreadTurns =
    summary.coverage.completeTurns +
      summary.coverage.partialTurns +
      summary.coverage.missingTurns ===
    0;
  return {
    inputTokens: threads.inputTokens + folder.inputTokens,
    outputTokens: threads.outputTokens + folder.outputTokens,
    totalTokens: threads.totalTokens + folder.totalTokens,
    cachedInputTokens: noThreadTurns
      ? folder.cachedInputTokens
      : sumNullable(threads.cachedInputTokens, folder.cachedInputTokens),
    cacheCreationTokens: noThreadTurns
      ? folder.cacheCreationTokens
      : sumNullable(threads.cacheCreationTokens, folder.cacheCreationTokens),
    reasoningTokens: noThreadTurns
      ? folder.reasoningTokens
      : sumNullable(threads.reasoningTokens, folder.reasoningTokens),
    equivalentCostUsd:
      threads.equivalentCostUsd === null && folder.equivalentCostUsd === null
        ? null
        : (threads.equivalentCostUsd ?? 0) + (folder.equivalentCostUsd ?? 0),
  };
}

/**
 * Cache reads over input across both sources. Null when Studio coverage is
 * incomplete (the server's own rule) or nothing was measured.
 */
export function combinedCacheReadRatio(summary: ProjectUsageSummary): number | null {
  const folder = summary.folderSessions;
  // Nothing to add: the server's input-weighted ratio stands as reported.
  if (!folder || folder.totals.totalTokens === 0) return summary.cacheReadRatio ?? null;
  const studioTurns =
    summary.coverage.completeTurns + summary.coverage.partialTurns + summary.coverage.missingTurns;
  if (studioTurns > 0 && (summary.cacheReadRatio ?? null) === null) return null;
  const totals = combinedProjectTotals(summary);
  if (totals.inputTokens <= 0 || totals.cachedInputTokens === null) return null;
  return totals.cachedInputTokens <= totals.inputTokens
    ? totals.cachedInputTokens / totals.inputTokens
    : null;
}
