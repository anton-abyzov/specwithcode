/**
 * Copy and paste between the Sheet editor and Excel, Google Sheets and other
 * apps. Copy writes tab-separated text and an HTML table, as both of them do;
 * paste reads either. A range copied inside the app also carries its inputs,
 * so formulas paste moved to their new place. Pasted HTML is read with
 * DOMParser as data only: nothing from it is inserted into the page or run.
 */
import {
  type CellAddress,
  type CellRange,
  type SheetCellInput,
  type SheetCellStyle,
  type SheetEvaluation,
  type SheetNumberFormat,
  type SheetTab,
  cellName,
  formatSheetValue,
  isFormulaInput,
  offsetFormula,
  parseCellInput,
} from "@specweave-studio/shared/officeSheet";

/** The most cells one copy or paste carries. */
export const SHEET_CLIPBOARD_CELLS = 50_000;
const MARKER = "data-specwithcode-sheet";

export interface SheetClipboardPayload {
  readonly text: string;
  readonly html: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tsvField(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A range as tab-separated text and an HTML table, with its inputs for the app itself. */
export function copySheetRange(input: {
  readonly tab: SheetTab;
  readonly tabIndex: number;
  readonly evaluation: SheetEvaluation;
  readonly range: CellRange;
  readonly formatOf: (address: CellAddress) => SheetNumberFormat | undefined;
  readonly styleOf: (address: CellAddress) => SheetCellStyle | undefined;
}): SheetClipboardPayload | null {
  const { range } = input;
  const width = range.end.col - range.start.col + 1;
  const height = range.end.row - range.start.row + 1;
  if (width * height > SHEET_CLIPBOARD_CELLS) return null;
  const lines: string[] = [];
  const rows: string[] = [];
  const inputs: Array<Array<SheetCellInput | null>> = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    const fields: string[] = [];
    const cells: string[] = [];
    const rowInputs: Array<SheetCellInput | null> = [];
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      const address = { col, row };
      const value = input.evaluation.valueAt(input.tabIndex, address);
      const text = formatSheetValue(value, input.formatOf(address));
      fields.push(tsvField(text));
      const style = input.styleOf(address);
      const css = [
        style?.bold || style?.heading ? "font-weight:bold" : "",
        style?.italic ? "font-style:italic" : "",
        style?.underline ? "text-decoration:underline" : "",
        style?.align ? `text-align:${style.align}` : "",
      ]
        .filter(Boolean)
        .join(";");
      const numeric = typeof value === "number" ? ` data-value="${value}"` : "";
      cells.push(
        `<td${css ? ` style="${css}"` : ""}${numeric}>${escapeHtml(text).replaceAll("\n", "<br>")}</td>`,
      );
      rowInputs.push(input.tab.cells[cellName(address)] ?? null);
    }
    lines.push(fields.join("\t"));
    rows.push(`<tr>${cells.join("")}</tr>`);
    inputs.push(rowInputs);
  }
  const source = escapeHtml(JSON.stringify({ origin: range.start, inputs }));
  return {
    text: lines.join("\n"),
    html: `<meta charset="utf-8"><table ${MARKER}="${source}"><tbody>${rows.join("")}</tbody></table>`,
  };
}

/** What a paste carries: display text by row, and the app's own inputs when it made the copy. */
export interface SheetClipboardGrid {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly internal?: {
    readonly origin: CellAddress;
    readonly inputs: ReadonlyArray<ReadonlyArray<SheetCellInput | null>>;
  };
}

/** Tab-separated text, with Excel's quoting for fields that hold tabs, quotes or line breaks. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  const source = text.replace(/\r\n?/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (char === "\t") {
      row.push(field);
      field = "";
      atFieldStart = true;
      continue;
    }
    if (char === "\n") {
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

function cellText(cell: Element): string {
  // Line breaks inside a cell are <br> or block children; everything else is text.
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += (node.textContent ?? "").replace(/[\r\n\t ]+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      out += "\n";
      return;
    }
    if (tag === "style" || tag === "script") return;
    for (const child of Array.from(element.childNodes)) walk(child);
    if ((tag === "p" || tag === "div") && element.nextSibling) out += "\n";
  };
  walk(cell);
  return out.replace(/ /g, " ").trim();
}

function readInternal(table: Element): SheetClipboardGrid["internal"] | undefined {
  const raw = table.getAttribute(MARKER);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { origin?: unknown; inputs?: unknown };
    const origin = value.origin as { col?: unknown; row?: unknown } | undefined;
    if (
      typeof origin?.col !== "number" ||
      typeof origin.row !== "number" ||
      !Array.isArray(value.inputs)
    ) {
      return undefined;
    }
    const inputs = value.inputs.map((row) =>
      Array.isArray(row)
        ? row.map((entry: unknown) =>
            typeof entry === "string" || typeof entry === "boolean" ||
            (typeof entry === "number" && Number.isFinite(entry))
              ? entry
              : null,
          )
        : [],
    );
    return { origin: { col: origin.col, row: origin.row }, inputs };
  } catch {
    return undefined;
  }
}

/** The first table in pasted HTML, as rows of text with merged cells spread out. */
export function parseClipboardHtml(html: string): SheetClipboardGrid | null {
  if (typeof DOMParser === "undefined") return null;
  // DOMParser builds an inert document: no script runs and nothing loads.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const table = parsed.querySelector("table");
  if (!table) return null;
  const rows: string[][] = [];
  const pending: Array<Array<string | undefined>> = [];
  let count = 0;
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    if (tr.closest("table") !== table) continue;
    const rowIndex = rows.length;
    const row: string[] = [];
    const carried = pending[rowIndex] ?? [];
    let col = 0;
    const place = (text: string) => {
      while (carried[col] !== undefined) {
        row[col] = carried[col]!;
        col += 1;
      }
      row[col] = text;
      col += 1;
    };
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      const text = cellText(cell);
      const span = Math.max(1, Math.min(100, Number(cell.getAttribute("colspan")) || 1));
      const down = Math.max(1, Math.min(1000, Number(cell.getAttribute("rowspan")) || 1));
      for (let extra = 0; extra < span; extra += 1) {
        const at = col;
        place(extra === 0 ? text : "");
        for (let below = 1; below < down; below += 1) {
          (pending[rowIndex + below] ??= [])[at] = "";
        }
      }
      count += span;
      if (count > SHEET_CLIPBOARD_CELLS) return null;
    }
    while (carried[col] !== undefined) {
      row[col] = carried[col]!;
      col += 1;
    }
    rows.push(Array.from(row, (entry) => entry ?? ""));
  }
  if (rows.length === 0) return null;
  const internal = readInternal(table);
  return internal ? { rows, internal } : { rows };
}

/** Read a paste: the app's own table first, then any HTML table, then plain text. */
export function readSheetClipboard(data: { readonly html?: string; readonly text?: string }): SheetClipboardGrid | null {
  if (data.html && /<table/i.test(data.html)) {
    const grid = parseClipboardHtml(data.html);
    if (grid) return grid;
  }
  if (data.text === undefined || data.text.length === 0) return null;
  const rows = parseTsv(data.text);
  if (rows.reduce((sum, row) => sum + row.length, 0) > SHEET_CLIPBOARD_CELLS) return null;
  return rows.length > 0 ? { rows } : null;
}

export interface SheetPastePlan {
  readonly entries: ReadonlyArray<readonly [CellAddress, SheetCellInput | null]>;
  readonly formats: ReadonlyArray<readonly [CellAddress, SheetNumberFormat]>;
  /** The cells the paste covers. */
  readonly range: CellRange;
}

/**
 * Where each pasted cell goes. A single copied cell fills a larger selection,
 * as in a spreadsheet; otherwise the copy keeps its shape from the selection's
 * top-left cell. Formulas copied in the app move with the paste.
 */
export function planSheetPaste(
  grid: SheetClipboardGrid,
  selection: CellRange,
  limits: { readonly rows: number; readonly columns: number },
): SheetPastePlan | null {
  const height = grid.rows.length;
  const width = Math.max(0, ...grid.rows.map((row) => row.length));
  if (height === 0 || width === 0) return null;
  const selHeight = selection.end.row - selection.start.row + 1;
  const selWidth = selection.end.col - selection.start.col + 1;
  const tile = height === 1 && width === 1 && selHeight * selWidth > 1;
  const outHeight = tile ? selHeight : height;
  const outWidth = tile ? selWidth : width;
  const start = selection.start;
  if (start.row + outHeight > limits.rows || start.col + outWidth > limits.columns) return null;
  const entries: Array<readonly [CellAddress, SheetCellInput | null]> = [];
  const formats: Array<readonly [CellAddress, SheetNumberFormat]> = [];
  for (let r = 0; r < outHeight; r += 1) {
    for (let c = 0; c < outWidth; c += 1) {
      const sr = tile ? 0 : r;
      const sc = tile ? 0 : c;
      const address = { col: start.col + c, row: start.row + r };
      const internal = grid.internal?.inputs[sr]?.[sc];
      if (grid.internal && internal !== undefined) {
        const dCol = address.col - (grid.internal.origin.col + sc);
        const dRow = address.row - (grid.internal.origin.row + sr);
        entries.push([address, internal !== null && isFormulaInput(internal) ? offsetFormula(internal, dCol, dRow) : internal]);
        continue;
      }
      const parsed = parseCellInput(grid.rows[sr]?.[sc] ?? "");
      entries.push([address, parsed.input]);
      if (parsed.format) formats.push([address, parsed.format]);
    }
  }
  return {
    entries,
    formats,
    range: {
      start,
      end: { col: start.col + outWidth - 1, row: start.row + outHeight - 1 },
    },
  };
}
