import type { NativeTool } from "@specweave-studio/contracts";

/** What one tool's column shows for a server: its declared state, or why there is none. */
export type CellTone = "configured" | "disabled" | "invalid" | "none" | "unknown";
export type StatusFilter = "all" | "enabled" | "disabled" | "missing" | "invalid";

export interface FilterRow {
  readonly name: string;
  /** Plugin labels and folder names, so a search for "GitHub" finds the plugin's servers. */
  readonly aliases: ReadonlyArray<string>;
  /** One tone per visible tool column. */
  readonly tones: ReadonlyArray<CellTone>;
}

const declared = (tone: CellTone) =>
  tone === "configured" || tone === "disabled" || tone === "invalid";

export function matchesStatus(tones: ReadonlyArray<CellTone>, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "enabled":
      return tones.includes("configured");
    case "disabled":
      return tones.includes("disabled");
    case "invalid":
      return tones.includes("invalid");
    case "missing":
      // Declared in one visible tool and absent from another: the gap to close.
      return tones.some(declared) && tones.includes("none");
  }
}

export function matchesQuery(row: FilterRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, ...row.aliases].some((text) => text.toLowerCase().includes(needle));
}

/**
 * Rows a filter keeps, enabled-first. A row with no declaration in any visible
 * column drops out, so narrowing to one tool lists only that tool's servers.
 */
export function filterRows<Row extends FilterRow>(
  rows: ReadonlyArray<Row>,
  query: string,
  status: StatusFilter,
): Row[] {
  return rows
    .filter((row) => row.tones.some((t) => t !== "none") && matchesQuery(row, query))
    .filter((row) => matchesStatus(row.tones, status))
    .sort(
      (a, b) =>
        enabledCount(b) - enabledCount(a) ||
        declaredCount(b) - declaredCount(a) ||
        a.name.localeCompare(b.name),
    );
}

const enabledCount = (row: FilterRow) => row.tones.filter((t) => t === "configured").length;
const declaredCount = (row: FilterRow) => row.tones.filter(declared).length;

/** Status chip counts over the rows the search and tool filters leave. */
export function statusCounts(
  rows: ReadonlyArray<FilterRow>,
  query: string,
): Record<StatusFilter, number> {
  const visible = rows.filter(
    (row) => row.tones.some((t) => t !== "none") && matchesQuery(row, query),
  );
  const count = (status: StatusFilter) =>
    visible.filter((row) => matchesStatus(row.tones, status)).length;
  return {
    all: visible.length,
    enabled: count("enabled"),
    disabled: count("disabled"),
    missing: count("missing"),
    invalid: count("invalid"),
  };
}

/**
 * Tool chips: none chosen means every tool. Picking a chip while all show
 * narrows to that tool; later picks add or remove; removing the last shows all.
 */
export function toggleTool(
  chosen: ReadonlyArray<NativeTool> | null,
  tool: NativeTool,
): ReadonlyArray<NativeTool> | null {
  if (chosen === null) return [tool];
  const next = chosen.includes(tool) ? chosen.filter((t) => t !== tool) : [...chosen, tool];
  return next.length === 0 ? null : next;
}
