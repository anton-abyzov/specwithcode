/**
 * The Sheet edit model: every change a person makes in the editor, as a pure
 * function from one document to the next. Cell input, clearing, styles and
 * number formats over ranges, rows and columns inserted or deleted with every
 * reference that points at them rewritten, tabs added, renamed and deleted,
 * and an undo history. Each result still has to pass validateSheetDocument
 * before it is saved.
 */
import {
  type AxisShift,
  deleteFormulaTab,
  renameFormulaTab,
  renameRangeRefTab,
  rangeRefNamesTab,
  shiftFormulaRefs,
  shiftIndex,
  shiftRange,
  shiftRangeRef,
  shiftSpan,
} from "./sheetRefs.ts";
import {
  type CellAddress,
  type CellRange,
  type SheetCellInput,
  type SheetCellStyle,
  type SheetChart,
  type SheetDocument,
  type SheetNumberFormat,
  type SheetRowGroup,
  type SheetTab,
  SHEET_LIMITS,
  SHEET_STYLE_KEYS,
  cellName,
  columnIndex,
  columnLetters,
  isFormulaInput,
  parseCellAddress,
  parseCellRange,
  rangeName,
} from "./model.ts";

export * from "./sheetRefs.ts";

// ------------------------------------------------------------- cell input

/** What a person typed, as the cell input it stands for, and the format it implies. */
export interface ParsedCellInput {
  /** Null clears the cell. */
  readonly input: SheetCellInput | null;
  /** A format to apply when the cell has none, as "12%" or "$1,200" imply. */
  readonly format?: SheetNumberFormat;
}

const PLAIN_NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const CURRENCY_SIGNS: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP" };

function plainNumber(text: string): number | null {
  if (text.length === 0 || !PLAIN_NUMBER.test(text) || !/\d/.test(text)) return null;
  const value = Number(text.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

/** Turn typed text into a cell input: numbers, percents, currency, TRUE/FALSE, formulas, text. */
export function parseCellInput(text: string): ParsedCellInput {
  if (text.length === 0) return { input: null };
  if (text.startsWith("=")) return { input: text.length > 1 ? text : null };
  // An apostrophe keeps what follows as text, as in a spreadsheet.
  if (text.startsWith("'")) {
    const rest = text.slice(1);
    return { input: rest.startsWith("=") ? text : rest.length > 0 ? rest : null };
  }
  const trimmed = text.trim();
  if (/^true$/i.test(trimmed)) return { input: true };
  if (/^false$/i.test(trimmed)) return { input: false };
  const plain = plainNumber(trimmed);
  if (plain !== null) return { input: plain };
  if (trimmed.endsWith("%")) {
    const value = plainNumber(trimmed.slice(0, -1).trim());
    if (value !== null) {
      const decimals = (trimmed.slice(0, -1).split(".")[1] ?? "").length;
      return {
        input: Number((value / 100).toPrecision(15)),
        format: { kind: "percent", ...(decimals > 0 ? { decimals } : {}) },
      };
    }
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const currency = CURRENCY_SIGNS[unsigned[0] ?? ""];
  if (currency) {
    const value = plainNumber(unsigned.slice(1));
    if (value !== null) {
      const decimals = (unsigned.split(".")[1] ?? "").length;
      return {
        input: negative ? -value : value,
        format: { kind: "currency", currency, decimals: decimals > 0 ? decimals : 2 },
      };
    }
  }
  return { input: text.length > SHEET_LIMITS.textChars ? text.slice(0, SHEET_LIMITS.textChars) : text };
}

/** A cell input as the editor shows it for editing. */
export function cellInputText(input: SheetCellInput | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "boolean") return input ? "TRUE" : "FALSE";
  return String(input);
}

// ------------------------------------------------------------- helpers

export function updateTab(
  document: SheetDocument,
  tabIndex: number,
  updater: (tab: SheetTab) => SheetTab,
): SheetDocument {
  return {
    ...document,
    tabs: document.tabs.map((entry, index) => (index === tabIndex ? updater(entry) : entry)),
  };
}

function withoutEmpty<K extends keyof SheetTab>(tab: SheetTab, key: K, value: SheetTab[K]): SheetTab {
  const empty =
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  if (empty) {
    const { [key]: _dropped, ...rest } = tab;
    return rest as SheetTab;
  }
  return { ...tab, [key]: value };
}

function cellsIn(range: CellRange): number {
  return (range.end.col - range.start.col + 1) * (range.end.row - range.start.row + 1);
}

// ------------------------------------------------------------- cells

/** Set or clear cells on one tab; a null input clears. */
export function setCells(
  document: SheetDocument,
  tabIndex: number,
  entries: ReadonlyArray<readonly [CellAddress, SheetCellInput | null]>,
): SheetDocument {
  if (entries.length === 0) return document;
  return updateTab(document, tabIndex, (tab) => {
    const cells: Record<string, SheetCellInput> = { ...tab.cells };
    for (const [address, input] of entries) {
      const name = cellName(address);
      if (input === null || input === "") delete cells[name];
      else cells[name] = input;
    }
    return { ...tab, cells };
  });
}

/** Clear the inputs in a range; with `formatting`, its styles and number formats too. */
export function clearRange(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  options?: { readonly formatting?: boolean },
): SheetDocument {
  let next = updateTab(document, tabIndex, (tab) => {
    const cells: Record<string, SheetCellInput> = {};
    for (const [name, input] of Object.entries(tab.cells)) {
      const address = parseCellAddress(name);
      if (address && rangeContainsAddress(range, address)) continue;
      cells[name] = input;
    }
    return { ...tab, cells };
  });
  if (options?.formatting) {
    next = paintStyle(next, tabIndex, range, () => undefined);
    next = setFormat(next, tabIndex, range, null);
  }
  return next;
}

function rangeContainsAddress(range: CellRange, address: CellAddress): boolean {
  return (
    address.col >= range.start.col &&
    address.col <= range.end.col &&
    address.row >= range.start.row &&
    address.row <= range.end.row
  );
}

// ------------------------------------------------------------- range maps

/** Thrown when an edit would need more ranges than a tab may hold. */
export class SheetEditLimitError extends Error {}

/**
 * Paint `change` over a range-keyed map ("later entries win") and return a new
 * map with no overlaps: the ranges are cut where any entry starts or ends,
 * each piece gets the value its cells show, the change is applied inside the
 * range, and equal neighbours are joined again.
 */
export function paintRangeMap<T>(
  map: Readonly<Record<string, T>> | undefined,
  range: CellRange,
  change: (current: T | undefined) => T | undefined,
  keyOf: (value: T) => string = (value) => JSON.stringify(value),
): Record<string, T> {
  const entries: Array<{ readonly range: CellRange; readonly value: T }> = [];
  for (const [key, value] of Object.entries(map ?? {})) {
    const parsed = parseCellRange(key);
    if (parsed) entries.push({ range: parsed, value });
  }
  const xs = new Set<number>([range.start.col, range.end.col + 1]);
  const ys = new Set<number>([range.start.row, range.end.row + 1]);
  for (const entry of entries) {
    xs.add(entry.range.start.col);
    xs.add(entry.range.end.col + 1);
    ys.add(entry.range.start.row);
    ys.add(entry.range.end.row + 1);
  }
  const cols = [...xs].sort((a, b) => a - b);
  const rows = [...ys].sort((a, b) => a - b);
  // The value of each piece: the last entry that covers it, then the change.
  const pieces: Array<Array<T | undefined>> = [];
  for (let y = 0; y < rows.length - 1; y += 1) {
    const line: Array<T | undefined> = [];
    for (let x = 0; x < cols.length - 1; x += 1) {
      const probe = { col: cols[x]!, row: rows[y]! };
      let value: T | undefined;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (rangeContainsAddress(entries[index]!.range, probe)) {
          value = entries[index]!.value;
          break;
        }
      }
      if (rangeContainsAddress(range, probe)) value = change(value);
      line.push(value);
    }
    pieces.push(line);
  }
  // Join runs along each line, then stack identical runs from line to line.
  interface Run {
    readonly x1: number;
    readonly x2: number;
    readonly key: string;
    readonly value: T;
    y1: number;
    y2: number;
  }
  const done: Run[] = [];
  let open: Run[] = [];
  for (let y = 0; y < pieces.length; y += 1) {
    const line = pieces[y]!;
    const runs: Run[] = [];
    for (let x = 0; x < line.length; x += 1) {
      const value = line[x];
      if (value === undefined) continue;
      const key = keyOf(value);
      const last = runs.at(-1);
      if (last && last.x2 === x - 1 && last.key === key) {
        runs[runs.length - 1] = { ...last, x2: x };
      } else {
        runs.push({ x1: x, x2: x, key, value, y1: y, y2: y });
      }
    }
    const nextOpen: Run[] = [];
    for (const run of runs) {
      const above = open.find(
        (entry) => entry.x1 === run.x1 && entry.x2 === run.x2 && entry.key === run.key && entry.y2 === y - 1,
      );
      if (above) {
        above.y2 = y;
        nextOpen.push(above);
        open = open.filter((entry) => entry !== above);
      } else {
        nextOpen.push(run);
      }
    }
    done.push(...open);
    open = nextOpen;
  }
  done.push(...open);
  const out: Record<string, T> = {};
  for (const run of done) {
    const key = rangeName({
      start: { col: cols[run.x1]!, row: rows[run.y1]! },
      end: { col: cols[run.x2 + 1]! - 1, row: rows[run.y2 + 1]! - 1 },
    });
    out[key] = run.value;
  }
  if (Object.keys(out).length > SHEET_LIMITS.rangeEntries) {
    throw new SheetEditLimitError(
      `This tab would need more than ${SHEET_LIMITS.rangeEntries} formatted ranges. Format wider ranges at once.`,
    );
  }
  return out;
}

function cleanStyle(style: SheetCellStyle): SheetCellStyle | undefined {
  const out: Record<string, unknown> = {};
  for (const key of SHEET_STYLE_KEYS) {
    const value = style[key];
    if (value !== undefined && value !== false) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as SheetCellStyle) : undefined;
}

function styleKey(style: SheetCellStyle): string {
  return JSON.stringify(SHEET_STYLE_KEYS.map((key) => style[key] ?? null));
}

/** Change the style of every cell in a range. */
export function paintStyle(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  change: (current: SheetCellStyle | undefined) => SheetCellStyle | undefined,
): SheetDocument {
  return updateTab(document, tabIndex, (tab) =>
    withoutEmpty(
      tab,
      "styles",
      paintRangeMap(
        tab.styles,
        range,
        (current) => {
          const next = change(current);
          return next ? cleanStyle(next) : undefined;
        },
        styleKey,
      ),
    ),
  );
}

/** Style keys a formatting control sets; `undefined` removes the key. */
export type SheetStylePatch = { -readonly [K in keyof SheetCellStyle]?: SheetCellStyle[K] | undefined };

/** Set (or remove, with undefined) style keys on every cell in a range. */
export function applyStyle(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  patch: SheetStylePatch,
): SheetDocument {
  return paintStyle(document, tabIndex, range, (current) => ({ ...current, ...patch }) as SheetCellStyle);
}

/** Toggle a flag the way a toolbar does: on for all unless every cell already has it. */
export function toggleStyleFlag(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  key: "bold" | "italic" | "underline",
  styleAt: (address: CellAddress) => SheetCellStyle | undefined,
): SheetDocument {
  let all = true;
  const limit = Math.min(cellsIn(range), 20_000);
  let seen = 0;
  outer: for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      if (seen++ >= limit) break outer;
      if (styleAt({ col, row })?.[key] !== true) {
        all = false;
        break outer;
      }
    }
  }
  return applyStyle(document, tabIndex, range, { [key]: all ? undefined : true });
}

export type SheetBorderPreset = "all" | "outline" | "top" | "bottom" | "left" | "right" | "none";

/** Borders on a range, as a formatting bar's border menu sets them. */
export function applyBorders(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  preset: SheetBorderPreset,
): SheetDocument {
  if (preset === "all") {
    return applyStyle(document, tabIndex, range, {
      borderTop: true,
      borderBottom: true,
      borderLeft: true,
      borderRight: true,
    });
  }
  if (preset === "none") {
    return applyStyle(document, tabIndex, range, {
      borderTop: undefined,
      borderBottom: undefined,
      borderLeft: undefined,
      borderRight: undefined,
      topBorder: undefined,
    });
  }
  // Each edge is its own band, so a large range costs at most four paints.
  const { start, end } = range;
  const bands: Array<readonly [CellRange, SheetStylePatch]> = [];
  if (preset === "outline" || preset === "top") {
    bands.push([{ start, end: { col: end.col, row: start.row } }, { borderTop: true }]);
  }
  if (preset === "outline" || preset === "bottom") {
    bands.push([{ start: { col: start.col, row: end.row }, end }, { borderBottom: true }]);
  }
  if (preset === "outline" || preset === "left") {
    bands.push([{ start, end: { col: start.col, row: end.row } }, { borderLeft: true }]);
  }
  if (preset === "outline" || preset === "right") {
    bands.push([{ start: { col: end.col, row: start.row }, end }, { borderRight: true }]);
  }
  let next = document;
  for (const [band, patch] of bands) next = applyStyle(next, tabIndex, band, patch);
  return next;
}

/** Set (or with null remove) the number format of every cell in a range. */
export function setFormat(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  format: SheetNumberFormat | null,
): SheetDocument {
  return updateTab(document, tabIndex, (tab) =>
    withoutEmpty(tab, "formats", paintRangeMap(tab.formats, range, () => format ?? undefined)),
  );
}

/** Change the number format of every cell in a range, from what each cell has. */
export function paintFormat(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  change: (current: SheetNumberFormat | undefined) => SheetNumberFormat | undefined,
): SheetDocument {
  return updateTab(document, tabIndex, (tab) =>
    withoutEmpty(tab, "formats", paintRangeMap(tab.formats, range, change)),
  );
}

/** One more or one fewer decimal place, from what each cell shows now. */
export function stepDecimals(
  document: SheetDocument,
  tabIndex: number,
  range: CellRange,
  delta: 1 | -1,
): SheetDocument {
  return paintFormat(document, tabIndex, range, (current) => {
    const base: SheetNumberFormat = current ?? { kind: "number", decimals: 0, thousands: false };
    const fallback = base.kind === "currency" ? 2 : 0;
    const decimals = Math.max(0, Math.min(10, (base.decimals ?? fallback) + delta));
    return { ...base, kind: base.kind === "text" ? "number" : base.kind, decimals };
  });
}

// ------------------------------------------------------------- rows and columns

function shiftRangeKeys<T>(
  map: Readonly<Record<string, T>> | undefined,
  shift: AxisShift,
): Record<string, T> | undefined {
  if (!map) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    const range = parseCellRange(key);
    if (!range) continue;
    const moved = shiftRange(range, shift);
    if (moved) out[rangeName(moved)] = value;
  }
  return out;
}

function shiftLetters(list: ReadonlyArray<string> | undefined, shift: AxisShift): string[] | undefined {
  if (!list || shift.axis !== "col") return list ? [...list] : undefined;
  const out: string[] = [];
  for (const letters of list) {
    const moved = shiftIndex(columnIndex(letters), shift);
    if (moved !== null && moved < SHEET_LIMITS.columns) out.push(columnLetters(moved));
  }
  return out;
}

function shiftChart(chart: SheetChart, ownTab: string, shiftedTab: string, shift: AxisShift): SheetChart | null {
  const labels = shiftRangeRef(chart.labels, ownTab, shiftedTab, shift);
  const values = shiftRangeRef(chart.values, ownTab, shiftedTab, shift);
  // A chart whose data was deleted has nothing to draw.
  if (labels === null || values === null) return null;
  const filterRange =
    chart.filterRange === undefined ? undefined : shiftRangeRef(chart.filterRange, ownTab, shiftedTab, shift);
  let at = chart.at;
  if (at !== undefined && ownTab.toLowerCase() === shiftedTab.toLowerCase()) {
    const address = parseCellAddress(at);
    if (address) {
      const index = shiftIndex(shift.axis === "row" ? address.row : address.col, shift);
      at =
        index === null || index >= (shift.axis === "row" ? SHEET_LIMITS.rows : SHEET_LIMITS.columns)
          ? undefined
          : cellName(shift.axis === "row" ? { ...address, row: index } : { ...address, col: index });
    }
  }
  const { filterRange: _f, at: _a, ...rest } = chart;
  return {
    ...rest,
    labels,
    values,
    ...(filterRange ? { filterRange } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

function shiftRowGroups(groups: ReadonlyArray<SheetRowGroup> | undefined, shift: AxisShift): SheetRowGroup[] | undefined {
  if (!groups || shift.axis !== "row") return groups ? [...groups] : undefined;
  const out: SheetRowGroup[] = [];
  for (const group of groups) {
    const span = shiftSpan(group.startRow - 1, group.endRow - 1, shift);
    if (span === null || span.first >= SHEET_LIMITS.rows) continue;
    out.push({ ...group, startRow: span.first + 1, endRow: Math.min(span.last, SHEET_LIMITS.rows - 1) + 1 });
  }
  return out;
}

/**
 * Insert (count > 0) or delete (count < 0) rows or columns on one tab. Cells,
 * formats, styles, chips, widths, column order, hidden columns, row groups and
 * charts move with them, and every formula and chart in the workbook that
 * points at the tab is rewritten; a reference to a deleted cell becomes #REF!.
 */
export function shiftAxis(document: SheetDocument, tabIndex: number, shift: AxisShift): SheetDocument {
  const target = document.tabs[tabIndex];
  if (!target || shift.count === 0) return document;
  const tabs = document.tabs.map((tab, index) => {
    const own = index === tabIndex;
    const cells: Record<string, SheetCellInput> = {};
    for (const [name, input] of Object.entries(tab.cells)) {
      const rewritten = isFormulaInput(input) ? shiftFormulaRefs(input, tab.name, target.name, shift) : input;
      if (!own) {
        cells[name] = rewritten;
        continue;
      }
      const address = parseCellAddress(name);
      if (!address) continue;
      const index = shiftIndex(shift.axis === "row" ? address.row : address.col, shift);
      if (index === null || index >= (shift.axis === "row" ? SHEET_LIMITS.rows : SHEET_LIMITS.columns)) continue;
      cells[cellName(shift.axis === "row" ? { ...address, row: index } : { ...address, col: index })] = rewritten;
    }
    const charts = (tab.charts ?? [])
      .map((chart) => shiftChart(chart, tab.name, target.name, shift))
      .filter((chart): chart is SheetChart => chart !== null);
    let next: SheetTab = { ...tab, cells };
    next = withoutEmpty(next, "charts", charts);
    if (!own) return next;
    next = withoutEmpty(next, "formats", shiftRangeKeys(tab.formats, shift));
    next = withoutEmpty(next, "styles", shiftRangeKeys(tab.styles, shift));
    next = withoutEmpty(
      next,
      "chips",
      tab.chips
        ?.map((entry) => {
          const range = parseCellRange(entry);
          const moved = range ? shiftRange(range, shift) : null;
          return moved ? rangeName(moved) : null;
        })
        .filter((entry): entry is string => entry !== null),
    );
    if (shift.axis === "col" && tab.widths) {
      const widths: Record<string, number> = {};
      for (const [letters, width] of Object.entries(tab.widths)) {
        const moved = shiftIndex(columnIndex(letters), shift);
        if (moved !== null && moved < SHEET_LIMITS.columns) widths[columnLetters(moved)] = width;
      }
      next = withoutEmpty(next, "widths", widths);
    }
    next = withoutEmpty(next, "columnOrder", shiftLetters(tab.columnOrder, shift));
    next = withoutEmpty(next, "hiddenColumns", shiftLetters(tab.hiddenColumns, shift));
    next = withoutEmpty(next, "rowGroups", shiftRowGroups(tab.rowGroups, shift));
    return next;
  });
  return { ...document, tabs };
}

export const insertRows = (document: SheetDocument, tabIndex: number, at: number, count = 1) =>
  shiftAxis(document, tabIndex, { axis: "row", at, count: Math.max(1, count) });
export const deleteRows = (document: SheetDocument, tabIndex: number, at: number, count = 1) =>
  shiftAxis(document, tabIndex, { axis: "row", at, count: -Math.max(1, count) });
export const insertColumns = (document: SheetDocument, tabIndex: number, at: number, count = 1) =>
  shiftAxis(document, tabIndex, { axis: "col", at, count: Math.max(1, count) });
export const deleteColumns = (document: SheetDocument, tabIndex: number, at: number, count = 1) =>
  shiftAxis(document, tabIndex, { axis: "col", at, count: -Math.max(1, count) });

// ------------------------------------------------------------- tabs

const TAB_NAME_FORBIDDEN = /[!:[\]*?/\\\u0000-\u001f]/;

/** Why a tab name cannot be used, or null when it can. */
export function tabNameProblem(document: SheetDocument, name: string, exceptIndex?: number): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A tab needs a name.";
  if (trimmed.length > SHEET_LIMITS.tabNameChars) {
    return `A tab name has at most ${SHEET_LIMITS.tabNameChars} characters.`;
  }
  if (TAB_NAME_FORBIDDEN.test(trimmed)) return "A tab name cannot hold ! : [ ] * ? / \\.";
  if (trimmed.startsWith("'") || trimmed.endsWith("'")) return "A tab name cannot start or end with '.";
  const taken = document.tabs.some(
    (tab, index) => index !== exceptIndex && tab.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? `There is already a tab named "${trimmed}".` : null;
}

/** A new empty tab after `after` (default: at the end), named "Sheet N". */
export function addTab(
  document: SheetDocument,
  options?: { readonly name?: string; readonly after?: number },
): { readonly document: SheetDocument; readonly index: number } {
  if (document.tabs.length >= SHEET_LIMITS.tabs) {
    throw new SheetEditLimitError(`A sheet holds at most ${SHEET_LIMITS.tabs} tabs.`);
  }
  let name = options?.name?.trim() ?? "";
  if (name.length === 0) {
    let number = document.tabs.length + 1;
    while (tabNameProblem(document, `Sheet${number}`) !== null) number += 1;
    name = `Sheet${number}`;
  }
  const problem = tabNameProblem(document, name);
  if (problem) throw new SheetEditLimitError(problem);
  const index = Math.min(document.tabs.length, (options?.after ?? document.tabs.length - 1) + 1);
  const tabs = [...document.tabs];
  tabs.splice(index, 0, { name, cells: {} });
  return { document: { ...document, tabs }, index };
}

/** Rename a tab; every formula and chart that names it follows. */
export function renameTab(document: SheetDocument, tabIndex: number, name: string): SheetDocument {
  const tab = document.tabs[tabIndex];
  if (!tab) return document;
  const next = name.trim();
  const problem = tabNameProblem(document, next, tabIndex);
  if (problem) throw new SheetEditLimitError(problem);
  if (next === tab.name) return document;
  const from = tab.name;
  return {
    ...document,
    tabs: document.tabs.map((entry, index) => {
      const cells: Record<string, SheetCellInput> = {};
      for (const [cell, input] of Object.entries(entry.cells)) {
        cells[cell] = isFormulaInput(input) ? renameFormulaTab(input, from, next) : input;
      }
      const charts = entry.charts?.map((chart) => ({
        ...chart,
        labels: renameRangeRefTab(chart.labels, from, next),
        values: renameRangeRefTab(chart.values, from, next),
        ...(chart.filterRange ? { filterRange: renameRangeRefTab(chart.filterRange, from, next) } : {}),
      }));
      return {
        ...entry,
        ...(index === tabIndex ? { name: next } : {}),
        cells,
        ...(charts ? { charts } : {}),
      };
    }),
  };
}

/** Delete a tab (never the last one); formulas that pointed at it show #REF!. */
export function deleteTab(document: SheetDocument, tabIndex: number): SheetDocument {
  const tab = document.tabs[tabIndex];
  if (!tab || document.tabs.length <= 1) return document;
  const gone = tab.name;
  return {
    ...document,
    tabs: document.tabs
      .filter((_, index) => index !== tabIndex)
      .map((entry) => {
        const cells: Record<string, SheetCellInput> = {};
        for (const [cell, input] of Object.entries(entry.cells)) {
          cells[cell] = isFormulaInput(input) ? deleteFormulaTab(input, gone) : input;
        }
        const charts = entry.charts?.filter(
          (chart) =>
            !rangeRefNamesTab(chart.labels, gone) &&
            !rangeRefNamesTab(chart.values, gone),
        );
        const cleaned = charts?.map((chart) =>
          chart.filterRange && rangeRefNamesTab(chart.filterRange, gone)
            ? (({ filterRange: _gone, ...rest }) => rest)(chart)
            : chart,
        );
        return withoutEmpty({ ...entry, cells }, "charts", cleaned);
      }),
  };
}

// ------------------------------------------------------------- history

export const SHEET_HISTORY_LIMIT = 200;

/**
 * Undo and redo over whole documents. Documents are immutable and share every
 * tab an edit did not touch, so a step costs the tabs it changed.
 */
export interface SheetHistory {
  readonly past: ReadonlyArray<SheetDocument>;
  readonly future: ReadonlyArray<SheetDocument>;
}

export const EMPTY_SHEET_HISTORY: SheetHistory = { past: [], future: [] };

/** Record that `before` was replaced by an edit; clears the redo side. */
export function recordEdit(history: SheetHistory, before: SheetDocument): SheetHistory {
  const past = [...history.past, before];
  return { past: past.slice(Math.max(0, past.length - SHEET_HISTORY_LIMIT)), future: [] };
}

export function undoEdit(
  history: SheetHistory,
  current: SheetDocument,
): { readonly history: SheetHistory; readonly document: SheetDocument } | null {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future] },
    document: previous,
  };
}

export function redoEdit(
  history: SheetHistory,
  current: SheetDocument,
): { readonly history: SheetHistory; readonly document: SheetDocument } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(1) },
    document: next,
  };
}
