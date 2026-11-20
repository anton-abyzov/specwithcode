import { type SheetEvaluation, isSheetError } from "./formula.ts";
import {
  type CellRange,
  type SheetChart,
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

export interface SheetChartSeries {
  readonly points: ReadonlyArray<SheetChartPoint>;
  readonly total: number;
  readonly max: number;
  readonly min: number;
  /** Why nothing can be drawn, when points is empty. */
  readonly problem: "range" | "empty" | null;
}

/** The first cells of a range, in reading order, never more than a chart draws. */
function cellsOf(range: CellRange): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  const limit = SHEET_LIMITS.chartPoints;
  const byColumn = range.end.col === range.start.col || range.end.row !== range.start.row;
  const lastRow = byColumn ? range.end.row : range.start.row;
  for (let col = range.start.col; col <= range.end.col; col += 1) {
    for (let row = range.start.row; row <= lastRow; row += 1) {
      if (cells.length >= limit) return cells;
      cells.push({ col, row });
    }
  }
  return cells;
}

/**
 * The points a chart draws, read from computed values. A chart holds no data of
 * its own, so it follows its cells.
 */
export function chartSeries(
  document: SheetDocument,
  evaluation: SheetEvaluation,
  tabIndex: number,
  chart: SheetChart,
): SheetChartSeries {
  const none = (problem: "range" | "empty"): SheetChartSeries => ({
    points: [],
    total: 0,
    max: 0,
    min: 0,
    problem,
  });
  const labels = parseTabRange(chart.labels);
  const values = parseTabRange(chart.values);
  if (!labels || !values) return none("range");
  const tabOf = (name: string | null): number =>
    name === null
      ? tabIndex
      : document.tabs.findIndex((tab) => tab.name.toLowerCase() === name.toLowerCase());
  const labelTab = tabOf(labels.tab);
  const valueTab = tabOf(values.tab);
  if (labelTab < 0 || valueTab < 0) return none("range");

  const labelCells = cellsOf(labels.range);
  const valueCells = cellsOf(values.range);
  const raw: Array<{ label: string; value: number }> = [];
  for (let index = 0; index < valueCells.length; index += 1) {
    const value = evaluation.valueAt(valueTab, valueCells[index]!);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const labelCell = labelCells[index];
    const labelValue = labelCell ? evaluation.valueAt(labelTab, labelCell) : null;
    const label =
      labelValue === null || isSheetError(labelValue) ? String(index + 1) : String(labelValue);
    raw.push({ label: label.slice(0, 80), value });
  }
  if (raw.length === 0) return none("empty");
  const total = raw.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  return {
    points: raw.map((point) => ({
      ...point,
      share: total > 0 ? Math.max(0, point.value) / total : 0,
    })),
    total,
    max: Math.max(...raw.map((point) => point.value)),
    min: Math.min(...raw.map((point) => point.value)),
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
  /** The last column and row the chart covers, so the grid can reach under it. */
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
