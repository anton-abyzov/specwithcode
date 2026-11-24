import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { NO_USAGE_FILTERS, hasUsageFilters, type UsageFilters } from "./usageFilters";
import { FILTER_SUPPORT, driverLabel } from "./usageScope";
import type { UsageMetric } from "./usageShortcuts";

function selectionLabel(name: string, selected: readonly string[]): string {
  if (selected.length === 0) return `${name}: All`;
  if (selected.length <= 2) return `${name}: ${selected.join(", ")}`;
  return `${name}: ${selected.length} selected`;
}

function MultiSelectMenu({
  name,
  options,
  selected,
  labelOf,
  onChange,
}: {
  readonly name: string;
  readonly options: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly labelOf: (value: string) => string;
  readonly onChange: (next: ReadonlySet<string>) => void;
}) {
  const active = selected.size > 0;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant={active ? "secondary" : "outline"}
            aria-label={`${name} filter`}
          />
        }
      >
        {selectionLabel(name, [...selected].map(labelOf))}
        <ChevronDownIcon aria-hidden className="size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={!active}
          closeOnClick={false}
          onCheckedChange={(checked) => {
            if (checked) onChange(new Set());
          }}
        >
          All
        </MenuCheckboxItem>
        <MenuSeparator />
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">None on these machines</p>
        ) : null}
        {options.map((option) => (
          <MenuCheckboxItem
            key={option}
            checked={selected.has(option)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked) next.add(option);
              else next.delete(option);
              onChange(next.size === options.length ? new Set() : next);
            }}
          >
            {labelOf(option)}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The page's filters, shown on every tab (1456): Providers, Model search and
 * Project, the pinned chart period, and one line for each active filter the
 * tab cannot apply, so nothing is ignored silently.
 */
export function UsageScopeBar({
  metric,
  filters,
  setFilters,
  driverOptions,
  projectOptions,
  periodLabel,
  notes,
  actions,
}: {
  readonly metric: UsageMetric;
  readonly filters: UsageFilters;
  readonly setFilters: Dispatch<SetStateAction<UsageFilters>>;
  readonly driverOptions: readonly string[];
  readonly projectOptions: readonly string[];
  readonly periodLabel: string | null;
  readonly notes: readonly string[];
  readonly actions?: ReactNode;
}) {
  const support = FILTER_SUPPORT[metric];
  const showProject = support.project === true || filters.projects.size > 0;
  return (
    <div className="mb-5 flex flex-col gap-2" aria-label="Usage filters">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <MultiSelectMenu
          name="Providers"
          options={driverOptions}
          selected={filters.drivers}
          labelOf={driverLabel}
          onChange={(drivers) => setFilters((current) => ({ ...current, drivers }))}
        />
        <input
          aria-label="Search models"
          placeholder="Search models…"
          type="search"
          value={filters.modelQuery}
          onChange={(event) =>
            setFilters((current) => ({ ...current, modelQuery: event.target.value }))
          }
          onKeyDown={(event) => {
            // Escape clears the search; it must not leave the page or unpin.
            if (event.key !== "Escape" || filters.modelQuery === "") return;
            event.preventDefault();
            event.stopPropagation();
            setFilters((current) => ({ ...current, modelQuery: "" }));
          }}
          className={cn(
            "h-7 w-44 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            filters.modelQuery !== "" && "border-primary/40",
          )}
        />
        {showProject ? (
          <MultiSelectMenu
            name="Project"
            options={projectOptions}
            selected={filters.projects}
            labelOf={(title) => title}
            onChange={(projects) => setFilters((current) => ({ ...current, projects }))}
          />
        ) : null}
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
        {hasUsageFilters(filters) ? (
          <InlineButton onClick={() => setFilters(NO_USAGE_FILTERS)}>Clear filters</InlineButton>
        ) : null}
        {actions ? <span className="ms-auto flex items-center gap-2">{actions}</span> : null}
      </div>
      {notes.length > 0 ? (
        <ul
          aria-label="Filter notes"
          className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
        >
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
