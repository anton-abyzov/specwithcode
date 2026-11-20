import {
  type CellAddress,
  type CellRange,
  type OfficeThemeMode,
  type OfficeThemeSource,
  type SheetChartOverrides,
  type SheetChartType,
  type SheetDocument,
  type SheetTab,
  SHEET_GRID,
  SHEET_LIMITS,
  addChart,
  cellName,
  chartFromSelection,
  chartSeries,
  columnLetters,
  evaluateSheet,
  exportSheetToMarkdown,
  exportSheetToStandaloneHtml,
  formatSheetValue,
  isSheetError,
  layoutSheetCharts,
  officeThemeVariables,
  parseCellRange,
  parseSheetDocument,
  rangeContains,
  rangeLookup,
  rangeName,
  removeChart,
  resolveOfficeTheme,
  safeLinkHref,
  serializeSheetDocument,
  sheetColumnWidth,
  sheetContentRevision,
  usedRange,
  validateSheetDocument,
  visibleOrderedColumns,
} from "@specweave-studio/shared/officeSheet";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  BarChart3Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns3Icon,
  CopyIcon,
  DownloadIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { Button, InlineButton } from "../ui/button";
import { SheetChartCard } from "./SheetChart";

/** The grid draws at most this much; a larger tab says so above it. */
export const SHEET_VIEW_ROWS = 500;
export const SHEET_VIEW_COLUMNS = 60;
const MIN_ROWS = 20;
const MIN_COLUMNS = 8;
const CHIP_COLORS = 8;

const CHART_TYPES: ReadonlyArray<{ readonly type: SheetChartType; readonly label: string }> = [
  { type: "bar", label: "Bar" },
  { type: "column", label: "Column" },
  { type: "line", label: "Line" },
  { type: "donut", label: "Donut" },
];

function normalize(anchor: CellAddress, focus: CellAddress): CellRange {
  return {
    start: { col: Math.min(anchor.col, focus.col), row: Math.min(anchor.row, focus.row) },
    end: { col: Math.max(anchor.col, focus.col), row: Math.max(anchor.row, focus.row) },
  };
}

interface Selection {
  readonly anchor: CellAddress;
  readonly focus: CellAddress;
}

interface ColumnSortState {
  readonly col: number;
  readonly direction: "asc" | "desc";
}

function updateTab(
  document: SheetDocument,
  tabIndex: number,
  updater: (tab: SheetTab) => SheetTab,
): SheetDocument {
  return {
    ...document,
    tabs: document.tabs.map((entry, idx) => (idx === tabIndex ? updater(entry) : entry)),
  };
}

function slugFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || "sheet"}.html`;
}

/**
 * A sheet artifact: tabs, a formula bar, a grid of computed and formatted
 * cells, and the charts bound to its ranges. The file is data; nothing in it
 * runs. With `onSave`, a selected range becomes a chart saved into the file.
 */
export function SheetView(props: {
  readonly text: string;
  readonly mode: OfficeThemeMode;
  readonly themeSource?: OfficeThemeSource | null | undefined;
  /** Writes the new file contents; resolves false when the write failed. */
  readonly onSave?: ((contents: string) => Promise<boolean>) | undefined;
  /** Tells the host which design system the file names, so it can load it. */
  readonly onDesignSystem?: ((id: string | null) => void) | undefined;
  /** Optional hook for HTML export (defaults to browser Blob download). */
  readonly onExportHtml?: ((html: string, filename: string) => void) | undefined;
  /** Optional hook for Markdown copy (defaults to navigator.clipboard.writeText). */
  readonly onCopyMarkdown?: ((markdown: string) => void | Promise<void>) | undefined;
}): ReactNode {
  const tx = useTx();
  const parsed = useMemo(() => parseSheetDocument(props.text), [props.text]);
  const incomingRevision = useMemo(() => sheetContentRevision(props.text), [props.text]);
  // A chart or layout edit shows at once; if the file changes externally underneath,
  // we surface a non-destructive conflict banner instead of silently overwriting.
  const [draft, setDraft] = useState<{
    readonly from: string;
    readonly savedRevision: string;
    readonly document: SheetDocument;
  }>();
  const isOwnSaveLanding = draft !== undefined && incomingRevision === draft.savedRevision;
  const hasExternalConflict =
    draft !== undefined && draft.from !== props.text && !isOwnSaveLanding;
  const document = parsed.ok
    ? draft !== undefined && (draft.from === props.text || hasExternalConflict)
      ? draft.document
      : parsed.document
    : null;
  const [tabIndex, setTabIndex] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [inserting, setInserting] = useState(false);
  const [organizingColumns, setOrganizingColumns] = useState(false);
  const [chartType, setChartType] = useState<SheetChartType>("bar");
  const [chartTitle, setChartTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [chartOverrides, setChartOverrides] = useState<Record<string, SheetChartOverrides>>({});
  const [columnSort, setColumnSort] = useState<ColumnSortState | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});

  useEffect(() => {
    if (isOwnSaveLanding) {
      setDraft(undefined);
    }
  }, [isOwnSaveLanding]);

  const designSystem = document?.designSystem ?? null;
  const { onDesignSystem } = props;
  useEffect(() => {
    onDesignSystem?.(designSystem);
  }, [designSystem, onDesignSystem]);

  const evaluation = useMemo(() => (document ? evaluateSheet(document) : null), [document]);
  const theme = useMemo(
    () => officeThemeVariables(resolveOfficeTheme(props.themeSource, props.mode)),
    [props.mode, props.themeSource],
  );

  const activeIndex = document ? Math.min(tabIndex, document.tabs.length - 1) : 0;
  const tab = document?.tabs[activeIndex];

  const effectiveTab = useMemo<SheetTab | undefined>(() => {
    if (!tab) return undefined;
    if (Object.keys(localWidths).length === 0) return tab;
    return { ...tab, widths: { ...tab.widths, ...localWidths } };
  }, [localWidths, tab]);

  const grid = useMemo(() => {
    if (!effectiveTab || !document || !evaluation) return null;
    const used = usedRange(effectiveTab);
    const series = (effectiveTab.charts ?? []).map((chart) =>
      chartSeries(document, evaluation, activeIndex, chart, chartOverrides[chart.id]),
    );
    const boxes = layoutSheetCharts(
      effectiveTab,
      series.map((entry) => entry.points.length),
    );
    const visibleBoxes = boxes.filter(
      (box) => box.endRow <= SHEET_VIEW_ROWS && box.endCol <= SHEET_VIEW_COLUMNS,
    );
    const lastRow = Math.max(used ? used.end.row + 1 : 0, ...visibleBoxes.map((box) => box.endRow));
    const lastCol = Math.max(used ? used.end.col + 1 : 0, ...visibleBoxes.map((box) => box.endCol));
    const rows = Math.min(SHEET_VIEW_ROWS, Math.max(MIN_ROWS, lastRow + 2));
    const columns = Math.min(SHEET_VIEW_COLUMNS, Math.max(MIN_COLUMNS, lastCol + 1));
    const displayCols = visibleOrderedColumns(effectiveTab, columns);
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
      const collapsed = collapsedGroups[key] ?? group.collapsed ?? false;
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
      const headerRows = displayRows.filter((row) => row === 0);
      const sortableRows = displayRows.filter((row) => row > 0 && row <= dataEnd);
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
      displayRows = [...headerRows, ...sortableRows, ...tailRows];
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
      styleOf: rangeLookup(effectiveTab.styles),
    };
  }, [activeIndex, chartOverrides, collapsedGroups, columnSort, document, effectiveTab, evaluation]);

  if (!parsed.ok) {
    return (
      <div className="office-problem" role="alert">
        <p>{tx("This sheet could not be read.")}</p>
        <p className="text-muted-foreground">{parsed.error}</p>
      </div>
    );
  }
  if (!document || !evaluation || !tab || !grid) return null;

  const range = selection ? normalize(selection.anchor, selection.focus) : null;
  const focusInput = selection ? tab.cells[cellName(selection.focus)] : undefined;
  const focusValue = selection ? evaluation.valueAt(activeIndex, selection.focus) : null;
  const chipColor = new Map<string, number>();

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selection) return;
    const delta =
      event.key === "ArrowUp"
        ? { col: 0, row: -1 }
        : event.key === "ArrowDown"
          ? { col: 0, row: 1 }
          : event.key === "ArrowLeft"
            ? { col: -1, row: 0 }
            : event.key === "ArrowRight"
              ? { col: 1, row: 0 }
              : null;
    if (!delta) return;
    event.preventDefault();
    // The viewer steps files with the same keys; the grid keeps them.
    event.stopPropagation();
    const focus = {
      col: Math.max(0, Math.min(grid.columns - 1, selection.focus.col + delta.col)),
      row: Math.max(0, Math.min(grid.rows - 1, selection.focus.row + delta.row)),
    };
    setSelection(event.shiftKey ? { anchor: selection.anchor, focus } : { anchor: focus, focus });
  };

  const save = async (next: SheetDocument): Promise<boolean> => {
    if (!props.onSave) return false;
    const checked = validateSheetDocument(next);
    if (!checked.ok) {
      setSaveError(checked.error);
      return false;
    }
    const serialized = serializeSheetDocument(checked.document);
    setSaving(true);
    setSaveError(null);
    setDraft({
      from: props.text,
      savedRevision: sheetContentRevision(serialized),
      document: checked.document,
    });
    const saved = await props.onSave(serialized);
    setSaving(false);
    if (!saved) {
      setDraft(undefined);
      setSaveError(tx("The chart could not be saved."));
    }
    return saved;
  };

  const insertChart = async () => {
    if (!range) return;
    const chart = chartFromSelection(tab, range, chartType, chartTitle);
    if (await save(addChart(document, activeIndex, chart))) {
      setInserting(false);
      setChartTitle("");
    }
  };

  const toggleColumnSort = (col: number) => {
    setColumnSort((current) => {
      if (!current || current.col !== col) return { col, direction: "asc" };
      if (current.direction === "asc") return { col, direction: "desc" };
      return null;
    });
  };

  const startColumnResize = (col: number, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const letter = columnLetters(col);
    const startX = event.clientX;
    const startWidth = sheetColumnWidth(effectiveTab ?? tab, col);
    let latestWidth = startWidth;

    const onMove = (moveEvent: MouseEvent) => {
      latestWidth = Math.max(
        SHEET_LIMITS.minColumnWidth,
        Math.min(SHEET_LIMITS.maxColumnWidth, Math.round(startWidth + (moveEvent.clientX - startX))),
      );
      setLocalWidths((prev) => ({ ...prev, [letter]: latestWidth }));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (props.onSave && latestWidth !== startWidth) {
        const nextDoc = updateTab(document, activeIndex, (current) => ({
          ...current,
          widths: { ...current.widths, [letter]: latestWidth },
        }));
        void save(nextDoc).then((ok) => {
          if (ok) {
            setLocalWidths((prev) => {
              const copy = { ...prev };
              delete copy[letter];
              return copy;
            });
          }
        });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleColumnHidden = (col: number) => {
    const letter = columnLetters(col);
    const currentHidden = new Set((tab.hiddenColumns ?? []).map((entry) => entry.toUpperCase()));
    if (currentHidden.has(letter)) {
      currentHidden.delete(letter);
    } else {
      currentHidden.add(letter);
    }
    const nextHidden = [...currentHidden];
    const nextDoc = updateTab(document, activeIndex, (current) => ({
      ...current,
      hiddenColumns: nextHidden.length > 0 ? nextHidden : undefined,
    }));
    if (props.onSave) {
      void save(nextDoc);
    } else {
      setDraft({
        from: props.text,
        savedRevision: sheetContentRevision(serializeSheetDocument(nextDoc)),
        document: nextDoc,
      });
    }
  };

  const moveColumnOrder = (col: number, delta: -1 | 1) => {
    const order = [...grid.displayCols];
    const pos = order.indexOf(col);
    const target = pos + delta;
    if (pos < 0 || target < 0 || target >= order.length) return;
    [order[pos], order[target]] = [order[target]!, order[pos]!];
    const nextOrder = order.map((entry) => columnLetters(entry));
    const nextDoc = updateTab(document, activeIndex, (current) => ({
      ...current,
      columnOrder: nextOrder,
    }));
    if (props.onSave) {
      void save(nextDoc);
    } else {
      setDraft({
        from: props.text,
        savedRevision: sheetContentRevision(serializeSheetDocument(nextDoc)),
        document: nextDoc,
      });
    }
  };

  const handleExportHtml = () => {
    const html = exportSheetToStandaloneHtml(document, {
      mode: props.mode,
      themeSource: props.themeSource,
    });
    const filename = slugFileName(document.title);
    if (props.onExportHtml) {
      props.onExportHtml(html, filename);
      return;
    }
    if (typeof Blob === "undefined" || typeof URL === "undefined") return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = filename;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleCopyMarkdown = async () => {
    const markdown = exportSheetToMarkdown(document, { tabIndex: activeIndex });
    if (props.onCopyMarkdown) {
      await props.onCopyMarkdown(markdown);
    } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown);
    }
    setCopyStatus(tx("Copied Markdown"));
    setTimeout(() => setCopyStatus(null), 2000);
  };

  const chartsFull = (tab.charts?.length ?? 0) >= SHEET_LIMITS.chartsPerTab;
  const style = {
    ...theme,
    ...(theme["--office-font"] ? { fontFamily: theme["--office-font"] } : {}),
  };

  return (
    <div className="office-surface office-sheet" style={style as CSSProperties} data-office="sheet">
      <div className="office-sheet-bar">
        <span className="office-sheet-address" data-sheet-address>
          {range ? rangeName(range) : ""}
        </span>
        <span className="office-sheet-formula" aria-label={tx("Formula bar")} data-sheet-formula>
          {focusInput === undefined
            ? ""
            : typeof focusInput === "boolean"
              ? formatSheetValue(focusValue, undefined)
              : String(focusInput)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOrganizingColumns((open) => !open)}
          data-sheet-columns-toggle
        >
          <Columns3Icon aria-hidden />
          {tx("Columns")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleCopyMarkdown()}
          data-sheet-copy-md
        >
          <CopyIcon aria-hidden />
          {copyStatus ?? tx("Copy Markdown")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleExportHtml}
          data-sheet-export-html
        >
          <DownloadIcon aria-hidden />
          {tx("Export HTML")}
        </Button>
        {props.onSave ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={range === null || chartsFull || saving}
            title={range === null ? tx("Select the cells to chart first.") : undefined}
            onClick={() => setInserting((open) => !open)}
            data-sheet-insert-chart
          >
            <BarChart3Icon aria-hidden />
            {tx("Insert chart")}
          </Button>
        ) : null}
      </div>
      {hasExternalConflict && draft ? (
        <div className="office-sheet-conflict" role="alert" data-sheet-conflict>
          <span>{tx("This sheet changed on disk while you were editing.")}</span>
          <div className="office-sheet-conflict-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-sheet-conflict-reload
              onClick={() => {
                setDraft(undefined);
                setSaveError(null);
              }}
            >
              {tx("Reload latest")}
            </Button>
            {props.onSave ? (
              <Button
                type="button"
                size="sm"
                data-sheet-conflict-keep
                onClick={() => void save(draft.document)}
              >
                {tx("Keep my edits")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {organizingColumns ? (
        <div className="office-sheet-columns-panel" data-sheet-columns-panel>
          {Array.from({ length: grid.columns }, (_, col) => {
            const letter = columnLetters(col);
            const hidden = (tab.hiddenColumns ?? [])
              .map((entry) => entry.toUpperCase())
              .includes(letter);
            return (
              <span key={letter} className="office-column-pill" data-hidden={hidden}>
                <button
                  type="button"
                  data-col-toggle={letter}
                  onClick={() => toggleColumnHidden(col)}
                >
                  {hidden ? `${letter} (${tx("hidden")})` : letter}
                </button>
                {!hidden ? (
                  <>
                    <button
                      type="button"
                      aria-label={tx("Move left")}
                      data-col-left={letter}
                      onClick={() => moveColumnOrder(col, -1)}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      aria-label={tx("Move right")}
                      data-col-right={letter}
                      onClick={() => moveColumnOrder(col, 1)}
                    >
                      ›
                    </button>
                  </>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
      {inserting && range ? (
        <form
          className="office-sheet-insert"
          onSubmit={(event) => {
            event.preventDefault();
            void insertChart();
          }}
        >
          <span className="text-muted-foreground">{rangeName(range)}</span>
          <span className="office-segment" role="radiogroup" aria-label={tx("Chart type")}>
            {CHART_TYPES.map((entry) => (
              <button
                key={entry.type}
                type="button"
                role="radio"
                aria-checked={chartType === entry.type}
                data-active={chartType === entry.type}
                onClick={() => setChartType(entry.type)}
              >
                {tx(entry.label)}
              </button>
            ))}
          </span>
          <input
            className="office-sheet-input"
            value={chartTitle}
            maxLength={SHEET_LIMITS.titleChars}
            placeholder={tx("Chart title")}
            aria-label={tx("Chart title")}
            onChange={(event) => setChartTitle(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving} data-sheet-add-chart>
            {tx("Add chart")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setInserting(false)}>
            {tx("Cancel")}
          </Button>
        </form>
      ) : null}
      {saveError ? (
        <p className="office-sheet-note" role="alert">
          {saveError}
        </p>
      ) : null}
      {grid.clipped ? (
        <p className="office-sheet-note" role="status">
          {renderRich(tx("Showing the first {rows} rows and {columns} columns."), {
            rows: String(grid.rows),
            columns: String(grid.columns),
          })}
        </p>
      ) : null}
      <div className="office-sheet-body">
        <div
          className="office-sheet-scroll"
          tabIndex={0}
          role="grid"
          aria-label={tab.name}
          onKeyDown={move}
        >
          <div className="office-grid-plane" style={{ width: grid.width }}>
            <table
              className="office-grid"
              style={{ width: grid.width }}
              data-gridlines={tab.gridlines === false ? "off" : undefined}
            >
              <colgroup>
                <col style={{ width: SHEET_GRID.gutterWidth }} />
                {grid.displayCols.map((col) => (
                  <col key={col} style={{ width: sheetColumnWidth(effectiveTab ?? tab, col) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="office-grid-corner" aria-hidden />
                  {grid.displayCols.map((col) => {
                    const letter = columnLetters(col);
                    const sorted = columnSort?.col === col ? columnSort.direction : null;
                    return (
                      <th
                        key={col}
                        scope="col"
                        data-col-header={letter}
                        data-selected={
                          range !== null && col >= range.start.col && col <= range.end.col
                        }
                      >
                        <span className="office-col-header-inner">
                          <span>{letter}</span>
                          <button
                            type="button"
                            className="office-col-sort"
                            aria-label={tx("Sort column")}
                            data-col-sort={letter}
                            data-sort-dir={sorted ?? "none"}
                            onClick={() => toggleColumnSort(col)}
                          >
                            {sorted === "asc" ? (
                              <ArrowUpIcon aria-hidden />
                            ) : sorted === "desc" ? (
                              <ArrowDownIcon aria-hidden />
                            ) : (
                              <ArrowUpDownIcon aria-hidden />
                            )}
                          </button>
                          <button
                            type="button"
                            className="office-col-resize"
                            aria-label={tx("Resize column")}
                            data-col-resize={letter}
                            onMouseDown={(event) => startColumnResize(col, event)}
                          />
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {grid.displayRows.map((row) => {
                  const group = grid.groupByStartRow.get(row);
                  return (
                    <tr key={row} data-row={row + 1}>
                      <th
                        scope="row"
                        data-selected={
                          range !== null && row >= range.start.row && row <= range.end.row
                        }
                      >
                        {group ? (
                          <button
                            type="button"
                            className="office-row-group-toggle"
                            aria-expanded={!group.collapsed}
                            aria-label={group.label}
                            data-row-group-toggle={row + 1}
                            onClick={() =>
                              setCollapsedGroups((prev) => ({
                                ...prev,
                                [group.key]: !group.collapsed,
                              }))
                            }
                          >
                            {group.collapsed ? (
                              <ChevronRightIcon aria-hidden />
                            ) : (
                              <ChevronDownIcon aria-hidden />
                            )}
                            <span>{row + 1}</span>
                          </button>
                        ) : (
                          row + 1
                        )}
                      </th>
                      {grid.displayCols.map((col) => {
                        const address = { col, row };
                        const value = evaluation.valueAt(activeIndex, address);
                        const selected = range !== null && rangeContains(range, address);
                        const focused =
                          selection !== null &&
                          selection.focus.col === col &&
                          selection.focus.row === row;
                        const pick = (extend: boolean) =>
                          setSelection((current) =>
                            extend && current
                              ? { anchor: current.anchor, focus: address }
                              : { anchor: address, focus: address },
                          );
                        const cellStyle = grid.styleOf(address);
                        const common = {
                          "data-cell": cellName(address),
                          "data-selected": selected,
                          "data-focused": focused,
                          "data-rule": cellStyle?.topBorder,
                          "data-fill": cellStyle?.fill,
                          onMouseDown: (event: { shiftKey: boolean }) => pick(event.shiftKey),
                          onMouseEnter: (event: { buttons: number }) => {
                            if (event.buttons === 1) pick(true);
                          },
                        };
                        if (value === null) return <td key={col} {...common} />;
                        const text = formatSheetValue(value, grid.formatOf(address));
                        const numeric = typeof value === "number";
                        const href = typeof value === "string" ? safeLinkHref(value) : null;
                        const chip =
                          typeof value === "string" &&
                          grid.chipRanges.some((entry) => rangeContains(entry, address));
                        if (chip && !chipColor.has(text)) {
                          chipColor.set(text, (chipColor.size % CHIP_COLORS) + 1);
                        }
                        return (
                          <td
                            key={col}
                            {...common}
                            data-align={cellStyle?.align ?? (numeric ? "right" : undefined)}
                            data-tone={isSheetError(value) ? "negative" : cellStyle?.tone}
                            data-bold={cellStyle?.bold}
                            data-italic={cellStyle?.italic}
                            data-heading={cellStyle?.heading}
                          >
                            {chip ? (
                              <span className="office-chip" data-chip={chipColor.get(text)}>
                                {text}
                              </span>
                            ) : href ? (
                              <InlineButton
                                tone="link"
                                className="[--inline-button-text-align:inherit] [--inline-button-white-space:inherit]"
                                render={<a href={href} target="_blank" rel="noreferrer noopener" />}
                              >
                                {text}
                              </InlineButton>
                            ) : (
                              text
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(tab.charts ?? []).map((chart, index) => {
              const box = grid.boxes[index];
              const series = grid.series[index];
              if (!box || !series || box.endRow > grid.rows || box.endCol > grid.columns)
                return null;
              return (
                <div
                  key={chart.id}
                  className="office-grid-chart"
                  style={{
                    left: SHEET_GRID.gutterWidth + box.left,
                    top: SHEET_GRID.headerHeight + box.top,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  <SheetChartCard
                    chart={chart}
                    series={series}
                    tone={index}
                    overrides={chartOverrides[chart.id]}
                    onOverridesChange={(next) =>
                      setChartOverrides((prev) => ({ ...prev, [chart.id]: next }))
                    }
                    onRemove={
                      props.onSave && !saving
                        ? () => void save(removeChart(document, activeIndex, chart.id))
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="office-sheet-tabs" role="tablist" aria-label={tx("Sheet tabs")}>
        {document.tabs.map((entry, index) => (
          <button
            key={entry.name}
            type="button"
            role="tab"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex}
            onClick={() => {
              setTabIndex(index);
              setSelection(null);
              setInserting(false);
              setColumnSort(null);
              setLocalWidths({});
            }}
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}
