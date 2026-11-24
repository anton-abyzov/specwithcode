import type { UsageBucket } from "@specweave-studio/contracts";
import { costCoverage } from "@specweave-studio/shared/usageMerge";
import { formatUsd } from "@specweave-studio/shared/usageFormat";

import { driverOfUsageKind, keepsDriver } from "./usageScope";

/** A day (`YYYY-MM-DD`) or an hour (UTC start instant) pinned from the chart. */
export type UsagePinnedPeriod =
  | { readonly kind: "day"; readonly day: string }
  | { readonly kind: "hour"; readonly hourStart: string };

export interface UsageFilters {
  /** Driver kinds (`claudeAgent`, `codex`, `copilot`, ...); empty means every provider. */
  readonly drivers: ReadonlySet<string>;
  /** Project titles; empty means every project. Only Delivered and Machines apply it. */
  readonly projects: ReadonlySet<string>;
  readonly period: UsagePinnedPeriod | null;
  readonly modelQuery: string;
}

export const NO_USAGE_FILTERS: UsageFilters = {
  drivers: new Set(),
  projects: new Set(),
  period: null,
  modelQuery: "",
};

export function hasUsageFilters(filters: UsageFilters): boolean {
  return (
    filters.drivers.size > 0 ||
    filters.projects.size > 0 ||
    filters.period !== null ||
    filters.modelQuery.trim() !== ""
  );
}

/**
 * Narrows the merge to the selected providers and models and, with
 * `includePeriod`, the pinned period. Undefined when nothing narrows, so the
 * full merge is reused.
 */
export function usageBucketFilter(
  filters: UsageFilters,
  includePeriod: boolean,
): ((bucket: UsageBucket) => boolean) | undefined {
  const period = includePeriod ? filters.period : null;
  const query = filters.modelQuery.trim();
  if (filters.drivers.size === 0 && period === null && query === "") return undefined;
  return (bucket) =>
    keepsDriver(filters.drivers, driverOfUsageKind(bucket.provider)) &&
    (query === "" || matchesModelQuery(bucket.model, query)) &&
    (period === null ||
      (period.kind === "day" ? bucket.day === period.day : bucket.hourStart === period.hourStart));
}

/**
 * The first click on a provider isolates it; later clicks add or remove one.
 * Removing the last selected provider, or selecting all of them, shows all.
 */
export function toggleUsageProvider<T extends string>(
  selected: ReadonlySet<T>,
  provider: T,
  available: readonly T[],
): ReadonlySet<T> {
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
