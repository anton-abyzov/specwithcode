/**
 * Formula and range reference rewriting for the Sheet editor: rows and columns
 * inserted or deleted, a tab renamed or deleted, a formula copied somewhere
 * else. Formulas are rewritten in place, so spacing, functions and `$` marks
 * stay as the person wrote them. Pure; nothing here evaluates anything.
 */
import { type FormulaRefSpan, formulaRefSpans } from "./formulaParser.ts";
import {
  type CellRange,
  SHEET_LIMITS,
  columnLetters,
  parseCellAddress,
  parseTabRange,
  rangeName,
} from "./model.ts";

export interface RefPart {
  readonly col: number;
  readonly row: number;
  readonly colAbsolute: boolean;
  readonly rowAbsolute: boolean;
}

/** One reference in a formula: a cell, or a range when `end` is set. */
export interface RefUnit {
  /** The tab it names, or null for the formula's own tab. */
  readonly tab: string | null;
  readonly start: RefPart;
  readonly end?: RefPart;
}

/** What a reference becomes: unchanged (null), an error, or new cells and tab. */
export type RefRewrite =
  | null
  | "#REF!"
  | { readonly start: RefPart; readonly end?: RefPart; readonly tab?: string | null };

const BARE_TAB = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** A tab name as a formula writes it: bare when it can be, quoted otherwise. */
export function formulaTabName(name: string): string {
  const looksLikeCell = parseCellAddress(name) !== null || /^(TRUE|FALSE)$/i.test(name);
  if (BARE_TAB.test(name) && !looksLikeCell) return name;
  return `'${name.replaceAll("'", "''")}'`;
}

function partText(part: RefPart): string {
  return `${part.colAbsolute ? "$" : ""}${columnLetters(part.col)}${part.rowAbsolute ? "$" : ""}${part.row + 1}`;
}

function partOf(span: FormulaRefSpan): RefPart {
  return {
    col: span.col,
    row: span.row,
    colAbsolute: span.colAbsolute,
    rowAbsolute: span.rowAbsolute,
  };
}

function inBounds(part: RefPart): boolean {
  return (
    part.col >= 0 &&
    part.row >= 0 &&
    part.col < SHEET_LIMITS.columns &&
    part.row < SHEET_LIMITS.rows
  );
}

/**
 * Rewrite every reference in a formula ("=..."). A formula that does not
 * tokenize, or a value that is not a formula, comes back as it was.
 */
export function mapFormulaRefs(formula: string, rewrite: (unit: RefUnit) => RefRewrite): string {
  if (!formula.startsWith("=")) return formula;
  const spans = formulaRefSpans(formula.slice(1));
  if (spans === null || spans.length === 0) return formula;
  const edits: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  for (let index = 0; index < spans.length; index += 1) {
    const first = spans[index]!;
    const second = first.rangeStart ? spans[index + 1] : undefined;
    if (second) index += 1;
    const unit: RefUnit = {
      tab: first.tab,
      start: partOf(first),
      ...(second ? { end: partOf(second) } : {}),
    };
    const next = rewrite(unit);
    if (next === null) continue;
    const start = first.start + 1;
    const end = (second ?? first).end + 1;
    if (next === "#REF!") {
      edits.push({ start, end, text: "#REF!" });
      continue;
    }
    const original = formula.slice(start, first.end + 1);
    const bang = original.lastIndexOf("!");
    const prefix =
      next.tab !== undefined
        ? next.tab === null
          ? ""
          : `${formulaTabName(next.tab)}!`
        : bang >= 0
          ? original.slice(0, bang + 1)
          : "";
    let text = `${prefix}${partText(next.start)}`;
    if (second) {
      const secondText = formula.slice(second.start + 1, second.end + 1);
      const secondBang = secondText.lastIndexOf("!");
      const secondPrefix =
        secondBang >= 0 && next.tab === undefined ? secondText.slice(0, secondBang + 1) : "";
      text += `:${secondPrefix}${partText(next.end ?? next.start)}`;
    }
    edits.push({ start, end, text });
  }
  let out = formula;
  for (const edit of edits.toReversed()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export type SheetAxis = "row" | "col";

/**
 * A structural change on one tab: `count` rows or columns inserted before
 * `at` (count > 0) or deleted from `at` on (count < 0).
 */
export interface AxisShift {
  readonly axis: SheetAxis;
  readonly at: number;
  readonly count: number;
}

/** Where an index lands after a shift, or null when it was deleted. */
export function shiftIndex(index: number, shift: AxisShift): number | null {
  if (shift.count > 0) return index >= shift.at ? index + shift.count : index;
  const removed = -shift.count;
  if (index < shift.at) return index;
  if (index < shift.at + removed) return null;
  return index - removed;
}

/** A span of indexes after a shift; null when every index in it was deleted. */
export function shiftSpan(
  first: number,
  last: number,
  shift: AxisShift,
): { readonly first: number; readonly last: number } | null {
  if (shift.count > 0) {
    return {
      first: first >= shift.at ? first + shift.count : first,
      last: last >= shift.at ? last + shift.count : last,
    };
  }
  const removed = -shift.count;
  const gapEnd = shift.at + removed - 1;
  if (first >= shift.at && last <= gapEnd) return null;
  const newFirst = first < shift.at ? first : first <= gapEnd ? shift.at : first - removed;
  const newLast = last < shift.at ? last : last <= gapEnd ? shift.at - 1 : last - removed;
  return { first: newFirst, last: newLast };
}

const LIMIT = { row: SHEET_LIMITS.rows, col: SHEET_LIMITS.columns } as const;

/** A range after a shift; null when it was deleted whole or pushed off the sheet. */
export function shiftRange(range: CellRange, shift: AxisShift): CellRange | null {
  const span =
    shift.axis === "row"
      ? shiftSpan(range.start.row, range.end.row, shift)
      : shiftSpan(range.start.col, range.end.col, shift);
  if (span === null || span.first >= LIMIT[shift.axis]) return null;
  const last = Math.min(span.last, LIMIT[shift.axis] - 1);
  return shift.axis === "row"
    ? { start: { ...range.start, row: span.first }, end: { ...range.end, row: last } }
    : { start: { ...range.start, col: span.first }, end: { ...range.end, col: last } };
}

function sameTab(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Rewrite a formula on `formulaTab` for a shift on `shiftedTab`. */
export function shiftFormulaRefs(
  formula: string,
  formulaTab: string,
  shiftedTab: string,
  shift: AxisShift,
): string {
  return mapFormulaRefs(formula, (unit) => {
    if (!sameTab(unit.tab ?? formulaTab, shiftedTab)) return null;
    const key = shift.axis;
    if (!unit.end) {
      const moved = shiftIndex(unit.start[key], shift);
      if (moved === null || moved >= LIMIT[key]) return "#REF!";
      if (moved === unit.start[key]) return null;
      return { start: { ...unit.start, [key]: moved } };
    }
    const lo = Math.min(unit.start[key], unit.end[key]);
    const hi = Math.max(unit.start[key], unit.end[key]);
    const span = shiftSpan(lo, hi, shift);
    if (span === null || span.first >= LIMIT[key]) return "#REF!";
    const last = Math.min(span.last, LIMIT[key] - 1);
    if (span.first === lo && last === hi) return null;
    const startIsLo = unit.start[key] <= unit.end[key];
    return {
      start: { ...unit.start, [key]: startIsLo ? span.first : last },
      end: { ...unit.end, [key]: startIsLo ? last : span.first },
    };
  });
}

/** Point references to a renamed tab at its new name. */
export function renameFormulaTab(formula: string, from: string, to: string): string {
  return mapFormulaRefs(formula, (unit) =>
    unit.tab !== null && sameTab(unit.tab, from)
      ? { start: unit.start, ...(unit.end ? { end: unit.end } : {}), tab: to }
      : null,
  );
}

/** References to a deleted tab become #REF!. */
export function deleteFormulaTab(formula: string, deleted: string): string {
  return mapFormulaRefs(formula, (unit) =>
    unit.tab !== null && sameTab(unit.tab, deleted) ? "#REF!" : null,
  );
}

/**
 * A formula copied `cols` and `rows` away: relative parts move, `$` parts stay,
 * and a reference pushed off the sheet becomes #REF!.
 */
export function offsetFormula(formula: string, cols: number, rows: number): string {
  if (cols === 0 && rows === 0) return formula;
  const move = (part: RefPart): RefPart => ({
    ...part,
    col: part.colAbsolute ? part.col : part.col + cols,
    row: part.rowAbsolute ? part.row : part.row + rows,
  });
  return mapFormulaRefs(formula, (unit) => {
    const start = move(unit.start);
    const end = unit.end ? move(unit.end) : undefined;
    if (!inBounds(start) || (end && !inBounds(end))) return "#REF!";
    return { start, ...(end ? { end } : {}) };
  });
}

/**
 * A range reference outside a formula, as charts hold them ("A2:A9" or
 * "Costs!A2:A9"), after a shift on `shiftedTab`. Null when it no longer
 * points anywhere; the text unchanged when the shift does not touch it.
 */
export function shiftRangeRef(
  text: string,
  ownTab: string,
  shiftedTab: string,
  shift: AxisShift,
): string | null {
  const parsed = parseTabRange(text);
  if (!parsed) return text;
  if (!sameTab(parsed.tab ?? ownTab, shiftedTab)) return text;
  const moved = shiftRange(parsed.range, shift);
  if (moved === null) return null;
  const bang = text.lastIndexOf("!");
  return `${bang >= 0 ? text.slice(0, bang + 1).trim() : ""}${rangeName(moved)}`;
}

/** A chart range after a tab rename. */
export function renameRangeRefTab(text: string, from: string, to: string): string {
  const parsed = parseTabRange(text);
  if (!parsed || parsed.tab === null || !sameTab(parsed.tab, from)) return text;
  return `${formulaTabName(to)}!${rangeName(parsed.range)}`;
}

/** True when a chart range names a tab that was deleted. */
export function rangeRefNamesTab(text: string, tab: string): boolean {
  const parsed = parseTabRange(text);
  return parsed !== null && parsed.tab !== null && sameTab(parsed.tab, tab);
}
