import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import {
  PROJECT_SETTINGS_TAB_LABELS,
  searchProjectSettings,
  type ProjectSettingsSearchResult,
  type ProjectSettingsTab,
} from "./projectSettingsSearch.logic";

/**
 * Search above the Project settings sections. While a query is typed, the tab
 * list gives way to results: each matching section as a root, its rows under it.
 */
export function ProjectSettingsSearch({
  tabs,
  onPick,
  children,
}: {
  tabs: readonly ProjectSettingsTab[];
  onPick: (result: ProjectSettingsSearchResult) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchProjectSettings(query, tabs), [query, tabs]);
  const searching = query.trim().length > 0;
  useEffect(() => setActive(0), [query]);

  const pick = (result: ProjectSettingsSearchResult | undefined) => {
    if (!result) return;
    setQuery("");
    onPick(result);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && searching) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(results[active]);
    }
  };

  return (
    <>
      <div className="project-settings-search">
        <SearchIcon size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Search"
          aria-label="Search project settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searching && results.length > 0}
          aria-controls={searching ? "project-settings-search-results" : undefined}
          aria-activedescendant={
            searching && results[active]
              ? `project-settings-result-${results[active].id}`
              : undefined
          }
        />
        {searching ? (
          <button
            type="button"
            aria-label="Clear project settings search"
            onClick={() => setQuery("")}
          >
            <XIcon size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {!searching ? (
        children
      ) : results.length === 0 ? (
        <p role="status" className="project-muted px-2 py-4 text-center text-xs">
          No settings found
        </p>
      ) : (
        <div
          id="project-settings-search-results"
          role="listbox"
          aria-label="Project settings search results"
          className="project-settings-search-results"
        >
          {results.map((result, index) => (
            <div
              key={result.id}
              id={`project-settings-result-${result.id}`}
              role="option"
              aria-selected={index === active}
              data-search-result-kind={result.kind}
              className="project-settings-search-result"
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(result)}
            >
              {result.kind === "section"
                ? PROJECT_SETTINGS_TAB_LABELS[result.section]
                : result.row.title}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
