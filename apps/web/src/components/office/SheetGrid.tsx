import {
  type CellAddress,
  type CellRange,
  type SheetChartOverrides,
  type SheetEvaluation,
  type SheetTab,
  SHEET_GRID,
  cellName,
  columnLetters,
  formatSheetValue,
  isSheetError,
  rangeContains,
  safeLinkHref,
  sheetColumnWidth,
} from "@specweave-studio/shared/officeSheet";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";

import { useTx } from "../../i18n";
import { InlineButton } from "../ui/button";
import { SheetChartCard } from "./SheetChart";
import { type ColumnSortState, type SheetGridModel, chartOverrideKey } from "./sheetGridModel";

const CHIP_COLORS = 8;

/** Someone else on a cell: the cell they are on, or one inside their selection. */
export interface SheetPresenceMark {
  readonly name: string;
  readonly color: number;
  readonly focus: boolean;
}

/** The grid: column and row headers, computed and formatted cells, and the tab's charts. */
export function SheetGrid(props: {
  readonly tab: SheetTab;
  readonly tabIndex: number;
  readonly grid: SheetGridModel;
  readonly evaluation: SheetEvaluation;
  readonly range: CellRange | null;
  readonly focus: CellAddress | null;
  /** Where the others on a live sheet are, by cell name. */
  readonly presence?: ReadonlyMap<string, SheetPresenceMark> | undefined;
  readonly columnSort: ColumnSortState | null;
  readonly chartOverrides: Readonly<Record<string, SheetChartOverrides>>;
  readonly onChartOverrides: (key: string, next: SheetChartOverrides) => void;
  readonly onRemoveChart?: ((chartId: string) => void) | undefined;
  readonly onPick: (
    address: CellAddress,
    extend: boolean,
    event?: { readonly preventDefault: () => void },
  ) => void;
  readonly onSortColumn: (col: number) => void;
  readonly onResizeStart: (col: number, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onToggleGroup: (key: string, collapsed: boolean) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly scrollRef?: RefObject<HTMLDivElement | null> | undefined;
  /** The cell being edited, and the editor drawn in it. */
  readonly editing?: CellAddress | null | undefined;
  readonly editor?: ReactNode;
  readonly onEdit?: ((address: CellAddress) => void) | undefined;
  readonly onHeader?: ((kind: "row" | "col", index: number, extend: boolean) => void) | undefined;
  readonly onContextMenu?:
    | ((kind: "row" | "col" | "cell", address: CellAddress, event: ReactMouseEvent) => void)
    | undefined;
}): ReactNode {
  const tx = useTx();
  const { tab, grid, evaluation, range, focus, columnSort } = props;
  const chipColor = new Map<string, number>();
  return (
    <div className="office-sheet-body">
      <div
        className="office-sheet-scroll"
        ref={props.scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={tab.name}
        onKeyDown={props.onKeyDown}
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
                <col key={col} style={{ width: sheetColumnWidth(tab, col) }} />
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
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      data-col-header={letter}
                      data-selected={
                        range !== null && col >= range.start.col && col <= range.end.col
                      }
                      onMouseDown={(event) => {
                        if (event.button !== 0 || (event.target as Element).closest("button"))
                          return;
                        props.onHeader?.("col", col, event.shiftKey);
                      }}
                      onContextMenu={(event) =>
                        props.onContextMenu?.("col", { col, row: 0 }, event)
                      }
                    >
                      <span className="office-col-header-inner">
                        <span>{letter}</span>
                        <button
                          type="button"
                          className="office-col-sort"
                          aria-label={
                            sorted === "asc"
                              ? tx("Column {column}, sorted A to Z. Sort Z to A", {
                                  column: letter,
                                })
                              : sorted === "desc"
                                ? tx("Column {column}, sorted Z to A. Clear sort", {
                                    column: letter,
                                  })
                                : tx("Sort column {column}", { column: letter })
                          }
                          data-col-sort={letter}
                          data-sort-dir={sorted ?? "none"}
                          onClick={() => props.onSortColumn(col)}
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
                          aria-label={tx("Resize column {column}", { column: letter })}
                          tabIndex={-1}
                          data-col-resize={letter}
                          onMouseDown={(event) => props.onResizeStart(col, event)}
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
                      data-row-header={row + 1}
                      data-selected={
                        range !== null && row >= range.start.row && row <= range.end.row
                      }
                      onMouseDown={(event) => {
                        if (event.button !== 0 || (event.target as Element).closest("button"))
                          return;
                        props.onHeader?.("row", row, event.shiftKey);
                      }}
                      onContextMenu={(event) =>
                        props.onContextMenu?.("row", { col: 0, row }, event)
                      }
                    >
                      {group ? (
                        <button
                          type="button"
                          className="office-row-group-toggle"
                          aria-expanded={!group.collapsed}
                          aria-label={group.label}
                          data-row-group-toggle={row + 1}
                          onClick={() => props.onToggleGroup(group.key, !group.collapsed)}
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
                      const value = evaluation.valueAt(props.tabIndex, address);
                      const selected = range !== null && rangeContains(range, address);
                      const focused = focus !== null && focus.col === col && focus.row === row;
                      const cellStyle = grid.styleOf(address);
                      const editingHere =
                        props.editing != null &&
                        props.editing.col === col &&
                        props.editing.row === row;
                      const mark = props.presence?.get(cellName(address));
                      const flag =
                        mark?.focus === true ? (
                          <span className="document-presence-flag" data-presence-flag={mark.name}>
                            {mark.name}
                          </span>
                        ) : null;
                      const common = {
                        "data-cell": cellName(address),
                        "data-presence": mark ? (mark.focus ? "focus" : "range") : undefined,
                        "data-presence-color": mark ? mark.color % CHIP_COLORS : undefined,
                        "data-selected": selected,
                        "data-focused": focused,
                        "data-rule": cellStyle?.topBorder,
                        "data-fill": cellStyle?.fill,
                        "data-fill-tone": cellStyle?.fillTone,
                        "data-underline": cellStyle?.underline,
                        "data-border-top": cellStyle?.borderTop,
                        "data-border-right": cellStyle?.borderRight,
                        "data-border-bottom": cellStyle?.borderBottom,
                        "data-border-left": cellStyle?.borderLeft,
                        "data-editing": editingHere || undefined,
                        onMouseDown: (event: ReactMouseEvent) => {
                          if (!event.button && !editingHere) {
                            props.onPick(address, event.shiftKey, event);
                          }
                        },
                        onMouseEnter: (event: ReactMouseEvent) => {
                          if (event.buttons === 1 && !editingHere)
                            props.onPick(address, true, event);
                        },
                        onDoubleClick: () => props.onEdit?.(address),
                        onContextMenu: (event: ReactMouseEvent) =>
                          props.onContextMenu?.("cell", address, event),
                      };
                      if (editingHere) {
                        return (
                          <td key={col} {...common}>
                            {props.editor}
                            {flag}
                          </td>
                        );
                      }
                      if (value === null) {
                        return (
                          <td key={col} {...common}>
                            {flag}
                          </td>
                        );
                      }
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
                          {flag}
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
            if (!box || !series || box.endRow > grid.rows || box.endCol > grid.columns) return null;
            const key = chartOverrideKey(tab.name, chart.id);
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
                  overrides={props.chartOverrides[key]}
                  onOverridesChange={(next) => props.onChartOverrides(key, next)}
                  onRemove={props.onRemoveChart ? () => props.onRemoveChart!(chart.id) : undefined}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
