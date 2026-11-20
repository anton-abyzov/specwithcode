/**
 * The Sheet artifact: a workbook that is data only. A file holds tabs of cell
 * inputs, formats and chart blocks; nothing in it is ever executed. Every limit
 * here is enforced on read and on write, for every provider alike.
 */

export const SHEET_ARTIFACT_VERSION = 1;
export const SHEET_ARTIFACT_KIND = "sheet";
export const SHEET_ARTIFACT_SUFFIX = ".sheet.json";
export const OFFICE_ARTIFACTS_DIR = ".specweave/artifacts";

export const SHEET_LIMITS = {
  /** Cells with an input, across every tab. */
  cells: 200_000,
  tabs: 50,
  /** Characters in one formula. */
  formulaChars: 2_000,
  /** Characters in one text cell. */
  textChars: 5_000,
  /** Nesting depth of one formula. */
  formulaDepth: 64,
  /** Evaluation steps for a whole workbook. */
  steps: 5_000_000,
  chartsPerTab: 50,
  /** Format, style and chip ranges per tab; every drawn cell is checked against them. */
  rangeEntries: 200,
  chartPoints: 200,
  /** Bytes of the saved file. */
  bytes: 2 * 1024 * 1024,
  titleChars: 200,
  tabNameChars: 60,
  rows: 100_000,
  columns: 702,
} as const;

/** A cell input, as typed in a formula bar: a string starting with "=" is a formula. */
export type SheetCellInput = string | number | boolean;

export type SheetNumberFormatKind = "number" | "currency" | "percent" | "text";

export interface SheetNumberFormat {
  readonly kind: SheetNumberFormatKind;
  readonly decimals?: number;
  /** ISO 4217 code, for kind "currency". */
  readonly currency?: string;
  /** How a negative amount is written; "parens" is the accounting style. */
  readonly negative?: "minus" | "parens";
  /** Thousands separators; on by default for number and currency. */
  readonly thousands?: boolean;
}

export type SheetAlign = "left" | "center" | "right";
export type SheetTone = "accent" | "muted" | "positive" | "negative" | "warning";

export interface SheetCellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly align?: SheetAlign;
  /** A named tone from the shared Office theme, never a raw colour. */
  readonly tone?: SheetTone;
  /** Larger type for a title row. */
  readonly heading?: boolean;
  /** A rule above the cell, as on a totals row. */
  readonly topBorder?: boolean;
  /** A soft band behind the cell, as on a table's header row. */
  readonly fill?: boolean;
}

/** bar is horizontal, for ranked categories; column is vertical, for a sequence. */
export type SheetChartType = "bar" | "column" | "line" | "donut";

export interface SheetChart {
  readonly id: string;
  readonly type: SheetChartType;
  /** A sentence that states the finding. */
  readonly title: string;
  /** Range of category labels, such as "A2:A9" or "Toolkit!A2:A9". */
  readonly labels: string;
  /** Range of numbers, the same length as labels. */
  readonly values: string;
  /** The cell under the chart's top-left corner. Without it the chart sits beside its data. */
  readonly at?: string;
}

export interface SheetTab {
  readonly name: string;
  readonly cells: Readonly<Record<string, SheetCellInput>>;
  /** Number formats by cell or range ("B2:E20"). Later entries win. */
  readonly formats?: Readonly<Record<string, SheetNumberFormat>>;
  /** Styles by cell or range. Later entries win. */
  readonly styles?: Readonly<Record<string, SheetCellStyle>>;
  /** Ranges whose cells draw as coloured chips, one colour per distinct value. */
  readonly chips?: ReadonlyArray<string>;
  /** Column widths in pixels by column letter. */
  readonly widths?: Readonly<Record<string, number>>;
  readonly charts?: ReadonlyArray<SheetChart>;
  /** False hides the grid lines, for a tab laid out as a report. */
  readonly gridlines?: boolean;
}

export interface SheetDocument {
  readonly v: typeof SHEET_ARTIFACT_VERSION;
  readonly kind: typeof SHEET_ARTIFACT_KIND;
  readonly title: string;
  /** Id of a design system in this project; the app theme when absent. */
  readonly designSystem?: string;
  readonly tabs: ReadonlyArray<SheetTab>;
}

export interface CellAddress {
  readonly col: number;
  readonly row: number;
}

export interface CellRange {
  readonly start: CellAddress;
  readonly end: CellAddress;
}

const A1_PATTERN = /^\$?([A-Za-z]{1,2})\$?([1-9][0-9]{0,5})$/;

export function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function columnLetters(index: number): string {
  let letters = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** "B7" or "$B$7" to zero-based column and row; null when it is not a cell in range. */
export function parseCellAddress(text: string): CellAddress | null {
  const match = A1_PATTERN.exec(text.trim());
  if (!match) return null;
  const col = columnIndex(match[1]!);
  const row = Number(match[2]) - 1;
  if (col >= SHEET_LIMITS.columns || row >= SHEET_LIMITS.rows) return null;
  return { col, row };
}

export function cellName(address: CellAddress): string {
  return `${columnLetters(address.col)}${address.row + 1}`;
}

/** "A1" or "A1:C9" to a normalized range; null when malformed. */
export function parseCellRange(text: string): CellRange | null {
  const parts = text.trim().split(":");
  if (parts.length > 2) return null;
  const first = parseCellAddress(parts[0] ?? "");
  const second = parts.length === 2 ? parseCellAddress(parts[1] ?? "") : first;
  if (!first || !second) return null;
  return {
    start: { col: Math.min(first.col, second.col), row: Math.min(first.row, second.row) },
    end: { col: Math.max(first.col, second.col), row: Math.max(first.row, second.row) },
  };
}

export function rangeName(range: CellRange): string {
  const start = cellName(range.start);
  const end = cellName(range.end);
  return start === end ? start : `${start}:${end}`;
}

export function rangeContains(range: CellRange, address: CellAddress): boolean {
  return (
    address.col >= range.start.col &&
    address.col <= range.end.col &&
    address.row >= range.start.row &&
    address.row <= range.end.row
  );
}

export interface TabRange {
  /** Tab name when the reference names one, else null for the current tab. */
  readonly tab: string | null;
  readonly range: CellRange;
}

/** "A1:B4", "Costs!A1:B4" or "'Q1 plan'!A1" to a tab and a range. */
export function parseTabRange(text: string): TabRange | null {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang < 0) {
    const range = parseCellRange(trimmed);
    return range ? { tab: null, range } : null;
  }
  let tab = trimmed.slice(0, bang);
  if (tab.startsWith("'") && tab.endsWith("'") && tab.length >= 2) {
    tab = tab.slice(1, -1).replaceAll("''", "'");
  }
  const range = parseCellRange(trimmed.slice(bang + 1));
  if (!range || tab.length === 0) return null;
  return { tab, range };
}

export function isFormulaInput(input: SheetCellInput | undefined): input is string {
  return typeof input === "string" && input.length > 1 && input.startsWith("=");
}

export type SheetValidation =
  | { readonly ok: true; readonly document: SheetDocument }
  | { readonly ok: false; readonly error: string };

const TONES: ReadonlySet<string> = new Set(["accent", "muted", "positive", "negative", "warning"]);
const ALIGNS: ReadonlySet<string> = new Set(["left", "center", "right"]);
const FORMAT_KINDS: ReadonlySet<string> = new Set(["number", "currency", "percent", "text"]);
const CHART_TYPES: ReadonlySet<string> = new Set(["bar", "column", "line", "donut"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DESIGN_SYSTEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CHART_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TAB_NAME_FORBIDDEN = /[!:\[\]*?/\\\u0000-\u001f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

function readFormat(value: unknown): SheetNumberFormat | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !FORMAT_KINDS.has(value.kind)) {
    return null;
  }
  const decimals =
    typeof value.decimals === "number" &&
    Number.isInteger(value.decimals) &&
    value.decimals >= 0 &&
    value.decimals <= 10
      ? value.decimals
      : undefined;
  const currency =
    typeof value.currency === "string" && CURRENCY_PATTERN.test(value.currency)
      ? value.currency
      : undefined;
  return {
    kind: value.kind as SheetNumberFormatKind,
    ...(decimals === undefined ? {} : { decimals }),
    ...(currency === undefined ? {} : { currency }),
    ...(value.negative === "parens" || value.negative === "minus"
      ? { negative: value.negative }
      : {}),
    ...(typeof value.thousands === "boolean" ? { thousands: value.thousands } : {}),
  };
}

function readStyle(value: unknown): SheetCellStyle | null {
  if (!isRecord(value)) return null;
  return {
    ...(value.bold === true ? { bold: true } : {}),
    ...(value.italic === true ? { italic: true } : {}),
    ...(typeof value.align === "string" && ALIGNS.has(value.align)
      ? { align: value.align as SheetAlign }
      : {}),
    ...(typeof value.tone === "string" && TONES.has(value.tone)
      ? { tone: value.tone as SheetTone }
      : {}),
    ...(value.heading === true ? { heading: true } : {}),
    ...(value.topBorder === true ? { topBorder: true } : {}),
    ...(value.fill === true ? { fill: true } : {}),
  };
}

function readRangeMap<T>(
  value: unknown,
  read: (entry: unknown) => T | null,
  what: string,
  tabName: string,
): { readonly ok: true; readonly map: Record<string, T> } | { readonly ok: false; error: string } {
  const map: Record<string, T> = {};
  if (value === undefined) return { ok: true, map };
  if (!isRecord(value)) return fail(`Tab "${tabName}": ${what} must be an object keyed by range.`);
  const entries = Object.entries(value);
  if (entries.length > SHEET_LIMITS.rangeEntries) {
    return fail(
      `Tab "${tabName}": ${what} has ${entries.length} ranges; the limit is ${SHEET_LIMITS.rangeEntries}. Use wider ranges.`,
    );
  }
  for (const [key, entry] of entries) {
    const range = parseCellRange(key);
    if (!range) return fail(`Tab "${tabName}": "${key}" in ${what} is not a cell or range.`);
    const parsed = read(entry);
    if (parsed === null) return fail(`Tab "${tabName}": ${what} for ${key} is not valid.`);
    map[rangeName(range)] = parsed;
  }
  return { ok: true, map };
}

/**
 * Check an untrusted value and return a clean document. Unknown fields are
 * dropped, so a file can never smuggle markup, script or settings past the
 * renderer.
 */
export function validateSheetDocument(value: unknown): SheetValidation {
  if (!isRecord(value)) return fail("A sheet must be an object.");
  if (value.kind !== undefined && value.kind !== SHEET_ARTIFACT_KIND) {
    return fail(`Not a sheet: kind is "${String(value.kind)}".`);
  }
  if (value.v !== undefined && value.v !== SHEET_ARTIFACT_VERSION) {
    return fail(`Unsupported sheet version ${String(value.v)}.`);
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (title.length === 0) return fail("A sheet needs a title.");
  if (title.length > SHEET_LIMITS.titleChars) {
    return fail(`The title is over the ${SHEET_LIMITS.titleChars} character limit.`);
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) {
    return fail("A sheet needs at least one tab.");
  }
  if (value.tabs.length > SHEET_LIMITS.tabs) {
    return fail(`A sheet holds at most ${SHEET_LIMITS.tabs} tabs.`);
  }
  let designSystem: string | undefined;
  if (value.designSystem !== undefined) {
    if (
      typeof value.designSystem !== "string" ||
      !DESIGN_SYSTEM_ID_PATTERN.test(value.designSystem)
    ) {
      return fail("designSystem must be the id of a design system in this project.");
    }
    designSystem = value.designSystem;
  }

  const tabs: SheetTab[] = [];
  const names = new Set<string>();
  let cellCount = 0;
  for (const rawTab of value.tabs) {
    if (!isRecord(rawTab)) return fail("Each tab must be an object.");
    const name = typeof rawTab.name === "string" ? rawTab.name.trim() : "";
    if (name.length === 0) return fail("Each tab needs a name.");
    if (name.length > SHEET_LIMITS.tabNameChars) {
      return fail(
        `Tab name "${name.slice(0, 20)}..." is over ${SHEET_LIMITS.tabNameChars} characters.`,
      );
    }
    if (TAB_NAME_FORBIDDEN.test(name)) {
      return fail(`Tab name "${name}" has a character a reference cannot use (! : [ ] * ? / \\).`);
    }
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) return fail(`Two tabs are named "${name}".`);
    names.add(nameKey);

    const cells: Record<string, SheetCellInput> = {};
    if (rawTab.cells !== undefined && !isRecord(rawTab.cells)) {
      return fail(
        `Tab "${name}": cells must be an object keyed by cell, such as {"A1": "Revenue"}.`,
      );
    }
    for (const [key, input] of Object.entries(rawTab.cells ?? {})) {
      const address = parseCellAddress(key);
      if (!address) return fail(`Tab "${name}": "${key}" is not a cell address.`);
      if (input === null || input === "") continue;
      if (typeof input === "number") {
        if (!Number.isFinite(input)) return fail(`Tab "${name}": ${key} is not a finite number.`);
      } else if (typeof input === "string") {
        if (input.startsWith("=")) {
          if (input.length > SHEET_LIMITS.formulaChars) {
            return fail(
              `Tab "${name}": the formula in ${key} is over the ${SHEET_LIMITS.formulaChars} character limit.`,
            );
          }
        } else if (input.length > SHEET_LIMITS.textChars) {
          return fail(
            `Tab "${name}": the text in ${key} is over the ${SHEET_LIMITS.textChars} character limit.`,
          );
        }
      } else if (typeof input !== "boolean") {
        return fail(`Tab "${name}": ${key} must be text, a number or true/false.`);
      }
      cells[cellName(address)] = input;
      cellCount += 1;
      if (cellCount > SHEET_LIMITS.cells) {
        return fail(`A sheet holds at most ${SHEET_LIMITS.cells.toLocaleString("en-US")} cells.`);
      }
    }

    const formats = readRangeMap(rawTab.formats, readFormat, "formats", name);
    if (!formats.ok) return formats;
    const styles = readRangeMap(rawTab.styles, readStyle, "styles", name);
    if (!styles.ok) return styles;

    const chips: string[] = [];
    if (rawTab.chips !== undefined) {
      if (!Array.isArray(rawTab.chips))
        return fail(`Tab "${name}": chips must be a list of ranges.`);
      if (rawTab.chips.length > SHEET_LIMITS.rangeEntries) {
        return fail(
          `Tab "${name}": chips has ${rawTab.chips.length} ranges; the limit is ${SHEET_LIMITS.rangeEntries}.`,
        );
      }
      for (const entry of rawTab.chips) {
        const range = typeof entry === "string" ? parseCellRange(entry) : null;
        if (!range) return fail(`Tab "${name}": "${String(entry)}" in chips is not a range.`);
        chips.push(rangeName(range));
      }
    }

    const widths: Record<string, number> = {};
    if (isRecord(rawTab.widths)) {
      for (const [letters, width] of Object.entries(rawTab.widths)) {
        if (!/^[A-Za-z]{1,2}$/.test(letters) || typeof width !== "number") continue;
        widths[letters.toUpperCase()] = Math.min(600, Math.max(40, Math.round(width)));
      }
    }

    const charts: SheetChart[] = [];
    if (rawTab.charts !== undefined) {
      if (!Array.isArray(rawTab.charts)) return fail(`Tab "${name}": charts must be a list.`);
      if (rawTab.charts.length > SHEET_LIMITS.chartsPerTab) {
        return fail(`Tab "${name}": a tab holds at most ${SHEET_LIMITS.chartsPerTab} charts.`);
      }
      const ids = new Set<string>();
      for (const rawChart of rawTab.charts) {
        if (!isRecord(rawChart)) return fail(`Tab "${name}": each chart must be an object.`);
        const type = rawChart.type;
        if (typeof type !== "string" || !CHART_TYPES.has(type)) {
          return fail(`Tab "${name}": a chart type must be bar, column, line or donut.`);
        }
        const chartTitle = typeof rawChart.title === "string" ? rawChart.title.trim() : "";
        if (chartTitle.length === 0 || chartTitle.length > SHEET_LIMITS.titleChars) {
          return fail(
            `Tab "${name}": each chart needs a title of up to ${SHEET_LIMITS.titleChars} characters.`,
          );
        }
        const labels = typeof rawChart.labels === "string" ? parseTabRange(rawChart.labels) : null;
        const values = typeof rawChart.values === "string" ? parseTabRange(rawChart.values) : null;
        if (!labels || !values) {
          return fail(`Tab "${name}": chart "${chartTitle}" needs labels and values ranges.`);
        }
        const at = typeof rawChart.at === "string" ? parseCellAddress(rawChart.at.trim()) : null;
        if (rawChart.at !== undefined && !at) {
          return fail(`Tab "${name}": chart "${chartTitle}" needs a single cell address for at.`);
        }
        let id =
          typeof rawChart.id === "string" && CHART_ID_PATTERN.test(rawChart.id)
            ? rawChart.id
            : `chart-${charts.length + 1}`;
        while (ids.has(id)) id = `${id}-${charts.length + 1}`;
        ids.add(id);
        charts.push({
          id,
          type: type as SheetChartType,
          title: chartTitle,
          labels: (rawChart.labels as string).trim(),
          values: (rawChart.values as string).trim(),
          ...(at ? { at: cellName(at) } : {}),
        });
      }
    }

    tabs.push({
      name,
      cells,
      ...(Object.keys(formats.map).length > 0 ? { formats: formats.map } : {}),
      ...(Object.keys(styles.map).length > 0 ? { styles: styles.map } : {}),
      ...(chips.length > 0 ? { chips } : {}),
      ...(Object.keys(widths).length > 0 ? { widths } : {}),
      ...(charts.length > 0 ? { charts } : {}),
      ...(rawTab.gridlines === false ? { gridlines: false as const } : {}),
    });
  }

  return {
    ok: true,
    document: {
      v: SHEET_ARTIFACT_VERSION,
      kind: SHEET_ARTIFACT_KIND,
      title,
      ...(designSystem === undefined ? {} : { designSystem }),
      tabs,
    },
  };
}

/** Parse a saved file's text. Never throws. */
export function parseSheetDocument(text: string): SheetValidation {
  if (text.length > SHEET_LIMITS.bytes) {
    return fail(`The file is over the ${SHEET_LIMITS.bytes / (1024 * 1024)} MB limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("The file is not valid JSON.");
  }
  return validateSheetDocument(value);
}

export function serializeSheetDocument(document: SheetDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * A lookup over a range-keyed map, with the ranges parsed once. The last
 * matching entry wins, as in the file's key order.
 */
export function rangeLookup<T>(
  map: Readonly<Record<string, T>> | undefined,
): (address: CellAddress) => T | undefined {
  const entries: Array<{ readonly range: CellRange; readonly entry: T }> = [];
  for (const [key, entry] of Object.entries(map ?? {})) {
    const range = parseCellRange(key);
    if (range) entries.push({ range, entry });
  }
  return (address) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (rangeContains(entries[index]!.range, address)) return entries[index]!.entry;
    }
    return undefined;
  };
}

/** One lookup; for a grid of cells use rangeLookup, which parses the ranges once. */
export function lookupByRange<T>(
  map: Readonly<Record<string, T>> | undefined,
  address: CellAddress,
): T | undefined {
  return rangeLookup(map)(address);
}

/** Only these schemes ever become a link; anything else stays plain text. */
export function safeLinkHref(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  // No spaces, control characters or invisible direction marks anywhere in the text.
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(trimmed)) {
    return null;
  }
  // An address only: a mailto query could set a subject, a body or more recipients.
  if (/^mailto:[^@?&#%,;]+@[^@?&#%,;]+$/i.test(trimmed)) {
    return `mailto:${trimmed.slice("mailto:".length)}`;
  }
  if (!/^https?:\/\/[^/]/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // "https://bank.com@evil.example" reads as one site and opens another.
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A file name stem from a title: lower case, dashes, at most 60 characters. */
export function sheetSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
    .replace(/-+$/g, "");
  const stem = slug.length > 0 ? slug : "sheet";
  // Letters outside ASCII leave no trace in the stem, so two such titles would
  // share one file. A short hash of the whole title keeps them apart.
  const plain = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  if (!/[^\x00-\x7f]/.test(plain)) return stem;
  let hash = 0x811c9dc5;
  for (const char of title.normalize("NFC")) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${stem}-${hash.toString(16).padStart(8, "0").slice(0, 6)}`;
}

/**
 * Lay an update over a saved sheet: tabs match by name, an update's cells,
 * formats and styles go over the saved ones, and an empty string clears a
 * cell. Charts, chips and widths are replaced when the update names them. The
 * result still has to pass validateSheetDocument.
 */
export function mergeSheetInput(base: SheetDocument, update: unknown): unknown {
  if (!isRecord(update)) return update;
  const tabs: unknown[] = base.tabs.map((tab) => ({ ...tab }));
  const updates = Array.isArray(update.tabs) ? update.tabs : [];
  for (const next of updates) {
    if (!isRecord(next) || typeof next.name !== "string") {
      tabs.push(next);
      continue;
    }
    const key = next.name.trim().toLowerCase();
    // Looked up in the working list, so an update that names a tab twice builds on itself.
    const index = tabs.findIndex(
      (tab) =>
        isRecord(tab) && typeof tab.name === "string" && tab.name.trim().toLowerCase() === key,
    );
    if (index < 0) {
      tabs.push(next);
      continue;
    }
    const saved = tabs[index] as {
      readonly cells?: unknown;
      readonly formats?: unknown;
      readonly styles?: unknown;
    };
    const cells: Record<string, unknown> = isRecord(saved.cells) ? { ...saved.cells } : {};
    if (isRecord(next.cells)) {
      for (const [cell, input] of Object.entries(next.cells)) {
        const address = parseCellAddress(cell);
        const name = address ? cellName(address) : cell;
        if (input === "" || input === null) delete cells[name];
        else cells[name] = input;
      }
    }
    tabs[index] = {
      ...saved,
      cells,
      ...(isRecord(next.formats)
        ? { formats: { ...(isRecord(saved.formats) ? saved.formats : {}), ...next.formats } }
        : {}),
      ...(isRecord(next.styles)
        ? { styles: { ...(isRecord(saved.styles) ? saved.styles : {}), ...next.styles } }
        : {}),
      ...(next.chips !== undefined ? { chips: next.chips } : {}),
      ...(next.widths !== undefined ? { widths: next.widths } : {}),
      ...(next.charts !== undefined ? { charts: next.charts } : {}),
      ...(next.gridlines !== undefined ? { gridlines: next.gridlines } : {}),
    };
  }
  return {
    title:
      typeof update.title === "string" && update.title.trim().length > 0
        ? update.title
        : base.title,
    designSystem: update.designSystem ?? base.designSystem,
    tabs,
  };
}

/** The filled rectangle of a tab, or null when it is empty. */
export function usedRange(tab: SheetTab): CellRange | null {
  let range: CellRange | null = null;
  for (const name of Object.keys(tab.cells)) {
    const address = parseCellAddress(name);
    if (!address) continue;
    range =
      range === null
        ? { start: address, end: address }
        : {
            start: {
              col: Math.min(range.start.col, address.col),
              row: Math.min(range.start.row, address.row),
            },
            end: {
              col: Math.max(range.end.col, address.col),
              row: Math.max(range.end.row, address.row),
            },
          };
  }
  return range;
}

export const SHEET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
