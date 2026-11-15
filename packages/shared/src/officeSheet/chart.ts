import { type SheetEvaluation, isSheetError } from "./formula.ts";
import {
  type CellRange,
  type SheetChart,
  type SheetChartType,
  type SheetDocument,
  type SheetTab,
  SHEET_LIMITS,
  parseTabRange,
  rangeName,
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

function cellsOf(range: CellRange): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  const byColumn = range.end.col === range.start.col || range.end.row !== range.start.row;
  if (byColumn) {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      for (let row = range.start.row; row <= range.end.row; row += 1) cells.push({ col, row });
    }
  } else {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      cells.push({ col, row: range.start.row });
    }
  }
  return cells.slice(0, SHEET_LIMITS.chartPoints);
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
