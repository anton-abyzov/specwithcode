/**
 * Project usage as filterable facts. Studio threads and folder CLI sessions
 * become one flat list of (source, harness, model) rows, so the summary,
 * share bar, model table and trend all answer the same filtered question.
 *
 * Model ids are normalized before grouping: `claude-opus-5.5`,
 * `claude-opus-5-5[1m]` and `anthropic/claude-opus-5-5-20261001` are one
 * model, read as "Claude Opus 5.5".
 */
import type { ProjectUsageSummary, ProjectUsageTotals } from "@specweave-studio/contracts";

import { cliOfDriver, providerLabel } from "./projectUsageModel";

export type UsageSource = "coordinator" | "thread" | "cli";
export type SourceFilter = "all" | UsageSource;

export interface UsageFact {
  readonly source: UsageSource;
  /** claude, codex, copilot, grok, or a driver kind for anything else. */
  readonly harness: string;
  /** Normalized model key; null when the run did not report one. */
  readonly model: string | null;
  readonly totals: ProjectUsageTotals;
}

export interface UsageDayFact {
  readonly day: string;
  readonly source: UsageSource;
  readonly harness: string;
  readonly model: string | null;
  readonly totalTokens: number;
}

export interface UsageFilters {
  readonly source: SourceFilter;
  readonly harness: string;
  /** A model family label, or "all". */
  readonly family: string;
}

export const ALL_FILTERS: UsageFilters = { source: "all", harness: "all", family: "all" };

export const SOURCE_LABELS: Record<UsageSource, string> = {
  coordinator: "Coordinator",
  thread: "Threads",
  cli: "CLI sessions",
};

export const NOT_REPORTED_FAMILY = "Model not reported";
/** The agent picked the model itself and did not say which. */
export const AUTO_MODEL = "Chosen by the agent";

/** One key per model, whatever spelling, vendor prefix, date or context suffix it came with. */
export function normalizeModelId(model: string | null | undefined): string | null {
  if (!model) return null;
  let id = model.trim().toLowerCase();
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/^(?:[a-z]{2}\.)?(?:anthropic|openai|google|meta|xai)\./, "");
  id = id.replace(/\[[^\]]*\]$/, "");
  id = id.replace(/-v\d+:\d+$/, "");
  // Dated snapshots read as their model, in either vendor's date style.
  id = id.replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  id = id.replace(/(\d)\.(?=\d)/g, "$1-");
  id = id.replace(/[\s_]+/g, "-");
  return id.length > 0 ? id : null;
}

const WORDS: Record<string, string> = { gpt: "GPT", glm: "GLM", oss: "OSS", ai: "AI" };
const word = (token: string) => WORDS[token] ?? token.charAt(0).toUpperCase() + token.slice(1);

/** Readable name: `claude-opus-5-5` is "Claude Opus 5.5", `gpt-5-1-codex` is "GPT-5.1 Codex". */
export function modelLabel(model: string | null): string {
  if (model === null) return NOT_REPORTED_FAMILY;
  if (model === "auto" || model === "default") return AUTO_MODEL;
  const parts: string[] = [];
  let version: string[] = [];
  const flush = () => {
    if (version.length === 0) return;
    const joined = version.join(".");
    // GPT and o-series names hold their version: GPT-5.1.
    if (parts.at(-1) === "GPT") parts[parts.length - 1] = `GPT-${joined}`;
    else parts.push(joined);
    version = [];
  };
  for (const token of model.split("-").filter(Boolean)) {
    if (/^\d+$/.test(token)) version.push(token);
    else {
      flush();
      parts.push(word(token));
    }
  }
  flush();
  return parts.join(" ");
}

/** The family a model is filtered by: "Claude Opus", "GPT-5", "Gemini", "Grok". */
export function modelFamily(model: string | null): string {
  if (model === null) return NOT_REPORTED_FAMILY;
  if (model === "auto" || model === "default") return AUTO_MODEL;
  const tokens = model.split("-").filter(Boolean);
  const [head = model, next] = tokens;
  if (head === "claude") {
    const tier = tokens.find((token, index) => index > 0 && !/^\d+$/.test(token));
    return tier ? `Claude ${word(tier)}` : "Claude";
  }
  if (head === "gpt") return next && /^\d+$/.test(next) ? `GPT-${next}` : "GPT";
  if (/^o\d+$/.test(head)) return "OpenAI o-series";
  if (head === "llama" || head === "meta") return "Llama";
  return word(head);
}

function sourceOfRole(role: "coordinator" | "worker"): UsageSource {
  return role === "coordinator" ? "coordinator" : "thread";
}

/** Every measured row of the summary, threads split by model where the server reports it. */
export function usageFacts(summary: ProjectUsageSummary): readonly UsageFact[] {
  const facts: UsageFact[] = [];
  const split = summary.threads.length > 0 && summary.threads.every((t) => t.models !== undefined);
  if (split) {
    for (const thread of summary.threads) {
      for (const row of thread.models ?? []) {
        facts.push({
          source: sourceOfRole(thread.role),
          harness: cliOfDriver(row.provider, row.providerInstanceId),
          model: normalizeModelId(row.model),
          totals: row.totals,
        });
      }
    }
  } else {
    // An older server: models are not split by thread, so they read as threads.
    for (const row of summary.models) {
      facts.push({
        source: "thread",
        harness: cliOfDriver(row.provider, row.providerInstanceId),
        model: normalizeModelId(row.model),
        totals: row.totals,
      });
    }
  }
  for (const row of summary.folderSessions?.models ?? []) {
    facts.push({
      source: "cli",
      harness: row.provider,
      model: normalizeModelId(row.model),
      totals: row.totals,
    });
  }
  return facts.filter((fact) => fact.totals.totalTokens > 0);
}

export function usageDayFacts(summary: ProjectUsageSummary): readonly UsageDayFact[] {
  const facts: UsageDayFact[] = [];
  for (const row of summary.daily ?? []) {
    facts.push({
      day: row.day,
      source: sourceOfRole(row.role),
      harness: cliOfDriver(row.provider, row.providerInstanceId),
      model: normalizeModelId(row.model),
      totalTokens: row.totalTokens,
    });
  }
  for (const row of summary.folderSessions?.daily ?? []) {
    facts.push({
      day: row.day,
      source: "cli",
      harness: row.provider,
      model: normalizeModelId(row.model),
      totalTokens: row.totalTokens,
    });
  }
  return facts.filter((fact) => fact.totalTokens > 0);
}

export function matches(
  fact: { readonly source: UsageSource; readonly harness: string; readonly model: string | null },
  filters: UsageFilters,
): boolean {
  return (
    (filters.source === "all" || fact.source === filters.source) &&
    (filters.harness === "all" || fact.harness === filters.harness) &&
    (filters.family === "all" || modelFamily(fact.model) === filters.family)
  );
}

const ZERO: ProjectUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  equivalentCostUsd: null,
};

function addTotals(a: ProjectUsageTotals, b: ProjectUsageTotals): ProjectUsageTotals {
  const both = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left + right;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: both(a.cachedInputTokens, b.cachedInputTokens),
    cacheCreationTokens: both(a.cacheCreationTokens, b.cacheCreationTokens),
    reasoningTokens: both(a.reasoningTokens, b.reasoningTokens),
    equivalentCostUsd:
      a.equivalentCostUsd === null && b.equivalentCostUsd === null
        ? null
        : (a.equivalentCostUsd ?? 0) + (b.equivalentCostUsd ?? 0),
  };
}

export function sumFacts(facts: readonly UsageFact[]): ProjectUsageTotals {
  return facts.reduce((sum, fact) => addTotals(sum, fact.totals), ZERO);
}

export interface UsageGroup {
  readonly key: string;
  readonly label: string;
  readonly totals: ProjectUsageTotals;
  readonly share: number;
  /** Harnesses (for models) or sources (for harnesses) the tokens came through. */
  readonly via: readonly string[];
}

function group(
  facts: readonly UsageFact[],
  keyOf: (fact: UsageFact) => string,
  labelOf: (key: string) => string,
  viaOf: (fact: UsageFact) => string,
): readonly UsageGroup[] {
  const total = facts.reduce((sum, fact) => sum + fact.totals.totalTokens, 0);
  const groups = new Map<string, { totals: ProjectUsageTotals; via: Set<string> }>();
  for (const fact of facts) {
    const key = keyOf(fact);
    const current = groups.get(key) ?? { totals: ZERO, via: new Set<string>() };
    current.totals = addTotals(current.totals, fact.totals);
    current.via.add(viaOf(fact));
    groups.set(key, current);
  }
  return [...groups]
    .map(([key, value]) => ({
      key,
      label: labelOf(key),
      totals: value.totals,
      share: total > 0 ? value.totals.totalTokens / total : 0,
      via: [...value.via].sort(),
    }))
    .filter((row) => row.totals.totalTokens > 0)
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label));
}

export function groupByHarness(facts: readonly UsageFact[]): readonly UsageGroup[] {
  return group(
    facts,
    (fact) => fact.harness,
    providerLabel,
    (fact) => SOURCE_LABELS[fact.source],
  );
}

const NO_MODEL = "\0none";

/** One row per normalized model; unreported models fold into one row. */
export function groupByModel(facts: readonly UsageFact[]): readonly UsageGroup[] {
  return group(
    facts,
    (fact) => fact.model ?? NO_MODEL,
    (key) => modelLabel(key === NO_MODEL ? null : key),
    (fact) => providerLabel(fact.harness),
  );
}

/** Filter options that have measured tokens, largest first. */
export function filterOptions(facts: readonly UsageFact[]): {
  readonly sources: readonly UsageSource[];
  readonly harnesses: readonly { readonly value: string; readonly label: string }[];
  readonly families: readonly string[];
} {
  const sources = (["coordinator", "thread", "cli"] as const).filter((source) =>
    facts.some((fact) => fact.source === source),
  );
  const harnesses = groupByHarness(facts).map((row) => ({ value: row.key, label: row.label }));
  const families = new Map<string, number>();
  for (const fact of facts) {
    const family = modelFamily(fact.model);
    families.set(family, (families.get(family) ?? 0) + fact.totals.totalTokens);
  }
  return {
    sources,
    harnesses,
    families: [...families]
      .sort(
        ([a, left], [b, right]) =>
          Number(a === NOT_REPORTED_FAMILY) - Number(b === NOT_REPORTED_FAMILY) || right - left,
      )
      .map(([family]) => family),
  };
}

export interface TrendDay {
  readonly day: string;
  readonly threads: number;
  readonly cli: number;
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + delta);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `count` consecutive days ending on `lastDay`, zero-filled, split into Studio threads and CLI. */
export function trendDays(
  facts: readonly UsageDayFact[],
  lastDay: string,
  count: number,
): readonly TrendDay[] {
  const days = Array.from({ length: count }, (_, index) => shiftDay(lastDay, index - count + 1));
  const byDay = new Map(days.map((day) => [day, { day, threads: 0, cli: 0 }]));
  for (const fact of facts) {
    const entry = byDay.get(fact.day);
    if (!entry) continue;
    if (fact.source === "cli") entry.cli += fact.totalTokens;
    else entry.threads += fact.totalTokens;
  }
  return days.map((day) => byDay.get(day)!);
}

/** Last `window` days against the `window` before them; null when the earlier window is empty. */
export function periodChange(
  days: readonly TrendDay[],
  window: number,
): { readonly recent: number; readonly previous: number; readonly change: number | null } {
  const sum = (slice: readonly TrendDay[]) =>
    slice.reduce((total, day) => total + day.threads + day.cli, 0);
  const recent = sum(days.slice(-window));
  const previous = sum(days.slice(-2 * window, -window));
  return { recent, previous, change: previous > 0 ? (recent - previous) / previous : null };
}

export function localToday(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
