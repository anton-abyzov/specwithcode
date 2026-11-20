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

/** The counts a `session/prompt` response reported, before they are interpreted. */
export interface AcpRawPromptUsage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedReadTokens: number | undefined;
  readonly cachedWriteTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly totalTokens: number | undefined;
}

const RAW_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

/**
 * Reads the counts of a `session/prompt` response.
 *
 * Three shapes exist. The ACP `usage` field (still marked unstable) carries
 * `inputTokens`, `outputTokens`, `thoughtTokens`, `cachedReadTokens` and
 * `cachedWriteTokens`. Grok Build instead puts its own totals under
 * `_meta.usage`, with `cacheCreationTokens` and `reasoningTokens`. Gemini CLI
 * reports `_meta.quota.token_count` with snake_case `input_tokens` (the prompt
 * count, cache included) and `output_tokens` (candidates only, no thinking).
 * An agent that reports none leaves the turn unreported; nothing is estimated.
 */
export function readAcpRawPromptUsage(result: unknown): AcpRawPromptUsage | undefined {
  const response = record(result);
  const meta = record(response?._meta);
  const usage = record(response?.usage) ?? record(meta?.usage);
  const raw: AcpRawPromptUsage = usage
    ? {
        inputTokens: count(usage.inputTokens),
        outputTokens: count(usage.outputTokens),
        cachedReadTokens: count(usage.cachedReadTokens),
        cachedWriteTokens: count(usage.cachedWriteTokens ?? usage.cacheCreationTokens),
        reasoningTokens: count(usage.thoughtTokens ?? usage.reasoningTokens),
        totalTokens: count(usage.totalTokens),
      }
    : (() => {
        const tokenCount = record(record(meta?.quota)?.token_count);
        return {
          inputTokens: count(tokenCount?.input_tokens),
          outputTokens: count(tokenCount?.output_tokens),
          cachedReadTokens: undefined,
          cachedWriteTokens: undefined,
          reasoningTokens: undefined,
          totalTokens: undefined,
        };
      })();
  return raw.inputTokens === undefined && raw.outputTokens === undefined ? undefined : raw;
}

/** Interprets reported counts as one prompt's usage, input including the cache. */
export function normalizeAcpPromptUsage(raw: AcpRawPromptUsage): AcpTurnUsageCounts {
  const reportedInput = raw.inputTokens;
  const outputTokens = raw.outputTokens;
  const cachedInputTokens = raw.cachedReadTokens;
  const cacheCreationTokens = raw.cachedWriteTokens;
  // Agents disagree on whether `inputTokens` already contains the cached part.
  // The total settles it: when it only adds up with the cache counted on top,
  // the cache was reported separately and belongs in the input.
  const cache = (cachedInputTokens ?? 0) + (cacheCreationTokens ?? 0);
  const total = raw.totalTokens;
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
      raw.reasoningTokens !== undefined && outputTokens !== undefined
        ? Math.min(outputTokens, raw.reasoningTokens)
        : undefined,
  };
}

/** Reads and interprets the usage of a `session/prompt` response. */
export function readAcpPromptUsage(result: unknown): AcpTurnUsageCounts | undefined {
  const raw = readAcpRawPromptUsage(result);
  return raw === undefined ? undefined : normalizeAcpPromptUsage(raw);
}

/**
 * GitHub Copilot answers each `session/prompt` with the running totals of its
 * live session, not what that prompt used: consecutive prompts of one process
 * only ever rise, and the counters start again in a new process. Given the
 * previous totals of the same live session, this returns what the prompt
 * itself reported using, as raw counts to interpret afterwards (so a cache
 * reported on top of input is judged on the prompt's own numbers). Without a
 * baseline (first prompt of the process), or when any count fell (the
 * counters were reset), the reported totals are the usage. `complete` is
 * false when a count the prompt reports was missing from the baseline, since
 * it cannot be subtracted and stays unknown.
 */
export function acpSessionUsageIncrease(
  baseline: AcpRawPromptUsage | undefined,
  totals: AcpRawPromptUsage,
): { readonly usage: AcpRawPromptUsage; readonly complete: boolean } {
  if (!baseline) return { usage: totals, complete: true };
  const fell = RAW_KEYS.some((key) => {
    const before = baseline[key];
    const now = totals[key];
    return before !== undefined && now !== undefined && now < before;
  });
  if (fell) return { usage: totals, complete: true };
  let complete = true;
  const increase = (key: (typeof RAW_KEYS)[number]) => {
    const before = baseline[key];
    const now = totals[key];
    if (now === undefined) return undefined;
    if (before === undefined) {
      complete = false;
      return undefined;
    }
    return now - before;
  };
  const usage: AcpRawPromptUsage = {
    inputTokens: increase("inputTokens"),
    outputTokens: increase("outputTokens"),
    cachedReadTokens: increase("cachedReadTokens"),
    cachedWriteTokens: increase("cachedWriteTokens"),
    reasoningTokens: increase("reasoningTokens"),
    totalTokens: increase("totalTokens"),
  };
  return { usage, complete };
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
  /** False when the counts may hold usage of another prompt or miss some of this one. */
  countsAreThisTurns = true,
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
    countsAreThisTurns &&
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
