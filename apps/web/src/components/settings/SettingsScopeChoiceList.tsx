import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Tip } from "../studio/shell/Tip";
import { Button } from "../ui/button";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  filterScopeChoices,
  pageScopeChoices,
  SCOPE_CHOICE_SEARCH_MIN,
  type ScopeChoiceText,
} from "./settingsScopeChoices";

export interface ScopeChoice extends ScopeChoiceText {
  readonly key: string;
  readonly icon: ReactNode;
  /** A short state such as "Archived", shown at the end of the row. */
  readonly badge?: string | undefined;
}

/**
 * A searchable, paged list of settings targets. A project list grows with every
 * folder ever opened, so a flat row of buttons stops being scannable quickly.
 */
export function SettingsScopeChoiceList<T extends ScopeChoice>({
  choices,
  noun,
  onPick,
}: {
  choices: readonly T[];
  /** Plural name of what is listed, used in the search label and counts. */
  noun: string;
  onPick: (choice: T) => void;
}) {
  const tx = useTx();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const matches = filterScopeChoices(choices, query);
  const view = pageScopeChoices(matches, page);
  return (
    <div className="flex flex-col gap-2">
      {/* A typed query keeps its box so it can always be cleared. */}
      {choices.length >= SCOPE_CHOICE_SEARCH_MIN || query !== "" ? (
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={`Search ${noun}`}
            placeholder={`Search ${choices.length} ${noun}`}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(0);
            }}
          />
        </InputGroup>
      ) : null}
      {view.items.length === 0 ? (
        <p role="status" className="px-1 py-3 text-sm text-muted-foreground">
          {renderRich(tx("No {noun} match “{value}”."), { noun: noun, value: query.trim() })}
        </p>
      ) : (
        <DiscoveryList>
          {view.items.map((choice) => (
            <Tip
              key={choice.key}
              side="top"
              label={choice.detail ? `${choice.label} · ${choice.detail}` : choice.label}
            >
              <DiscoveryListRow
                icon={
                  <span className="flex size-6 shrink-0 items-center justify-center">
                    {choice.icon}
                  </span>
                }
                title={choice.label}
                description={choice.detail ?? ""}
                action={
                  <span className="flex shrink-0 items-center gap-2">
                    {choice.badge ? (
                      <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                        {choice.badge}
                      </span>
                    ) : null}
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </span>
                }
                onClick={() => onPick(choice)}
              />
            </Tip>
          ))}
        </DiscoveryList>
      )}
      {view.pageCount > 1 ? (
        <nav
          aria-label={`${noun} pages`}
          className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground"
        >
          <span aria-live="polite">
            {renderRich(tx("{first}–{last} of {total}"), {
              first: view.first,
              last: view.last,
              total: view.total,
            })}
          </span>
          <span className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={tx("Previous page")}
              disabled={view.page === 0}
              onClick={() => setPage(view.page - 1)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span>
              {renderRich(tx("Page {value} of {pageCount}"), {
                value: view.page + 1,
                pageCount: view.pageCount,
              })}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={tx("Next page")}
              disabled={view.page >= view.pageCount - 1}
              onClick={() => setPage(view.page + 1)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </span>
        </nav>
      ) : null}
    </div>
  );
}
