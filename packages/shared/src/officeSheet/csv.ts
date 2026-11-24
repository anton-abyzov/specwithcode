/**
 * One tab as comma-separated text, and comma- or tab-separated text as a new
 * Sheet. Export writes computed values (RFC 4180, CRLF, a BOM so Excel reads
 * UTF-8) and guards text that a spreadsheet would run as a formula. Import is
 * data only: each field is read as the editor reads typed input.
 */
import { parseCellInput, parseExternalCellInput } from "./edit.ts";
import { type SheetEvaluation, isSheetError } from "./formula.ts";
import {
  type SheetCellInput,
  type SheetDocument,
  type SheetNumberFormat,
  type SheetTab,
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  cellName,
  columnLetters,
  parseCellAddress,
} from "./model.ts";

export type SheetDelimiter = "," | ";" | "\t";

function csvField(text: string, delimiter: string): string {
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Text a spreadsheet would treat as a formula gets an apostrophe in front, and
 * so does text that already starts with one, so the import can strip exactly one.
 */
function guardText(text: string): string {
  return /^['=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** The used part of one tab as CSV text, values as computed. */
export function sheetTabToCsv(
  tab: SheetTab,
  tabIndex: number,
  evaluation: SheetEvaluation,
  options?: { readonly delimiter?: SheetDelimiter; readonly bom?: boolean },
): string {
  const delimiter = options?.delimiter ?? ",";
  let maxRow = -1;
  let maxCol = -1;
  for (const name of Object.keys(tab.cells)) {
    const address = parseCellAddress(name);
    if (!address) continue;
    maxRow = Math.max(maxRow, address.row);
    maxCol = Math.max(maxCol, address.col);
  }
  const lines: string[] = [];
  for (let row = 0; row <= maxRow; row += 1) {
    const fields: string[] = [];
    for (let col = 0; col <= maxCol; col += 1) {
      const value = evaluation.valueAt(tabIndex, { col, row });
      let text: string;
      if (value === null) text = "";
      else if (isSheetError(value)) text = value.error;
      else if (typeof value === "boolean") text = value ? "TRUE" : "FALSE";
      else if (typeof value === "number") text = String(value);
      else text = guardText(value);
      fields.push(csvField(text, delimiter));
    }
    lines.push(fields.join(delimiter));
  }
  return `${options?.bom === false ? "" : "﻿"}${lines.join("\r\n")}${lines.length > 0 ? "\r\n" : ""}`;
}

/** The delimiter a file most likely uses, judged from its first lines outside quotes. */
export function detectDelimiter(text: string): SheetDelimiter {
  const sample = text.slice(0, 20_000);
  const counts: Record<SheetDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let lines = 0;
  for (const char of sample) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "," || char === ";" || char === "\t")) counts[char] += 1;
    else if (!quoted && char === "\n" && ++lines >= 20) break;
  }
  if (counts["\t"] > 0 && counts["\t"] >= counts[","]) return "\t";
  return counts[";"] > counts[","] ? ";" : ",";
}

/** RFC 4180 fields by row; quoted fields may hold the delimiter, quotes and line breaks. */
export function parseDelimited(text: string, delimiter: SheetDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      atFieldStart = true;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      continue;
    }
    field += char;
    atFieldStart = false;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvImportResult {
  readonly document: SheetDocument;
  /** Rows or columns past the Sheet's limits that were left out. */
  readonly truncated: boolean;
}

function sameFormat(a: SheetNumberFormat, b: SheetNumberFormat): boolean {
  return a.kind === b.kind && a.currency === b.currency && a.decimals === b.decimals;
}

/** Delimited text as a one-tab Sheet. Amounts like "$4.50" or "12%" keep their format per column. */
export function csvToSheetDocument(
  text: string,
  options: { readonly title: string; readonly tabName?: string; readonly delimiter?: SheetDelimiter },
): CsvImportResult {
  const rows = parseDelimited(text, options.delimiter ?? detectDelimiter(text));
  const cells: Record<string, SheetCellInput> = {};
  const columnFormats = new Map<number, SheetNumberFormat | null>();
  const columnExtent = new Map<number, { first: number; last: number }>();
  let truncated = rows.length > SHEET_LIMITS.rows;
  let count = 0;
  for (let row = 0; row < Math.min(rows.length, SHEET_LIMITS.rows); row += 1) {
    const fields = rows[row]!;
    if (fields.length > SHEET_LIMITS.columns) truncated = true;
    for (let col = 0; col < Math.min(fields.length, SHEET_LIMITS.columns); col += 1) {
      // Data only: text that looks like a formula stays text, behind an apostrophe.
      const field = fields[col]!;
      // An apostrophe before a formula sign or another apostrophe is the export
      // guard, read the way typing it would be; any other is part of the text.
      const parsed = /^'['=+\-@\t\r]/.test(field)
        ? parseCellInput(field)
        : field.startsWith("'")
          ? { input: field.slice(0, SHEET_LIMITS.textChars) }
          : parseExternalCellInput(field);
      // Only a field the cell could not hold whole counts as cut: work out how
      // long its input would be with no limit.
      const guarded = /^'['=+\-@\t\r]/.test(field);
      const needed = guarded
        ? /^'*=/.test(field.slice(1))
          ? field.length
          : field.length - 1
        : field.startsWith("'") || !/^'*=/.test(field)
          ? field.length
          : field.length + 1;
      if (typeof parsed.input === "string" && needed > SHEET_LIMITS.textChars) truncated = true;
      if (parsed.input === null) continue;
      if (count >= SHEET_LIMITS.cells) {
        truncated = true;
        break;
      }
      count += 1;
      cells[cellName({ col, row })] = parsed.input;
      if (parsed.format) {
        const known = columnFormats.get(col);
        columnFormats.set(col, known === undefined || (known && sameFormat(known, parsed.format)) ? parsed.format : null);
        const extent = columnExtent.get(col);
        columnExtent.set(col, { first: Math.min(extent?.first ?? row, row), last: Math.max(extent?.last ?? row, row) });
      }
    }
  }
  const formats: Record<string, SheetNumberFormat> = {};
  for (const [col, format] of columnFormats) {
    const extent = columnExtent.get(col);
    if (!format || !extent || Object.keys(formats).length >= SHEET_LIMITS.rangeEntries) continue;
    const letters = columnLetters(col);
    formats[`${letters}${extent.first + 1}:${letters}${extent.last + 1}`] = format;
  }
  const title = options.title.trim().slice(0, 200) || "Imported sheet";
  const tabName = (options.tabName ?? "Sheet1").trim().slice(0, SHEET_LIMITS.tabNameChars) || "Sheet1";
  const tab: SheetTab = Object.keys(formats).length > 0 ? { name: tabName, cells, formats } : { name: tabName, cells };
  return {
    document: { v: SHEET_ARTIFACT_VERSION, kind: SHEET_ARTIFACT_KIND, title, tabs: [tab] },
    truncated,
  };
}
