/**
 * Sheet editor commands that read the document and return the next one:
 * fill down and right, today's date. Pure, so each is testable without a grid.
 */
import {
  type CellAddress,
  type CellRange,
  type SheetCellInput,
  type SheetDocument,
  cellName,
  isFormulaInput,
  offsetFormula,
  setCells,
} from "@specweave-studio/shared/officeSheet";

/**
 * Fill down (or right) as Cmd/Ctrl+D (R) does: the first row (column) of the
 * selection is copied over the rest, formulas moved; a single row (column)
 * takes the one above (to the left).
 */
export function fillRange(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  direction: "down" | "right",
): SheetDocument {
  const tab = document.tabs[tabIndex];
  if (!tab) return document;
  const down = direction === "down";
  const single = down ? range.start.row === range.end.row : range.start.col === range.end.col;
  const sourceIndex = down ? range.start.row - (single ? 1 : 0) : range.start.col - (single ? 1 : 0);
  if (sourceIndex < 0) return document;
  const entries: Array<readonly [CellAddress, SheetCellInput | null]> = [];
  const firstTarget = single ? (down ? range.start.row : range.start.col) : sourceIndex + 1;
  const lastTarget = down ? range.end.row : range.end.col;
  const crossFirst = down ? range.start.col : range.start.row;
  const crossLast = down ? range.end.col : range.end.row;
  for (let cross = crossFirst; cross <= crossLast; cross += 1) {
    const source = down ? { col: cross, row: sourceIndex } : { col: sourceIndex, row: cross };
    const input = tab.cells[cellName(source)] ?? null;
    for (let index = firstTarget; index <= lastTarget; index += 1) {
      const target = down ? { col: cross, row: index } : { col: index, row: cross };
      const moved =
        input !== null && isFormulaInput(input)
          ? offsetFormula(input, target.col - source.col, target.row - source.row)
          : input;
      entries.push([target, moved]);
    }
  }
  return setCells(document, tabIndex, entries);
}

/** Today's date as the text a sheet keeps dates in (XNPV and XIRR read it). */
export function todayText(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
