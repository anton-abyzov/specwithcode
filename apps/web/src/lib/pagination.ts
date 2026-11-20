/** One page of a list that was already filtered and sorted. */
export interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  /** The page shown, 1-based, after clamping to what the list holds. */
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  /** How many items the whole filtered list holds. */
  readonly total: number;
  /** 1-based position of the first and last item shown; both 0 for an empty list. */
  readonly from: number;
  readonly to: number;
}

/**
 * Slices `items` for `page`. Filter and sort first: the counts here describe the
 * list passed in. A page past the end, such as after a rescan that found fewer
 * items, falls back to the last page instead of an empty one.
 */
export function paginate<Item>(
  items: ReadonlyArray<Item>,
  page: number,
  pageSize: number,
): Page<Item> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(1, wanted), pageCount);
  const start = (current - 1) * size;
  const shown = items.slice(start, start + size);
  return {
    items: shown,
    page: current,
    pageCount,
    pageSize: size,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + shown.length,
  };
}

/** The 1-based page that holds the item at `index`, or 1 when it is not in the list. */
export function pageOfIndex(index: number, pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1;
  return index < 0 ? 1 : Math.floor(index / size) + 1;
}
