import type { UsageBucket, UsageProviderKind } from "@specweave-studio/contracts";
import { costCoverage } from "@specweave-studio/shared/usageMerge";
import { formatUsd } from "@specweave-studio/shared/usageFormat";

/** A day (`YYYY-MM-DD`) or an hour (UTC start instant) pinned from the chart. */
export type UsagePinnedPeriod =
  | { readonly kind: "day"; readonly day: string }
  | { readonly kind: "hour"; readonly hourStart: string };

export interface UsageFilters {
  /** Empty means every provider. */
  readonly providers: ReadonlySet<UsageProviderKind>;
  readonly period: UsagePinnedPeriod | null;
  readonly modelQuery: string;
}

export const NO_USAGE_FILTERS: UsageFilters = {
  providers: new Set(),
  period: null,
  modelQuery: "",
};

export function hasUsageFilters(filters: UsageFilters): boolean {
  return filters.providers.size > 0 || filters.period !== null || filters.modelQuery.trim() !== "";
}

/**
 * Narrows the merge to the selected providers and, with `includePeriod`, the
 * pinned period. Undefined when nothing narrows, so the full merge is reused.
 */
export function usageBucketFilter(
  filters: UsageFilters,
  includePeriod: boolean,
): ((bucket: UsageBucket) => boolean) | undefined {
  const period = includePeriod ? filters.period : null;
  if (filters.providers.size === 0 && period === null) return undefined;
  return (bucket) =>
    (filters.providers.size === 0 || filters.providers.has(bucket.provider)) &&
    (period === null ||
      (period.kind === "day" ? bucket.day === period.day : bucket.hourStart === period.hourStart));
}

/**
 * The first click on a provider isolates it; later clicks add or remove one.
 * Removing the last selected provider, or selecting all of them, shows all.
 */
export function toggleUsageProvider(
  selected: ReadonlySet<UsageProviderKind>,
  provider: UsageProviderKind,
  available: readonly UsageProviderKind[],
): ReadonlySet<UsageProviderKind> {
  const next = new Set(selected);
  if (next.has(provider)) next.delete(provider);
  else next.add(provider);
  return available.length > 0 && available.every((entry) => next.has(entry)) ? new Set() : next;
}

/** Case-insensitive match on any space-separated words of the query. */
export function matchesModelQuery(model: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = model.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface CostText {
  readonly text: string;
  /** Spoken and hover form when `text` is abbreviated or qualified. */
  readonly label: string;
  readonly tone: "value" | "muted";
}

/**
 * A dollar figure that never shows unknown as zero: all-unpriced reads
 * "Unpriced", partly unpriced is a lower bound, and no activity is a dash.
 */
export function costText(
  entry:
    | { readonly costUsd: number; readonly records: number; readonly unpricedRecords: number }
    | undefined,
): CostText {
  switch (costCoverage(entry)) {
    case "none":
      return { text: "—", label: "No usage", tone: "muted" };
    case "unknown":
      return { text: "Unpriced", label: "Unpriced: no rates for these tokens", tone: "muted" };
    case "partial": {
      const value = formatUsd(entry!.costUsd);
      return {
        text: `≥ ${value}`,
        label: `At least ${value}; some tokens have no rates`,
        tone: "value",
      };
    }
    default: {
      const value = formatUsd(entry!.costUsd);
      return { text: value, label: value, tone: "value" };
    }
  }
}
