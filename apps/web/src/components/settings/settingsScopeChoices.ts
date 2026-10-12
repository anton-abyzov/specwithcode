/** A target the scope chooser offers: what it says, and what it matches when typed. */
export interface ScopeChoiceText {
  readonly label: string;
  readonly detail: string | null;
}

/** Rows shown per page; past this the chooser pages instead of growing. */
export const SCOPE_CHOICE_PAGE_SIZE = 8;
/** Below this many choices the list is short enough to scan without a search box. */
export const SCOPE_CHOICE_SEARCH_MIN = 7;

/** Every typed word must appear in the label or the detail, in any order and case. */
export function filterScopeChoices<T extends ScopeChoiceText>(
  choices: readonly T[],
  query: string,
): readonly T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return choices;
  return choices.filter((choice) => {
    const text = `${choice.label} ${choice.detail ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface ScopeChoicePage<T> {
  readonly items: readonly T[];
  /** Zero-based, clamped into range so a shrinking list never shows an empty page. */
  readonly page: number;
  readonly pageCount: number;
  /** One-based position of the first row shown, 0 when there are none. */
  readonly first: number;
  readonly last: number;
  readonly total: number;
}

export function pageScopeChoices<T>(
  choices: readonly T[],
  page: number,
  size: number = SCOPE_CHOICE_PAGE_SIZE,
): ScopeChoicePage<T> {
  const total = choices.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = current * size;
  const items = choices.slice(start, start + size);
  return {
    items,
    page: current,
    pageCount,
    first: items.length === 0 ? 0 : start + 1,
    last: start + items.length,
    total,
  };
}
