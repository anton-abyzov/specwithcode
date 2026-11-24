/**
 * A Sheet as the XML parts of an Excel workbook (.xlsx, Office Open XML),
 * written by hand: values, formulas with their computed values, number
 * formats, bold, italic, underline, fills, borders, alignment, column widths,
 * hidden columns, gridlines and several tabs. Pure strings; the caller zips
 * them (jszip in the browser and on the server). Nothing from the file is
 * executed, and every text is XML-escaped.
 */
import { SHEET_GRID } from "./chart.ts";
import { renameFormulaTab } from "./sheetRefs.ts";
import { type SheetEvaluation, evaluateSheet, isSheetError } from "./formula.ts";
import {
  type CellAddress,
  type SheetCellInput,
  type SheetCellStyle,
  type SheetDocument,
  type SheetNumberFormat,
  type SheetTab,
  type SheetTone,
  columnIndex,
  columnLetters,
  isFormulaInput,
  parseCellAddress,
  rangeLookup,
} from "./model.ts";

/** Excel's own limit on a tab name. */
export const XLSX_SHEET_NAME_CHARS = 31;

/** Functions newer than Excel 2007 carry a prefix in the file. */
const FUTURE_FUNCTIONS: ReadonlySet<string> = new Set(["CONCAT", "IFNA"]);

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Light fills for the theme tones, as an Excel file has to name colours. */
export const XLSX_TONE_FILLS: Readonly<Record<SheetTone | "band", string>> = {
  band: "FFF2F2F2",
  accent: "FFDBEAFE",
  positive: "FFDCFCE7",
  warning: "FFFEF3C7",
  negative: "FFFEE2E2",
  muted: "FFF1F5F9",
};

/** Font colours for the theme tones. */
export const XLSX_TONE_FONTS: Readonly<Record<SheetTone, string>> = {
  accent: "FF2563EB",
  positive: "FF15803D",
  warning: "FFB45309",
  negative: "FFDC2626",
  muted: "FF6B7280",
};

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '"$"',
  EUR: '"€"',
  GBP: '"£"',
  JPY: '"¥"',
};

export function xmlEscape(text: string): string {
  return (
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      // Characters XML 1.0 cannot hold at all.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  );
}

/** The Excel number format code for a Sheet number format, or null for General. */
export function xlsxNumberFormatCode(format: SheetNumberFormat | undefined): string | null {
  if (!format) return null;
  if (format.kind === "text") return "@";
  const fallback = format.kind === "currency" ? 2 : 0;
  const decimals = Math.max(0, Math.min(10, format.decimals ?? fallback));
  const fraction = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  if (format.kind === "percent") return `0${fraction}%`;
  const grouped = format.thousands !== false;
  let body = `${grouped ? "#,##0" : "0"}${fraction}`;
  if (format.kind === "currency") {
    const currency = format.currency ?? "USD";
    body = `${CURRENCY_SYMBOLS[currency] ?? `"${currency} "`}${body}`;
  }
  return format.negative === "parens" ? `${body};(${body})` : body;
}

/** Pixels of a column as Excel's width in characters of the default font. */
export function xlsxColumnWidth(pixels: number): number {
  return Math.round((Math.max(0, pixels - 5) / 7) * 100) / 100;
}

/** Excel's names for the tabs: at most 31 characters, still distinct. */
export function xlsxSheetNames(document: SheetDocument): string[] {
  const used = new Set<string>();
  return document.tabs.map((tab) => {
    let name = tab.name.slice(0, XLSX_SHEET_NAME_CHARS);
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const tail = ` (${suffix})`;
      name = `${tab.name.slice(0, XLSX_SHEET_NAME_CHARS - tail.length)}${tail}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** A formula as the file holds it: no "=", newer functions prefixed. */
export function xlsxFormulaText(formula: string): string {
  let out = "";
  let index = formula.startsWith("=") ? 1 : 0;
  let inString = false;
  while (index < formula.length) {
    const char = formula[index]!;
    if (char === '"') {
      inString = !inString;
      out += char;
      index += 1;
      continue;
    }
    if (!inString) {
      const match = /^[A-Za-z][A-Za-z0-9.]*(?=\()/.exec(formula.slice(index));
      const before = out.at(-1);
      if (match && (before === undefined || !/[A-Za-z0-9_.$'!]/.test(before))) {
        const name = match[0].toUpperCase();
        out += FUTURE_FUNCTIONS.has(name) ? `_xlfn.${name}` : match[0];
        index += match[0].length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

interface StyleTable {
  readonly xfIndex: (format: SheetNumberFormat | undefined, style: SheetCellStyle | undefined) => number;
  readonly xml: () => string;
}

function styleTable(): StyleTable {
  const numFmts = new Map<string, number>();
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfKeys = new Map<string, number>([["", 0]]);
  const fontKeys = new Map<string, number>([["", 0]]);
  const fillKeys = new Map<string, number>([["", 0]]);
  const borderKeys = new Map<string, number>([["", 0]]);
  const intern = (keys: Map<string, number>, list: string[], key: string, xml: string): number => {
    const found = keys.get(key);
    if (found !== undefined) return found;
    list.push(xml);
    keys.set(key, list.length - 1);
    return list.length - 1;
  };
  return {
    xfIndex: (format, style) => {
      const code = xlsxNumberFormatCode(format);
      let numFmtId = 0;
      if (code === "@") numFmtId = 49;
      else if (code !== null) {
        numFmtId = numFmts.get(code) ?? 164 + numFmts.size;
        numFmts.set(code, numFmtId);
      }
      const bold = style?.bold === true || style?.heading === true;
      const fontKey = [bold, style?.italic, style?.underline, style?.heading, style?.tone].map(String).join("|");
      const fontId =
        !bold && !style?.italic && !style?.underline && !style?.tone
          ? 0
          : intern(
              fontKeys,
              fonts,
              fontKey,
              `<font>${bold ? "<b/>" : ""}${style?.italic ? "<i/>" : ""}${style?.underline ? "<u/>" : ""}<sz val="${style?.heading ? 14 : 11}"/>${style?.tone ? `<color rgb="${XLSX_TONE_FONTS[style.tone]}"/>` : ""}<name val="Calibri"/><family val="2"/></font>`,
            );
      const fillColor = style?.fillTone ? XLSX_TONE_FILLS[style.fillTone] : style?.fill ? XLSX_TONE_FILLS.band : null;
      const fillId =
        fillColor === null
          ? 0
          : intern(
              fillKeys,
              fills,
              fillColor,
              `<fill><patternFill patternType="solid"><fgColor rgb="${fillColor}"/><bgColor indexed="64"/></patternFill></fill>`,
            );
      const side = (name: string, on: boolean | undefined, weight = "thin") =>
        on ? `<${name} style="${weight}"><color indexed="64"/></${name}>` : `<${name}/>`;
      const top = style?.topBorder ? "medium" : style?.borderTop ? "thin" : null;
      const borderKey = [style?.borderLeft, style?.borderRight, top, style?.borderBottom].map(String).join("|");
      const borderId =
        !style?.borderLeft && !style?.borderRight && top === null && !style?.borderBottom
          ? 0
          : intern(
              borderKeys,
              borders,
              borderKey,
              `<border>${side("left", style?.borderLeft)}${side("right", style?.borderRight)}${side("top", top !== null, top ?? "thin")}${side("bottom", style?.borderBottom)}<diagonal/></border>`,
            );
      const align = style?.align;
      const key = `${numFmtId}|${fontId}|${fillId}|${borderId}|${align ?? ""}`;
      if (key === "0|0|0|0|") return 0;
      return intern(
        xfKeys,
        xfs,
        key,
        `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${align ? ` applyAlignment="1"><alignment horizontal="${align}"/></xf>` : "/>"}`,
      );
    },
    xml: () => {
      const formats = [...numFmts.entries()]
        .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`)
        .join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN_NS}">${numFmts.size > 0 ? `<numFmts count="${numFmts.size}">${formats}</numFmts>` : ""}<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    },
  };
}

function cellXml(
  ref: string,
  input: SheetCellInput,
  value: ReturnType<SheetEvaluation["valueAt"]>,
  xf: number,
  sharedString: (text: string) => number,
  tabNames: ReadonlyArray<readonly [string, string]>,
): string {
  const s = xf > 0 ? ` s="${xf}"` : "";
  if (typeof input === "string" && isFormulaInput(input)) {
    let formula: string = input;
    // Formulas name the tabs as Excel names them.
    for (const [from, to] of tabNames) formula = renameFormulaTab(formula, from, to);
    const f = `<f>${xmlEscape(xlsxFormulaText(formula))}</f>`;
    if (value === null) return `<c r="${ref}"${s}>${f}</c>`;
    if (isSheetError(value)) return `<c r="${ref}"${s} t="e">${f}<v>${xmlEscape(value.error)}</v></c>`;
    if (typeof value === "boolean") return `<c r="${ref}"${s} t="b">${f}<v>${value ? 1 : 0}</v></c>`;
    if (typeof value === "number") return `<c r="${ref}"${s}>${f}<v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="str">${f}<v>${xmlEscape(value)}</v></c>`;
  }
  if (typeof input === "number") return `<c r="${ref}"${s}><v>${input}</v></c>`;
  if (typeof input === "boolean") return `<c r="${ref}"${s} t="b"><v>${input ? 1 : 0}</v></c>`;
  // A leading apostrophe keeps "=..." as text in the Sheet; Excel marks it with quotePrefix instead.
  const text = String(input);
  const stored = text.startsWith("'=") ? text.slice(1) : text;
  return `<c r="${ref}"${s} t="s"><v>${sharedString(stored)}</v></c>`;
}

function sheetXml(
  tab: SheetTab,
  tabIndex: number,
  evaluation: SheetEvaluation,
  styles: StyleTable,
  sharedString: (text: string) => number,
  tabNames: ReadonlyArray<readonly [string, string]>,
  selected: boolean,
): string {
  const formatOf = rangeLookup(tab.formats);
  const styleOf = rangeLookup(tab.styles);
  // Cells in row order, then column order, as Excel requires.
  const byRow = new Map<number, Array<{ readonly address: CellAddress; readonly name: string }>>();
  const touch = (address: CellAddress, name: string) => {
    let row = byRow.get(address.row);
    if (!row) {
      row = [];
      byRow.set(address.row, row);
    }
    if (!row.some((entry) => entry.address.col === address.col)) row.push({ address, name });
  };
  for (const name of Object.keys(tab.cells)) {
    const address = parseCellAddress(name);
    if (address) touch(address, name);
  }
  // Styled empty cells keep their look (a header band, a border) when they are few.
  for (const key of [...Object.keys(tab.styles ?? {}), ...Object.keys(tab.formats ?? {})]) {
    const [first, second] = key.split(":");
    const start = parseCellAddress(first ?? "");
    const end = parseCellAddress(second ?? first ?? "");
    if (!start || !end) continue;
    const area = (end.col - start.col + 1) * (end.row - start.row + 1);
    if (area > 2_000) continue;
    for (let row = start.row; row <= end.row; row += 1) {
      for (let col = start.col; col <= end.col; col += 1) {
        const address = { col, row };
        if (styleOf(address) !== undefined) touch(address, `${columnLetters(col)}${row + 1}`);
      }
    }
  }
  const rows = [...byRow.entries()].sort(([a], [b]) => a - b);
  const rowXml = rows
    .map(([row, cells]) => {
      cells.sort((a, b) => a.address.col - b.address.col);
      const body = cells
        .map(({ address, name }) => {
          const ref = `${columnLetters(address.col)}${address.row + 1}`;
          const xf = styles.xfIndex(formatOf(address), styleOf(address));
          const input = tab.cells[name];
          if (input === undefined) return xf > 0 ? `<c r="${ref}" s="${xf}"/>` : "";
          return cellXml(ref, input, evaluation.valueAt(tabIndex, address), xf, sharedString, tabNames);
        })
        .join("");
      return `<row r="${row + 1}">${body}</row>`;
    })
    .join("");
  const hidden = new Set((tab.hiddenColumns ?? []).map((letters) => letters.toUpperCase()));
  const widthCols = new Set([...Object.keys(tab.widths ?? {}), ...hidden]);
  const colXml = [...widthCols]
    .map((letters) => columnIndex(letters))
    .sort((a, b) => a - b)
    .map((col) => {
      const letters = columnLetters(col);
      const pixels = tab.widths?.[letters] ?? SHEET_GRID.columnWidth;
      return `<col min="${col + 1}" max="${col + 1}" width="${xlsxColumnWidth(pixels)}" customWidth="1"${hidden.has(letters) ? ' hidden="1"' : ""}/>`;
    })
    .join("");
  const view = `<sheetViews><sheetView workbookViewId="0"${tab.gridlines === false ? ' showGridLines="0"' : ""}${selected ? ' tabSelected="1"' : ""}/></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${view}<sheetFormatPr defaultRowHeight="15"/>${colXml ? `<cols>${colXml}</cols>` : ""}<sheetData>${rowXml}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

/** Every part of the workbook, by its path inside the zip. */
export function buildXlsxParts(
  document: SheetDocument,
  evaluation: SheetEvaluation = evaluateSheet(document),
): Record<string, string> {
  const names = xlsxSheetNames(document);
  const renamed = document.tabs
    .map((tab, index) => [tab.name, names[index]!] as const)
    .filter(([from, to]) => from !== to);
  const styles = styleTable();
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  let stringCount = 0;
  const sharedString = (text: string): number => {
    stringCount += 1;
    const found = stringIndex.get(text);
    if (found !== undefined) return found;
    strings.push(text);
    stringIndex.set(text, strings.length - 1);
    return strings.length - 1;
  };
  const parts: Record<string, string> = {};
  document.tabs.forEach((tab, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(
      tab,
      index,
      evaluation,
      styles,
      sharedString,
      renamed,
      index === 0,
    );
  });
  const sheetEntries = names
    .map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  parts["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><workbookPr/><bookViews><workbookView/></bookViews><sheets>${sheetEntries}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const sheetRels = names
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  const extra = names.length;
  parts["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">${sheetRels}<Relationship Id="rId${extra + 1}" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId${extra + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  parts["xl/styles.xml"] = styles.xml();
  parts["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${MAIN_NS}" count="${stringCount}" uniqueCount="${strings.length}">${strings
    .map((text) => `<si><t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ""}>${xmlEscape(text)}</t></si>`)
    .join("")}</sst>`;
  parts["docProps/core.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(document.title)}</dc:title></cp:coreProperties>`;
  parts["docProps/app.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SpecWithCode</Application></Properties>`;
  parts["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const sheetTypes = names
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  parts["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetTypes}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  return parts;
}

/** Part order in the zip: content types first, as some readers expect. */
export function xlsxPartOrder(parts: Readonly<Record<string, string>>): string[] {
  return Object.keys(parts).sort((a, b) =>
    a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : a.localeCompare(b),
  );
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
