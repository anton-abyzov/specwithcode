import {
  type CellAddress,
  type CellRange,
  type OfficeThemeMode,
  type OfficeThemeSource,
  type SheetChartType,
  type SheetDocument,
  SHEET_LIMITS,
  addChart,
  cellName,
  chartFromSelection,
  chartSeries,
  columnLetters,
  evaluateSheet,
  formatSheetValue,
  isSheetError,
  rangeLookup,
  officeThemeVariables,
  parseCellRange,
  parseSheetDocument,
  rangeContains,
  rangeName,
  removeChart,
  resolveOfficeTheme,
  safeLinkHref,
  serializeSheetDocument,
  usedRange,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import { BarChart3Icon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { Button } from "../ui/button";
import { SheetChartCard } from "./SheetChart";

/** The grid draws at most this much; a larger tab says so above it. */
export const SHEET_VIEW_ROWS = 500;
export const SHEET_VIEW_COLUMNS = 60;
const MIN_ROWS = 20;
const MIN_COLUMNS = 8;
const CHIP_COLORS = 8;

const CHART_TYPES: ReadonlyArray<{ readonly type: SheetChartType; readonly label: string }> = [
  { type: "bar", label: "Bar" },
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
}): ReactNode {
  const tx = useTx();
  const parsed = useMemo(() => parseSheetDocument(props.text), [props.text]);
  // A chart added here shows at once; the file read replaces it when it lands.
  const [draft, setDraft] = useState<{ readonly from: string; readonly document: SheetDocument }>();
  const document = parsed.ok
    ? draft !== undefined && draft.from === props.text
      ? draft.document
      : parsed.document
    : null;
  const [tabIndex, setTabIndex] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [inserting, setInserting] = useState(false);
  const [chartType, setChartType] = useState<SheetChartType>("bar");
  const [chartTitle, setChartTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const grid = useMemo(() => {
    if (!tab) return null;
    const used = usedRange(tab);
    const lastRow = used ? used.end.row : 0;
    const lastCol = used ? used.end.col : 0;
    const rows = Math.min(SHEET_VIEW_ROWS, Math.max(MIN_ROWS, lastRow + 3));
    const columns = Math.min(SHEET_VIEW_COLUMNS, Math.max(MIN_COLUMNS, lastCol + 2));
    const chipRanges = (tab.chips ?? [])
      .map((range) => parseCellRange(range))
      .filter((range): range is CellRange => range !== null);
    return {
      rows,
      columns,
      clipped: lastRow + 1 > rows || lastCol + 1 > columns,
      chipRanges,
      formatOf: rangeLookup(tab.formats),
      styleOf: rangeLookup(tab.styles),
    };
  }, [tab]);

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
    setSaving(true);
    setSaveError(null);
    setDraft({ from: props.text, document: checked.document });
    const saved = await props.onSave(serializeSheetDocument(checked.document));
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
          <Button type="button" size="sm" variant="ghost" onClick={() => setInserting(false)}>
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
          <table className="office-grid">
            <colgroup>
              <col className="office-grid-gutter" />
              {Array.from({ length: grid.columns }, (_, col) => {
                const width = tab.widths?.[columnLetters(col)];
                return (
                  <col
                    key={col}
                    style={width ? { width: Math.max(40, Math.min(600, width)) } : undefined}
                  />
                );
              })}
            </colgroup>
            <thead>
              <tr>
                <th className="office-grid-corner" aria-hidden />
                {Array.from({ length: grid.columns }, (_, col) => (
                  <th
                    key={col}
                    scope="col"
                    data-selected={range !== null && col >= range.start.col && col <= range.end.col}
                  >
                    {columnLetters(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: grid.rows }, (_, row) => (
                <tr key={row}>
                  <th
                    scope="row"
                    data-selected={range !== null && row >= range.start.row && row <= range.end.row}
                  >
                    {row + 1}
                  </th>
                  {Array.from({ length: grid.columns }, (_, col) => {
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
                    const common = {
                      "data-cell": cellName(address),
                      "data-selected": selected,
                      "data-focused": focused,
                      onMouseDown: (event: { shiftKey: boolean }) => pick(event.shiftKey),
                      onMouseEnter: (event: { buttons: number }) => {
                        if (event.buttons === 1) pick(true);
                      },
                    };
                    if (value === null) return <td key={col} {...common} />;
                    const cellStyle = grid.styleOf(address);
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
                        data-rule={cellStyle?.topBorder}
                      >
                        {chip ? (
                          <span className="office-chip" data-chip={chipColor.get(text)}>
                            {text}
                          </span>
                        ) : href ? (
                          <a href={href} target="_blank" rel="noreferrer noopener">
                            {text}
                          </a>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tab.charts && tab.charts.length > 0 ? (
          <aside className="office-sheet-charts" aria-label={tx("Charts")}>
            {tab.charts.map((chart) => (
              <SheetChartCard
                key={chart.id}
                chart={chart}
                series={chartSeries(document, evaluation, activeIndex, chart)}
                onRemove={
                  props.onSave && !saving
                    ? () => void save(removeChart(document, activeIndex, chart.id))
                    : undefined
                }
              />
            ))}
          </aside>
        ) : null}
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
            }}
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}
