import {
  ProjectId,
  ProviderInstanceId,
  type ProjectUsageSummary,
  type ProjectUsageTotals,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cliOfDriver,
  combinedCacheReadRatio,
  combinedProjectTotals,
  projectProviderRows,
} from "./projectUsageModel";

const totals = (input: number, cached: number | null, output: number): ProjectUsageTotals => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: cached,
  cacheCreationTokens: cached === null ? null : 0,
  reasoningTokens: 0,
  equivalentCostUsd: null,
});

const coverage = {
  threads: 0,
  threadsWithUsage: 0,
  missingThreads: 0,
  completeTurns: 0,
  partialTurns: 0,
  missingTurns: 0,
  subagentTurns: 0,
  cacheMissingTurns: 0,
  costEstimatedTurns: 0,
  costUnknownTurns: 0,
};

function summary(overrides: Partial<ProjectUsageSummary>): ProjectUsageSummary {
  return {
    projectId: ProjectId.make("p"),
    readAt: "2026-10-10T12:00:00.000Z",
    source: "persisted_provider_turns",
    scope: "recorded_main_agents",
    coordinatorThreadId: null,
    totals: totals(0, 0, 0),
    threads: [],
    models: [],
    coverage,
    cacheReadRatio: null,
    ...overrides,
  };
}

const folder = {
  hostLabel: "m4",
  windowDays: 90,
  roots: ["/work/app"],
  sessions: 3,
  studioOwnedSessions: 0,
  totals: totals(1000, 800, 100),
  providers: [
    {
      provider: "codex",
      sessions: 1,
      totals: totals(200, 100, 20),
      lastActiveAt: "2026-10-10T11:00:00.000Z",
    },
    { provider: "claude", sessions: 2, totals: totals(800, 700, 80), lastActiveAt: null },
  ],
  models: [],
};

describe("project usage model", () => {
  it("maps Studio drivers to the CLI they run", () => {
    expect(cliOfDriver("claudeAgent", "claudeAgent")).toBe("claude");
    expect(cliOfDriver("acpRegistry", "github-copilot-cli")).toBe("copilot");
    expect(cliOfDriver("codex", "codex")).toBe("codex");
    expect(cliOfDriver("pi", "pi")).toBe("pi");
  });

  it("counts a project with only CLI sessions instead of showing zeros", () => {
    const data = summary({ folderSessions: folder });
    expect(combinedProjectTotals(data).totalTokens).toBe(1100);
    expect(combinedProjectTotals(data).cachedInputTokens).toBe(800);
    expect(combinedCacheReadRatio(data)).toBeCloseTo(0.8);
    expect(projectProviderRows(data).map((row) => [row.provider, row.cliSessions])).toEqual([
      ["claude", 2],
      ["codex", 1],
    ]);
  });

  it("adds Studio thread usage per provider beside folder sessions", () => {
    const data = summary({
      totals: totals(500, 100, 50),
      coverage: { ...coverage, threads: 1, threadsWithUsage: 1, completeTurns: 2 },
      cacheReadRatio: 0.2,
      models: [
        {
          provider: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus",
          modelAttribution: "run_selection",
          totals: totals(500, 100, 50),
        },
      ],
      folderSessions: folder,
    });
    const claude = projectProviderRows(data)[0];
    expect(claude).toMatchObject({ studioTokens: 550, cliTokens: 880, totalTokens: 1430 });
    expect(combinedProjectTotals(data).totalTokens).toBe(1650);
    expect(combinedCacheReadRatio(data)).toBeCloseTo(900 / 1500);
  });

  it("keeps the ratio unknown when Studio coverage is incomplete", () => {
    const data = summary({
      totals: totals(500, null, 50),
      coverage: { ...coverage, threads: 1, missingTurns: 1 },
      cacheReadRatio: null,
      folderSessions: folder,
    });
    expect(combinedCacheReadRatio(data)).toBe(null);
    expect(combinedProjectTotals(data).cachedInputTokens).toBe(null);
  });
});
