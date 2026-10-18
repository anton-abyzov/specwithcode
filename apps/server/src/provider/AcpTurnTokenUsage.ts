import type { TurnTokenUsage } from "@specweave-studio/contracts";

/**
 * What one ACP prompt consumed, as far as the agent said. Input includes cache
 * reads and writes, matching every other driver's normalized turn usage.
 */
export interface AcpTurnUsageCounts {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the usage of a `session/prompt` response.
 *
 * Three shapes exist. The ACP `usage` field (still marked unstable) carries
 * `inputTokens`, `outputTokens`, `thoughtTokens`, `cachedReadTokens` and
 * `cachedWriteTokens`. Grok Build instead puts its own totals under
 * `_meta.usage`, with `cacheCreationTokens` and `reasoningTokens`. Gemini CLI
 * reports `_meta.quota.token_count` with snake_case `input_tokens` (the prompt
 * count, cache included) and `output_tokens` (candidates only, no thinking).
 * An agent that reports none leaves the turn unreported; nothing is estimated.
 */
export function readAcpPromptUsage(result: unknown): AcpTurnUsageCounts | undefined {
  const response = record(result);
  const meta = record(response?._meta);
  const usage = record(response?.usage) ?? record(meta?.usage);
  if (!usage) return readGeminiCliQuota(record(record(meta?.quota)?.token_count));

  const reportedInput = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const cachedInputTokens = count(usage.cachedReadTokens);
  const cacheCreationTokens = count(usage.cachedWriteTokens ?? usage.cacheCreationTokens);
  const reasoning = count(usage.thoughtTokens ?? usage.reasoningTokens);
  if (reportedInput === undefined && outputTokens === undefined) return undefined;

  // Agents disagree on whether `inputTokens` already contains the cached part.
  // The total settles it: when it only adds up with the cache counted on top,
  // the cache was reported separately and belongs in the input.
  const cache = (cachedInputTokens ?? 0) + (cacheCreationTokens ?? 0);
  const total = count(usage.totalTokens);
  const cacheIsSeparate =
    reportedInput !== undefined &&
    cache > 0 &&
    (cache > reportedInput ||
      (total !== undefined && total >= reportedInput + (outputTokens ?? 0) + cache));
  const inputTokens =
    reportedInput === undefined
      ? undefined
      : cacheIsSeparate
        ? reportedInput + cache
        : reportedInput;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    reasoningTokens:
      reasoning !== undefined && outputTokens !== undefined
        ? Math.min(outputTokens, reasoning)
        : undefined,
  };
}

function readGeminiCliQuota(
  tokenCount: Record<string, unknown> | undefined,
): AcpTurnUsageCounts | undefined {
  const inputTokens = count(tokenCount?.input_tokens);
  const outputTokens = count(tokenCount?.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: undefined,
    cacheCreationTokens: undefined,
    reasoningTokens: undefined,
  };
}

/**
 * One provider turn can hold several prompts (a continuation after background
 * work). A category stays known only while every prompt reported it.
 */
export function addAcpTurnUsage(
  previous: AcpTurnUsageCounts | undefined,
  next: AcpTurnUsageCounts,
): AcpTurnUsageCounts {
  if (!previous) return next;
  const sum = (left: number | undefined, right: number | undefined) =>
    left === undefined || right === undefined ? undefined : left + right;
  return {
    inputTokens: sum(previous.inputTokens, next.inputTokens),
    outputTokens: sum(previous.outputTokens, next.outputTokens),
    cachedInputTokens: sum(previous.cachedInputTokens, next.cachedInputTokens),
    cacheCreationTokens: sum(previous.cacheCreationTokens, next.cacheCreationTokens),
    reasoningTokens: sum(previous.reasoningTokens, next.reasoningTokens),
  };
}

/** The persisted form. Only a completed turn with both totals counts as complete. */
export function normalizeAcpTurnTokenUsage(
  counts: AcpTurnUsageCounts,
  hasSubagents: boolean,
  terminalStatus: string,
): TurnTokenUsage {
  const common = {
    usageScope: "main_agent",
    ...(counts.cachedInputTokens !== undefined
      ? { cachedInputTokens: counts.cachedInputTokens }
      : {}),
    ...(counts.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: counts.cacheCreationTokens }
      : {}),
    ...(counts.reasoningTokens !== undefined ? { reasoningTokens: counts.reasoningTokens } : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    counts.inputTokens !== undefined &&
    counts.outputTokens !== undefined
  ) {
    return {
      ...common,
      usageStatus: "complete",
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
    };
  }
  return {
    ...common,
    usageStatus: "partial",
    ...(counts.inputTokens !== undefined ? { inputTokens: counts.inputTokens } : {}),
    ...(counts.outputTokens !== undefined ? { outputTokens: counts.outputTokens } : {}),
  };
}
