import { type SheetEvaluation, isSheetError } from "./formula.ts";
import {
  type CellRange,
  type SheetChart,
  type SheetChartAggregate,
  type SheetChartSort,
  type SheetChartType,
  type SheetDocument,
  type SheetTab,
  SHEET_LIMITS,
  columnLetters,
  parseCellAddress,
  parseTabRange,
  rangeName,
  usedRange,
} from "./model.ts";

export interface SheetChartPoint {
  readonly label: string;
  readonly value: number;
  /** Share of the positive total, 0 to 1. */
  readonly share: number;
}

export interface SheetChartOverrides {
  readonly aggregate?: SheetChartAggregate;
  readonly sort?: SheetChartSort;
  readonly topN?: number;
  readonly filterValues?: ReadonlyArray<string>;
}

export interface SheetChartSeries {
  readonly points: ReadonlyArray<SheetChartPoint>;
  readonly total: number;
  readonly max: number;
  readonly min: number;
  /** Distinct filter values from filterRange (or labels) before filtering. */
  readonly availableFilters: ReadonlyArray<string>;
  /** Why nothing can be drawn, when points is empty. */
  readonly problem: "range" | "empty" | null;
}

/**
 * Coordinate at 0-based reading-order `index` inside `range`, or null when out
 * of bounds. Works in O(1) over arbitrarily large or sparse ranges.
 */
function cellAtReadingIndex(
  range: CellRange,
  index: number,
): { readonly col: number; readonly row: number } | null {
  if (index < 0) return null;
  const byColumn = range.end.col === range.start.col || range.end.row !== range.start.row;
  if (byColumn) {
    const height = range.end.row - range.start.row + 1;
    const width = range.end.col - range.start.col + 1;
    if (index >= width * height) return null;
    const colOffset = Math.floor(index / height);
    const rowOffset = index % height;
    return { col: range.start.col + colOffset, row: range.start.row + rowOffset };
  }
  const width = range.end.col - range.start.col + 1;
  if (index >= width) return null;
  return { col: range.start.col + index, row: range.start.row };
}

/**
 * Populated cells of `tab` that fall inside `range`, paired with their exact
 * 0-based reading-order index inside `range` and sorted in reading order.
 * Avoids enumerating empty cells in huge sparse ranges (e.g. A1:A50001).
 */
function populatedCellsInRange(
  tab: SheetTab,
  range: CellRange,
): Array<{ readonly index: number; readonly col: number; readonly row: number }> {
  const byColumn = range.end.col === range.start.col || range.end.row !== range.start.row;
  const height = range.end.row - range.start.row + 1;
  const matched: Array<{ readonly index: number; readonly col: number; readonly row: number }> = [];
  for (const addr of Object.keys(tab.cells)) {
    const parsed = parseCellAddress(addr);
    if (!parsed) continue;
    if (
      parsed.col < range.start.col ||
      parsed.col > range.end.col ||
      parsed.row < range.start.row ||
      parsed.row > range.end.row
    ) {
      continue;
    }
    const index = byColumn
      ? (parsed.col - range.start.col) * height + (parsed.row - range.start.row)
      : parsed.col - range.start.col;
    matched.push({ index, col: parsed.col, row: parsed.row });
  }
  matched.sort((a, b) => a.index - b.index);
  return matched;
}

/**
 * The points a chart draws, read from computed values. A chart holds no data of
 * its own, so it follows its cells. Supports optional filter, group-by aggregate,
 * sort, and topN transforms (from the chart definition or runtime UI overrides).
 */
export function chartSeries(
  document: SheetDocument,
  evaluation: SheetEvaluation,
  tabIndex: number,
  chart: SheetChart,
  overrides?: SheetChartOverrides,
): SheetChartSeries {
  const none = (
    problem: "range" | "empty",
    availableFilters: ReadonlyArray<string> = [],
  ): SheetChartSeries => ({
    points: [],
    total: 0,
    max: 0,
    min: 0,
    availableFilters,
    problem,
  });
  const labels = parseTabRange(chart.labels);
  const values = parseTabRange(chart.values);
  if (!labels || !values) return none("range");
  const filterParsed = chart.filterRange ? parseTabRange(chart.filterRange) : null;
  if (chart.filterRange && !filterParsed) return none("range");

  const tabOf = (name: string | null): number =>
    name === null
      ? tabIndex
      : document.tabs.findIndex((tab) => tab.name.toLowerCase() === name.toLowerCase());
  const labelTab = tabOf(labels.tab);
  const valueTab = tabOf(values.tab);
  const filterTab = filterParsed ? tabOf(filterParsed.tab) : labelTab;
  if (labelTab < 0 || valueTab < 0 || filterTab < 0) return none("range");

  const populatedValues = populatedCellsInRange(document.tabs[valueTab]!, values.range);

  const rawRows: Array<{ label: string; value: number; filterKey: string }> = [];
  const filterSeen = new Set<string>();
  const availableFilters: string[] = [];

  for (const entry of populatedValues) {
    const value = evaluation.valueAt(valueTab, entry);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const labelCell = cellAtReadingIndex(labels.range, entry.index);
    const labelValue = labelCell ? evaluation.valueAt(labelTab, labelCell) : null;
    const label = (
      labelValue === null || isSheetError(labelValue) ? String(entry.index + 1) : String(labelValue)
    ).slice(0, 80);
    let filterKey = label;
    if (filterParsed) {
      const fCell = cellAtReadingIndex(filterParsed.range, entry.index);
      const fVal = fCell ? evaluation.valueAt(filterTab, fCell) : null;
      filterKey = (fVal === null || isSheetError(fVal) ? "" : String(fVal)).trim().slice(0, 80);
    }
    if (filterKey.length > 0 && availableFilters.length < 30) {
      const norm = filterKey.toLowerCase();
      if (!filterSeen.has(norm)) {
        filterSeen.add(norm);
        availableFilters.push(filterKey);
      }
    }
    rawRows.push({ label, value, filterKey });
  }
  if (rawRows.length === 0) return none("empty", availableFilters);

  const activeFilters =
    overrides?.filterValues !== undefined ? overrides.filterValues : chart.filterValues;
  const filtered =
    activeFilters && activeFilters.length > 0
      ? (() => {
          const allowed = new Set(activeFilters.map((entry) => entry.trim().toLowerCase()));
          return rawRows.filter((row) => allowed.has(row.filterKey.trim().toLowerCase()));
        })()
      : rawRows;
  if (filtered.length === 0) return none("empty", availableFilters);

  const aggregate = overrides?.aggregate ?? chart.aggregate ?? "none";
  let points: Array<{ label: string; value: number }>;
  if (aggregate === "none") {
    points = filtered.map(({ label, value }) => ({ label, value }));
  } else {
    const groups = new Map<
      string,
      { label: string; sum: number; count: number; min: number; max: number }
    >();
    for (const row of filtered) {
      const key = row.label.trim().toLowerCase();
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          label: row.label,
          sum: row.value,
          count: 1,
          min: row.value,
          max: row.value,
        });
      } else {
        existing.sum += row.value;
        existing.count += 1;
        existing.min = Math.min(existing.min, row.value);
        existing.max = Math.max(existing.max, row.value);
      }
    }
    points = [...groups.values()].map((g) => ({
      label: g.label,
      value:
        aggregate === "sum"
          ? g.sum
          : aggregate === "avg"
            ? g.sum / g.count
            : aggregate === "count"
              ? g.count
              : aggregate === "min"
                ? g.min
                : g.max,
    }));
  }

  const sort = overrides?.sort ?? chart.sort ?? "none";
  if (sort === "value-desc") {
    points = [...points].sort((a, b) => b.value - a.value);
  } else if (sort === "value-asc") {
    points = [...points].sort((a, b) => a.value - b.value);
  } else if (sort === "label-asc") {
    points = [...points].sort((a, b) => a.label.localeCompare(b.label));
  } else if (sort === "label-desc") {
    points = [...points].sort((a, b) => b.label.localeCompare(a.label));
  }

  const topN = overrides?.topN ?? chart.topN;
  const renderLimit =
    topN !== undefined && topN >= 1
      ? Math.min(topN, SHEET_LIMITS.chartPoints)
      : SHEET_LIMITS.chartPoints;
  if (points.length > renderLimit) {
    points = points.slice(0, renderLimit);
  }

  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  return {
    points: points.map((point) => ({
      ...point,
      share: total > 0 ? Math.max(0, point.value) / total : 0,
    })),
    total,
    max: Math.max(...points.map((point) => point.value)),
    min: Math.min(...points.map((point) => point.value)),
    availableFilters,
    problem: null,
  };
}

/**
 * A chart for a selection. Two or more columns: the first is labels and the
 * last is values. One column: the cells are values and the column to its left
 * supplies labels when there is one.
 */
export function chartFromSelection(
  tab: SheetTab,
  selection: CellRange,
  type: SheetChartType,
  title: string,
): SheetChart {
  const rows = { start: selection.start.row, end: selection.end.row };
  const wide = selection.end.col > selection.start.col;
  const valueCol = selection.end.col;
  const labelCol = wide ? selection.start.col : Math.max(0, selection.start.col - 1);
  const column = (col: number): string =>
    rangeName({ start: { col, row: rows.start }, end: { col, row: rows.end } });
  const used = new Set((tab.charts ?? []).map((chart) => chart.id));
  let number = (tab.charts?.length ?? 0) + 1;
  while (used.has(`chart-${number}`)) number += 1;
  const cleanTitle = title.trim().slice(0, SHEET_LIMITS.titleChars);
  return {
    id: `chart-${number}`,
    type,
    title: cleanTitle.length > 0 ? cleanTitle : `Chart ${number}`,
    labels: column(labelCol),
    values: column(valueCol),
  };
}

/** The grid's fixed measures, in pixels; the viewer's stylesheet uses the same. */
export const SHEET_GRID = {
  rowHeight: 28,
  headerHeight: 28,
  gutterWidth: 44,
  columnWidth: 112,
  chartWidth: 520,
  chartGap: 16,
} as const;

export function sheetColumnWidth(tab: SheetTab, col: number): number {
  const width = tab.widths?.[columnLetters(col)];
  return width === undefined ? SHEET_GRID.columnWidth : Math.max(40, Math.min(600, width));
}

/** How tall a chart draws, from its kind and how many points it has. */
export function chartHeight(type: SheetChartType, points: number): number {
  if (type === "bar") return 84 + Math.max(1, Math.min(points, 40)) * 28;
  if (type === "donut") return 240;
  return 300;
}

export interface SheetChartBox {
  readonly id: string;
  /** Pixels from the grid's top-left cell corner. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Exclusive column and row bounds the grid must reach to contain the chart. */
  readonly endCol: number;
  readonly endRow: number;
}

/**
 * Where each chart of a tab sits on the grid. A chart with `at` goes there;
 * the rest sit two columns right of their data, level with it. A chart that
 * would cover an earlier one moves below it.
 */
export function layoutSheetCharts(
  tab: SheetTab,
  pointCounts: ReadonlyArray<number>,
): ReadonlyArray<SheetChartBox> {
  const charts = tab.charts ?? [];
  const used = usedRange(tab);
  const leftOf = (col: number): number => {
    let left = 0;
    for (let index = 0; index < col; index += 1) left += sheetColumnWidth(tab, index);
    return left;
  };
  const placed: SheetChartBox[] = [];
  charts.forEach((chart, index) => {
    const height = chartHeight(chart.type, pointCounts[index] ?? 0);
    let anchor = chart.at ? parseCellAddress(chart.at) : null;
    if (!anchor) {
      const values = parseTabRange(chart.values);
      const labels = parseTabRange(chart.labels);
      const local = [values, labels].filter(
        (entry): entry is NonNullable<typeof entry> =>
          entry !== null &&
          (entry.tab === null || entry.tab.toLowerCase() === tab.name.toLowerCase()),
      );
      anchor =
        local.length > 0
          ? {
              col: Math.max(...local.map((entry) => entry.range.end.col)) + 2,
              row: Math.max(0, Math.min(...local.map((entry) => entry.range.start.row)) - 1),
            }
          : { col: (used ? used.end.col : 0) + 2, row: 0 };
    }
    const col = Math.min(anchor.col, SHEET_LIMITS.columns - 1);
    const left = leftOf(col);
    let top = Math.min(anchor.row, SHEET_LIMITS.rows - 1) * SHEET_GRID.rowHeight;
    const width = SHEET_GRID.chartWidth;
    for (let pass = 0; pass <= placed.length; pass += 1) {
      const hit = placed.find(
        (box) =>
          left < box.left + box.width + SHEET_GRID.chartGap &&
          box.left < left + width + SHEET_GRID.chartGap &&
          top < box.top + box.height + SHEET_GRID.chartGap &&
          box.top < top + height + SHEET_GRID.chartGap,
      );
      if (!hit) break;
      // Down to the next row line under the chart in the way.
      top =
        Math.ceil((hit.top + hit.height + SHEET_GRID.chartGap) / SHEET_GRID.rowHeight) *
        SHEET_GRID.rowHeight;
    }
    let endCol = col;
    for (let reach = left; reach < left + width && endCol < SHEET_LIMITS.columns - 1; endCol += 1) {
      reach += sheetColumnWidth(tab, endCol);
    }
    placed.push({
      id: chart.id,
      left,
      top,
      width,
      height,
      endCol,
      endRow: Math.ceil((top + height) / SHEET_GRID.rowHeight),
    });
  });
  return placed;
}

/** A copy of the document with one more chart on a tab. */
export function addChart(
  document: SheetDocument,
  tabIndex: number,
  chart: SheetChart,
): SheetDocument {
  return {
    ...document,
    tabs: document.tabs.map((tab, index) =>
      index === tabIndex ? { ...tab, charts: [...(tab.charts ?? []), chart] } : tab,
    ),
  };
}

export function removeChart(
  document: SheetDocument,
  tabIndex: number,
  chartId: string,
): SheetDocument {
  return {
    ...document,
    tabs: document.tabs.map((tab, index) => {
      if (index !== tabIndex) return tab;
      const charts = (tab.charts ?? []).filter((chart) => chart.id !== chartId);
      const { charts: _dropped, ...rest } = tab;
      return charts.length > 0 ? { ...rest, charts } : rest;
    }),
  };
}

/** A compact number for a chart label: 1,234 or 12.5K or 3.4M. */
export function compactNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (magnitude >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (magnitude >= 10_000) return `${trim(value / 1_000)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: magnitude < 10 ? 2 : 1 }).format(
    value,
  );
}

function trim(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}
