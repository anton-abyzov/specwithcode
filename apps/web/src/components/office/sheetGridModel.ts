import {
  type CellAddress,
  type CellRange,
  type SheetChartOverrides,
  type SheetDocument,
  type SheetEvaluation,
  type SheetTab,
  SHEET_GRID,
  chartSeries,
  layoutSheetCharts,
  parseCellRange,
  rangeLookup,
  sheetColumnWidth,
  usedRange,
  visibleOrderedColumns,
} from "@specweave-studio/shared/officeSheet";

/** The grid draws at most this much; a larger tab says so above it. */
export const SHEET_VIEW_ROWS = 500;
export const SHEET_VIEW_COLUMNS = 60;
const MIN_ROWS = 20;
const MIN_COLUMNS = 8;

export interface ColumnSortState {
  readonly col: number;
  readonly direction: "asc" | "desc";
}

export interface Selection {
  readonly anchor: CellAddress;
  readonly focus: CellAddress;
}

export function normalize(anchor: CellAddress, focus: CellAddress): CellRange {
  return {
    start: { col: Math.min(anchor.col, focus.col), row: Math.min(anchor.row, focus.row) },
    end: { col: Math.max(anchor.col, focus.col), row: Math.max(anchor.row, focus.row) },
  };
}

export const chartOverrideKey = (tabName: string, chartId: string): string =>
  `${tabName}\0${chartId}`;

export type SheetGridModel = NonNullable<ReturnType<typeof sheetGridModel>>;

/** What the grid draws for one tab: its rows and columns in display order, charts and lookups. */
export function sheetGridModel(input: {
  readonly document: SheetDocument;
  readonly evaluation: SheetEvaluation;
  readonly tab: SheetTab;
  readonly tabIndex: number;
  readonly chartOverrides: Readonly<Record<string, SheetChartOverrides>>;
  readonly collapsedGroups: Readonly<Record<string, boolean>>;
  readonly columnSort: ColumnSortState | null;
  /** Keep at least this far drawn, so a cell selected past the data stays on screen. */
  readonly reach?: CellAddress | undefined;
}) {
  const { document, evaluation, tab: effectiveTab, tabIndex: activeIndex, columnSort } = input;
  const used = usedRange(effectiveTab);
  const series = (effectiveTab.charts ?? []).map((chart) =>
    chartSeries(
      document,
      evaluation,
      activeIndex,
      chart,
      input.chartOverrides[chartOverrideKey(effectiveTab.name, chart.id)],
    ),
  );
  const boxes = layoutSheetCharts(
    effectiveTab,
    series.map((entry) => entry.points.length),
  );
  const visibleBoxes = boxes.filter(
    (box) => box.endRow <= SHEET_VIEW_ROWS && box.endCol <= SHEET_VIEW_COLUMNS,
  );
  const lastRow = Math.max(
    used ? used.end.row + 1 : 0,
    (input.reach?.row ?? -1) + 1,
    ...visibleBoxes.map((box) => box.endRow),
  );
  const lastCol = Math.max(
    used ? used.end.col + 1 : 0,
    (input.reach?.col ?? -1) + 1,
    ...visibleBoxes.map((box) => box.endCol),
  );
  const rows = Math.min(SHEET_VIEW_ROWS, Math.max(MIN_ROWS, lastRow + 2));
  const columns = Math.min(SHEET_VIEW_COLUMNS, Math.max(MIN_COLUMNS, lastCol + 1));
  const displayCols = visibleOrderedColumns(effectiveTab, {
    start: { col: 0, row: 0 },
    end: { col: columns - 1, row: rows - 1 },
  });
  const styleOf = rangeLookup(effectiveTab.styles);
  const chipRanges = (effectiveTab.chips ?? [])
    .map((range) => parseCellRange(range))
    .filter((range): range is CellRange => range !== null);
  const hiddenRows = new Set<number>();
  const groupByStartRow = new Map<
    number,
    { readonly key: string; readonly label: string; readonly collapsed: boolean }
  >();
  for (let i = 0; i < (effectiveTab.rowGroups ?? []).length; i++) {
    const group = effectiveTab.rowGroups![i]!;
    const key = `${activeIndex}:${group.id ?? i}`;
    const collapsed = input.collapsedGroups[key] ?? group.collapsed ?? false;
    const startZero = group.startRow - 1;
    const endZero = group.endRow - 1;
    groupByStartRow.set(startZero, { key, label: group.label, collapsed });
    if (collapsed) {
      for (let r = startZero + 1; r <= endZero && r < rows; r++) {
        hiddenRows.add(r);
      }
    }
  }
  let displayRows = Array.from({ length: rows }, (_, row) => row).filter(
    (row) => !hiddenRows.has(row),
  );
  if (columnSort !== null && used !== null) {
    const dataEnd = Math.min(rows - 1, used.end.row);
    const totalCols = Math.max(columns, used.end.col + 1);
    const isSummaryRow = (row: number): boolean => {
      for (let col = 0; col < totalCols; col += 1) {
        if (styleOf({ col, row })?.topBorder === true) return true;
      }
      return false;
    };
    const headerRows = displayRows.filter((row) => row === 0);
    const summaryRows = displayRows.filter((row) => row > 0 && row <= dataEnd && isSummaryRow(row));
    const sortableRows = displayRows.filter(
      (row) => row > 0 && row <= dataEnd && !isSummaryRow(row),
    );
    const tailRows = displayRows.filter((row) => row > dataEnd);
    const dir = columnSort.direction === "asc" ? 1 : -1;
    sortableRows.sort((a, b) => {
      const va = evaluation.valueAt(activeIndex, { col: columnSort.col, row: a });
      const vb = evaluation.valueAt(activeIndex, { col: columnSort.col, row: b });
      if (va === null && vb === null) return a - b;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    displayRows = [...headerRows, ...sortableRows, ...summaryRows, ...tailRows];
  }
  return {
    rows,
    columns,
    displayCols,
    displayRows,
    groupByStartRow,
    clipped: visibleBoxes.length !== boxes.length || lastRow > rows || lastCol > columns,
    chipRanges,
    width:
      SHEET_GRID.gutterWidth +
      displayCols.reduce((sum, col) => sum + sheetColumnWidth(effectiveTab, col), 0),
    series,
    boxes,
    formatOf: rangeLookup(effectiveTab.formats),
    styleOf,
  };
}
