import type { Dispatch, SetStateAction } from "react";
import { Button, InlineButton } from "../ui/button";
import { NO_USAGE_FILTERS, hasUsageFilters, type UsageFilters } from "./usageFilters";
import { PROVIDER_PRESENTATION } from "./usageProviders";
export function UsageFilterBar({
  filters,
  setFilters,
  periodLabel,
}: {
  readonly filters: UsageFilters;
  readonly setFilters: Dispatch<SetStateAction<UsageFilters>>;
  readonly periodLabel: string | null;
}) {
  if (!hasUsageFilters(filters)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Active usage filters">
      {[...filters.providers].map((provider) => (
        <Button
          key={provider}
          size="xs"
          variant="outline"
          aria-label={`Remove ${PROVIDER_PRESENTATION[provider].label} filter`}
          onClick={() =>
            setFilters((current) => ({
              ...current,
              providers: new Set([...current.providers].filter((value) => value !== provider)),
            }))
          }
        >
          {PROVIDER_PRESENTATION[provider].label} ×
        </Button>
      ))}
      {periodLabel ? (
        <Button
          size="xs"
          variant="outline"
          aria-label="Clear pinned period"
          onClick={() => setFilters((current) => ({ ...current, period: null }))}
        >
          {periodLabel} ×
        </Button>
      ) : null}
      {filters.modelQuery ? (
        <Button
          size="xs"
          variant="outline"
          aria-label="Clear model search"
          onClick={() => setFilters((current) => ({ ...current, modelQuery: "" }))}
        >
          Model: {filters.modelQuery} ×
        </Button>
      ) : null}
      <InlineButton onClick={() => setFilters(NO_USAGE_FILTERS)}>Clear filters</InlineButton>
    </div>
  );
}
