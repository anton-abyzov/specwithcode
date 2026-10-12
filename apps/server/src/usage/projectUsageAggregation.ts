import type {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
  TurnTokenUsage,
} from "@specweave-studio/contracts";
import type {
  ProjectUsageCoverage,
  ProjectUsageModel,
  ProjectUsageSummary,
  ProjectUsageTotals,
} from "../../../../packages/contracts/src/projectUsage.ts";

import { priceUsage, type RateTable } from "./usagePricing.ts";
import type { UsageSpeed } from "./usageTranscripts.ts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@specweave-studio/shared/model";

type Projection = OrchestrationV2ThreadProjection;
export interface ProjectUsageProjection {
  readonly thread: Pick<
    Projection["thread"],
    "id" | "projectId" | "title" | "deletedAt" | "archivedAt"
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<
      Projection["providerThreads"][number],
      "id" | "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<
      Projection["providerTurns"][number],
      "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef" | "turnTokenUsage" | "tokenUsage"
    >
  >;
  readonly attempts: ReadonlyArray<
    Pick<Projection["attempts"][number], "id" | "runId" | "nativeThreadId">
  >;
  readonly runs: ReadonlyArray<
    Pick<Projection["runs"][number], "id" | "threadId" | "modelSelection">
  >;
}

const emptyTotals = (): ProjectUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  equivalentCostUsd: null,
});

function addTotals(a: ProjectUsageTotals, b: ProjectUsageTotals): ProjectUsageTotals {
  const sumCategory = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left + right;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: sumCategory(a.cachedInputTokens, b.cachedInputTokens),
    cacheCreationTokens: sumCategory(a.cacheCreationTokens, b.cacheCreationTokens),
    reasoningTokens: sumCategory(a.reasoningTokens, b.reasoningTokens),
    equivalentCostUsd:
      a.equivalentCostUsd === null && b.equivalentCostUsd === null
        ? null
        : (a.equivalentCostUsd ?? 0) + (b.equivalentCostUsd ?? 0),
  };
}

function speedOf(selection: ModelSelection): UsageSpeed {
  const tier =
    getModelSelectionStringOptionValue(selection, "serviceTier") ??
    getModelSelectionStringOptionValue(selection, "speed");
  if (tier === "ultrafast") return "ultrafast";
  return tier === "priority" ||
    tier === "fast" ||
    getModelSelectionBooleanOptionValue(selection, "fastMode") === true
    ? "fast"
    : "standard";
}

function totalsForTurn(
  usage: TurnTokenUsage | undefined,
  selection: ModelSelection | undefined,
  rates: RateTable,
  priceOverrides: RateTable,
  aliases: ReadonlyMap<string, string>,
): ProjectUsageTotals {
  // Context occupancy (providerTurn.tokenUsage) and cumulative native reports
  // deliberately never enter this function: they are not per-turn consumption.
  const available = usage?.usageStatus !== "unavailable" ? usage : undefined;
  const inputTokens = available?.inputTokens ?? 0;
  const outputTokens = available?.outputTokens ?? 0;
  const cachedInputTokens = available?.cachedInputTokens ?? null;
  const cacheCreationTokens = available?.cacheCreationTokens ?? null;
  const reasoningTokens = available?.reasoningTokens ?? null;
  let equivalentCostUsd: number | null = null;
  // Unknown cache categories cannot safely be assigned the full input rate.
  if (
    available?.usageStatus === "complete" &&
    selection !== undefined &&
    cachedInputTokens !== null &&
    cacheCreationTokens !== null &&
    cachedInputTokens + cacheCreationTokens <= inputTokens
  ) {
    const priced = priceUsage(
      rates,
      {
        model: aliases.get(selection.model) ?? selection.model,
        speed: speedOf(selection),
        reportedCostUsd: null,
        totals: {
          uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
          cachedInputTokens,
          cacheCreationTokens,
          outputTokens,
          reasoningTokens: reasoningTokens ?? 0,
        },
      },
      priceOverrides,
    );
    if (priced.costSource === "modelPriced") equivalentCostUsd = priced.costUsd;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    reasoningTokens,
    equivalentCostUsd,
  };
}

/** Folds persisted latest turn snapshots; re-reading or replaying events adds nothing. */
export function aggregateProjectUsage(input: {
  readonly projectId: ProjectId;
  readonly coordinatorThreadId: ThreadId | null;
  readonly readAt: string;
  readonly projections: ReadonlyArray<ProjectUsageProjection>;
  readonly rates?: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
}): ProjectUsageSummary {
  const coverage: { -readonly [K in keyof ProjectUsageCoverage]: number } = {
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
  let totals = emptyTotals();
  const models = new Map<string, ProjectUsageModel>();
  const seenTurns = new Set<string>();
  const seenThreads = new Set<ThreadId>();
  const threads: ProjectUsageSummary["threads"][number][] = [];
  for (const projection of input.projections) {
    const { thread } = projection;
    if (
      thread.projectId !== input.projectId ||
      thread.deletedAt !== null ||
      seenThreads.has(thread.id)
    )
      continue;
    seenThreads.add(thread.id);
    coverage.threads += 1;
    let threadTotals = emptyTotals();
    let hasUsage = false;
    const providers = new Map(
      projection.providerThreads.map((provider) => [provider.id, provider]),
    );
    const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
    const runs = new Map(
      projection.runs.filter((run) => run.threadId === thread.id).map((run) => [run.id, run]),
    );
    // A projection is already an upsert view. Defensively select one latest
    // snapshot if a fixture or imported view contains the same row twice.
    const turns = new Map(projection.providerTurns.map((turn) => [turn.id, turn]));
    for (const turn of turns.values()) {
      const provider = providers.get(turn.providerThreadId);
      // Fork/history hydration may contain records owned by another app thread.
      if (!provider || provider.appThreadId !== thread.id) continue;
      const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
      const nativeThreadId = attempt?.nativeThreadId ?? provider.nativeThreadRef?.nativeId;
      const nativeTurnId = turn.nativeTurnRef?.nativeId;
      const identity =
        nativeThreadId && nativeTurnId
          ? JSON.stringify([provider.providerInstanceId, nativeThreadId, nativeTurnId])
          : JSON.stringify([provider.providerInstanceId, turn.id]);
      if (seenTurns.has(identity)) continue;
      seenTurns.add(identity);
      const run = attempt ? runs.get(attempt.runId) : undefined;
      const selection =
        run?.modelSelection.instanceId === provider.providerInstanceId
          ? run.modelSelection
          : undefined;
      const usage = turn.turnTokenUsage;
      if (usage?.usageStatus === "complete") coverage.completeTurns += 1;
      else if (usage?.usageStatus === "partial") coverage.partialTurns += 1;
      else coverage.missingTurns += 1;
      if (usage?.hasSubagents) coverage.subagentTurns += 1;
      if (usage && usage.usageStatus !== "unavailable") hasUsage = true;
      const turnTotals = totalsForTurn(
        usage,
        selection,
        input.rates ?? new Map(),
        input.priceOverrides ?? new Map(),
        input.modelAliases ?? new Map(),
      );
      if (turnTotals.cachedInputTokens === null || turnTotals.cacheCreationTokens === null)
        coverage.cacheMissingTurns += 1;
      if (turnTotals.equivalentCostUsd === null) coverage.costUnknownTurns += 1;
      else coverage.costEstimatedTurns += 1;
      threadTotals = addTotals(threadTotals, turnTotals);
      const key = JSON.stringify([
        provider.driver,
        provider.providerInstanceId,
        selection?.model ?? null,
      ]);
      const current = models.get(key);
      models.set(key, {
        provider: provider.driver,
        providerInstanceId: provider.providerInstanceId,
        model: selection?.model ?? null,
        modelAttribution: selection ? "run_selection" : "unknown",
        totals: addTotals(current?.totals ?? emptyTotals(), turnTotals),
      });
    }
    if (hasUsage) coverage.threadsWithUsage += 1;
    else coverage.missingThreads += 1;
    totals = addTotals(totals, threadTotals);
    threads.push({
      threadId: thread.id,
      title: thread.title,
      role: thread.id === input.coordinatorThreadId ? "coordinator" : "worker",
      archived: thread.archivedAt !== null,
      totals: threadTotals,
      share: null,
    });
  }
  return {
    projectId: input.projectId,
    readAt: input.readAt,
    source: "persisted_provider_turns",
    scope: "recorded_main_agents",
    coordinatorThreadId: input.coordinatorThreadId,
    totals,
    threads: threads
      .map((thread) => ({
        ...thread,
        share: totals.totalTokens > 0 ? thread.totals.totalTokens / totals.totalTokens : null,
      }))
      .sort(
        (a, b) =>
          b.totals.totalTokens - a.totals.totalTokens || a.threadId.localeCompare(b.threadId),
      ),
    models: [...models.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
    coverage,
    cacheReadRatio:
      coverage.partialTurns === 0 &&
      coverage.missingTurns === 0 &&
      coverage.missingThreads === 0 &&
      totals.inputTokens > 0 &&
      totals.cachedInputTokens !== null &&
      totals.cachedInputTokens <= totals.inputTokens
        ? totals.cachedInputTokens / totals.inputTokens
        : null,
  };
}
