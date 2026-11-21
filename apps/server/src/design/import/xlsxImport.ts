/**
 * Read-only Excel (.xlsx) OOXML preview parser.
 * Converts an `.xlsx` workbook into SpecWithCode's canonical `SheetDocument` JSON
 * so `SheetView` renders multi-sheet workbooks with tabs, formatted values,
 * formulas, column widths, and honest disclosure of unsupported workbook features.
 */
import type { DesignPreviewWorkbookResult } from "@specweave-studio/contracts";
import {
  isFormulaSupported,
  parseCellAddress,
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  validateSheetDocument,
  type SheetCellStyle,
  type SheetDocument,
  type SheetNumberFormat,
  type SheetTab,
} from "@specweave-studio/shared/officeSheet";

function parseCachedCellValue(
  vEl: XmlElement | undefined,
  cellType: string,
  isDate: boolean,
  date1904: boolean,
): { readonly value: string | number | boolean; readonly isLiteralString: boolean } | undefined {
  if (!vEl) return undefined;
  const rawV = collectText(vEl);
  if (cellType === "b") {
    const trimmed = rawV.trim();
    if (trimmed.length === 0) return undefined;
    return { value: trimmed === "1", isLiteralString: false };
  }
  if (cellType === "str" || cellType === "e") {
    return { value: rawV, isLiteralString: true };
  }
  const trimmed = rawV.trim();
  if (trimmed.length === 0) return undefined;
  const num = Number(trimmed);
  if (Number.isNaN(num)) {
    return { value: rawV, isLiteralString: true };
  }
  return {
    value: isDate ? excelSerialToIsoDate(num, date1904) : num,
    isLiteralString: false,
  };
}

function normalizeCellValue(
  value: string | number | boolean,
  isLiteralString: boolean,
): string | number | boolean {
  let out = value;
  if (isLiteralString && typeof out === "string" && out.startsWith("=")) {
    out = `'${out}`;
  }
  if (typeof out === "string" && out.length > SHEET_LIMITS.textChars) {
    out = `${out.slice(0, SHEET_LIMITS.textChars - 1)}…`;
  }
  return out;
}

import {
  assertNoMacros,
  DEFAULT_OOXML_LIMITS,
  openOoxmlArchive,
  OoxmlPreviewError,
  readRelationships,
  resolveOoxmlTarget,
  type OoxmlArchive,
} from "./ooxmlZip.ts";
import { localName, type XmlElement } from "./xml.ts";

const MAX_PREVIEW_CELLS_PER_TAB = Math.min(SHEET_LIMITS.cells, 12_000);
const MAX_PREVIEW_TABS = SHEET_LIMITS.tabs;
const MAX_APPROX_JSON_BYTES = Math.floor(SHEET_LIMITS.bytes * 0.85);

function findChild(el: XmlElement | undefined, local: string): XmlElement | undefined {
  return el?.children.find((kid) => localName(kid) === local);
}

function findChildren(el: XmlElement | undefined, local: string): XmlElement[] {
  return el?.children.filter((kid) => localName(kid) === local) ?? [];
}

function collectText(el: XmlElement): string {
  let out = el.text;
  for (const kid of el.children) out += collectText(kid);
  return out;
}

function columnIndexToLetters(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface ParsedStyles {
  readonly xfFormat: ReadonlyArray<SheetNumberFormat | undefined>;
  readonly xfStyle: ReadonlyArray<SheetCellStyle | undefined>;
  readonly xfIsDate: ReadonlyArray<boolean>;
}

/** Maps Excel built-in and custom number format codes to `SheetNumberFormat`. */
function classifyNumFmt(numFmtId: number, formatCode?: string): { format?: SheetNumberFormat; isDate: boolean } {
  // Excel built-in date formats: 14-17 and 22 (skip time-only/elapsed formats 18-21, 45-47).
  if ((numFmtId >= 14 && numFmtId <= 17) || numFmtId === 22) {
    return { isDate: true };
  }
  if ((numFmtId >= 18 && numFmtId <= 21) || (numFmtId >= 45 && numFmtId <= 47)) {
    return { isDate: false };
  }
  if (numFmtId === 1 || numFmtId === 3) return { format: { kind: "number", decimals: 0 }, isDate: false };
  if (numFmtId === 2 || numFmtId === 4) return { format: { kind: "number", decimals: 2 }, isDate: false };
  if (numFmtId === 9) return { format: { kind: "percent", decimals: 0 }, isDate: false };
  if (numFmtId === 10) return { format: { kind: "percent", decimals: 2 }, isDate: false };
  if (numFmtId === 5 || numFmtId === 6 || numFmtId === 37 || numFmtId === 38) {
    return { format: { kind: "currency", decimals: 0 }, isDate: false };
  }
  if (numFmtId === 7 || numFmtId === 8 || numFmtId === 39 || numFmtId === 40 || numFmtId === 44) {
    return { format: { kind: "currency", decimals: 2 }, isDate: false };
  }
  if (!formatCode) return { isDate: false };

  const primary = formatCode.split(";")[0] ?? formatCode;
  // Strip quoted strings and bracket tokens like [$-409] or [Red]
  const stripped = primary.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  // Require date tokens (y or d) so time-only / elapsed-time codes aren't misread as calendar dates.
  if (/[yd]/i.test(stripped) && !/[#0]/.test(stripped.replace(/0+/g, ""))) {
    return { isDate: true };
  }
  if (stripped.includes("%")) {
    const decMatch = /\.([0#]+)/.exec(stripped);
    return { format: { kind: "percent", decimals: decMatch ? decMatch[1]!.length : 0 }, isDate: false };
  }
  const currencyMatch = /([$€£¥])/.exec(primary);
  if (currencyMatch) {
    const decMatch = /\.([0#]+)/.exec(stripped);
    const symbol = currencyMatch[1]!;
    const currency = symbol === "€" ? "EUR" : symbol === "£" ? "GBP" : symbol === "¥" ? "JPY" : "USD";
    return {
      format: { kind: "currency", currency, decimals: decMatch ? decMatch[1]!.length : 2 },
      isDate: false,
    };
  }
  if (/[#0]/.test(stripped)) {
    const decMatch = /\.([0#]+)/.exec(stripped);
    if (decMatch) return { format: { kind: "number", decimals: decMatch[1]!.length }, isDate: false };
    if (stripped.includes(",")) return { format: { kind: "number", decimals: 0 }, isDate: false };
  }
  return { isDate: false };
}

/** Converts an Excel serial date number (1900 or 1904 date system) into ISO date without `new Date()`. */
function excelSerialToIsoDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0) return String(serial);
  const wholeDays = Math.floor(serial);
  // 1904 system: serial 0 is 1904-01-01 (Unix day -24107).
  // 1900 system: serial 1 is 1900-01-01; Excel's 1900 leap-year bug treats serial 60 as 1900-02-29,
  // so serials >= 60 offset by -25569 and serials 1..59 offset by -25568.
  const unixDays = date1904
    ? wholeDays - 24107
    : wholeDays >= 60
      ? wholeDays - 25569
      : wholeDays - 25568;
  const z = unixDays + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  if (!Number.isFinite(year) || year < 1900 || year > 9999) return String(serial);
  const isoDate = `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const frac = serial - wholeDays;
  if (frac > 1e-6) {
    const totalMinutes = Math.round(frac * 24 * 60) % (24 * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `${isoDate} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return isoDate;
}

function readStyles(archive: OoxmlArchive): ParsedStyles {
  const root = archive.readXml("xl/styles.xml");
  if (!root) return { xfFormat: [], xfStyle: [], xfIsDate: [] };

  const customNumFmts = new Map<number, string>();
  const numFmtsEl = findChild(root, "numFmts");
  for (const nf of findChildren(numFmtsEl, "numFmt")) {
    const id = Number(nf.attrs.numFmtId);
    if (Number.isInteger(id) && nf.attrs.formatCode) {
      customNumFmts.set(id, nf.attrs.formatCode);
    }
  }

  const boldFonts: boolean[] = [];
  const fontsEl = findChild(root, "fonts");
  for (const font of findChildren(fontsEl, "font")) {
    const b = findChild(font, "b");
    boldFonts.push(b !== undefined && b.attrs.val !== "0" && b.attrs.val !== "false");
  }

  const xfFormat: Array<SheetNumberFormat | undefined> = [];
  const xfStyle: Array<SheetCellStyle | undefined> = [];
  const xfIsDate: boolean[] = [];

  const cellXfsEl = findChild(root, "cellXfs");
  for (const xf of findChildren(cellXfsEl, "xf")) {
    const numFmtId = Number(xf.attrs.numFmtId ?? 0);
    const classified = classifyNumFmt(numFmtId, customNumFmts.get(numFmtId));
    xfFormat.push(classified.format);
    xfIsDate.push(classified.isDate);

    const fontId = Number(xf.attrs.fontId ?? -1);
    const isBold = fontId >= 0 && boldFonts[fontId] === true;
    const alignEl = findChild(xf, "alignment");
    const hAlign = alignEl?.attrs.horizontal;
    const align =
      hAlign === "left" || hAlign === "center" || hAlign === "right" ? hAlign : undefined;
    if (isBold || align) {
      xfStyle.push({
        ...(isBold ? { bold: true } : {}),
        ...(align ? { align } : {}),
      });
    } else {
      xfStyle.push(undefined);
    }
  }

  return { xfFormat, xfStyle, xfIsDate };
}

function readSharedStrings(archive: OoxmlArchive): string[] {
  const root = archive.readXml("xl/sharedStrings.xml");
  if (!root) return [];
  const out: string[] = [];
  for (const si of findChildren(root, "si")) {
    out.push(collectText(si));
  }
  return out;
}

const FORMULA_REF_TOKEN_RE =
  /"(?:""|[^"])*"|(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.\u0080-\uFFFF]+))!)?\$?([A-Za-z]{1,3})\$?([1-9]\d*)(?::\$?([A-Za-z]{1,3})\$?([1-9]\d*))?/g;

function formulaDependsOnConvertedDate(
  formula: string,
  currentTabIndex: number,
  tabIndexByName: Map<string, number>,
  convertedDateCoordsByTab: Map<number, Array<{ col: number; row: number }>>,
): boolean {
  FORMULA_REF_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FORMULA_REF_TOKEN_RE.exec(formula)) !== null) {
    if (match[0].startsWith('"')) continue;
    const matchEnd = match.index + match[0].length;
    if (formula[matchEnd] === "(") continue;
    const sheetName = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
    const targetTabIndex =
      sheetName !== undefined ? tabIndexByName.get(sheetName.toLowerCase()) : currentTabIndex;
    if (targetTabIndex === undefined) continue;
    const dateCoords = convertedDateCoordsByTab.get(targetTabIndex);
    if (!dateCoords || dateCoords.length === 0) continue;
    const startAddr = parseCellAddress(`${match[3]}${match[4]}`);
    if (!startAddr) continue;
    const endAddr = match[5] && match[6] ? parseCellAddress(`${match[5]}${match[6]}`) : startAddr;
    if (!endAddr) continue;
    const minCol = Math.min(startAddr.col, endAddr.col);
    const maxCol = Math.max(startAddr.col, endAddr.col);
    const minRow = Math.min(startAddr.row, endAddr.row);
    const maxRow = Math.max(startAddr.row, endAddr.row);
    for (const coord of dateCoords) {
      if (coord.col >= minCol && coord.col <= maxCol && coord.row >= minRow && coord.row <= maxRow) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parses an `.xlsx` binary into a `DesignPreviewWorkbookResult`.
 */
export async function readXlsxWorkbook(
  bytes: Uint8Array,
  title: string,
): Promise<DesignPreviewWorkbookResult> {
  const archive = await openOoxmlArchive(bytes, DEFAULT_OOXML_LIMITS);
  assertNoMacros(archive);

  const workbookXml = archive.readXml("xl/workbook.xml");
  if (!workbookXml) {
    throw new OoxmlPreviewError("invalid", "The file is not a valid Excel workbook (.xlsx).");
  }

  const rels = readRelationships(archive, "xl/_rels/workbook.xml.rels");
  const sharedStrings = readSharedStrings(archive);
  const styles = readStyles(archive);
  const workbookPr = findChild(workbookXml, "workbookPr");
  const date1904 =
    workbookPr?.attrs.date1904 === "1" ||
    workbookPr?.attrs.date1904?.toLowerCase() === "true";

  const sheetsEl = findChild(workbookXml, "sheets");
  const sheetNodes = findChildren(sheetsEl, "sheet");
  if (sheetNodes.length === 0) {
    throw new OoxmlPreviewError("invalid", "This Excel workbook has no worksheets.");
  }

  const unsupported = new Set<string>();
  for (const partPath of archive.entries.keys()) {
    if (/^xl\/charts\//i.test(partPath)) unsupported.add("Charts");
    if (/^xl\/pivotTables\//i.test(partPath)) unsupported.add("Pivot tables");
    if (/^xl\/comments\d*\.xml$/i.test(partPath)) unsupported.add("Cell comments");
    if (/^xl\/drawings\//i.test(partPath)) unsupported.add("Embedded drawings/images");
    if (/^xl\/externalLinks\//i.test(partPath)) unsupported.add("External workbook links");
  }

  const tabs: SheetTab[] = [];
  const usedTabNames = new Set<string>();
  let truncatedSheets = 0;
  let totalWorkbookCells = 0;
  let approxJsonBytes = 256;
  const liveFormulaEntries: Array<{
    tabIndex: number;
    ref: string;
    col: number;
    row: number;
    formula: string;
    cachedValue: string | number | boolean | undefined;
    isDate: boolean;
  }> = [];
  const convertedDateCoordsByTab = new Map<number, Array<{ col: number; row: number }>>();
  const recordConvertedDate = (tabIndex: number, col: number, row: number): void => {
    let list = convertedDateCoordsByTab.get(tabIndex);
    if (!list) {
      list = [];
      convertedDateCoordsByTab.set(tabIndex, list);
    }
    list.push({ col, row });
  };

  for (const sheetNode of sheetNodes) {
    if (tabs.length >= MAX_PREVIEW_TABS) {
      truncatedSheets += 1;
      continue;
    }
    const rawName = (sheetNode.attrs.name ?? `Sheet ${tabs.length + 1}`).trim() || `Sheet ${tabs.length + 1}`;
    let name = rawName.slice(0, SHEET_LIMITS.tabNameChars);
    if (usedTabNames.has(name.toLowerCase())) {
      let suffix = 2;
      while (usedTabNames.has(`${name.slice(0, SHEET_LIMITS.tabNameChars - 4)} (${suffix})`.toLowerCase())) {
        suffix += 1;
      }
      name = `${name.slice(0, SHEET_LIMITS.tabNameChars - 4)} (${suffix})`;
    }
    usedTabNames.add(name.toLowerCase());
    const relId = sheetNode.attrs["r:id"] ?? sheetNode.attrs.id;
    const rel = relId ? rels.get(relId) : undefined;
    const sheetPath = rel && !rel.external ? resolveOoxmlTarget("xl/workbook.xml", rel.target) : null;
    if (!sheetPath) continue;

    const sheetXml = archive.readXml(sheetPath);
    if (!sheetXml) continue;

    const mergeCellsEl = findChild(sheetXml, "mergeCells");
    if (mergeCellsEl && findChildren(mergeCellsEl, "mergeCell").length > 0) {
      unsupported.add("Merged cell spans");
    }

    const widths: Record<string, number> = {};
    const colsEl = findChild(sheetXml, "cols");
    for (const col of findChildren(colsEl, "col")) {
      const min = Number(col.attrs.min);
      const max = Number(col.attrs.max);
      const widthChars = Number(col.attrs.width);
      if (
        Number.isSafeInteger(min) &&
        Number.isSafeInteger(max) &&
        min >= 1 &&
        min <= SHEET_LIMITS.columns &&
        max >= min &&
        Number.isFinite(widthChars) &&
        widthChars > 0
      ) {
        const px = Math.max(48, Math.min(480, Math.round(widthChars * 7.5 + 12)));
        const cappedMax = Math.min(max, min + 40, SHEET_LIMITS.columns);
        for (let c = min; c <= cappedMax; c += 1) {
          widths[columnIndexToLetters(c)] = px;
        }
      }
    }

    const cells: Record<string, string | number | boolean> = {};
    const formats: Record<string, SheetNumberFormat> = {};
    const cellStyles: Record<string, SheetCellStyle> = {};
    let cellCount = 0;
    let formatCount = 0;
    let styleCount = 0;
    let tabTruncated = false;
    let budgetExhausted = false;

    const sheetData = findChild(sheetXml, "sheetData");
    const currentTabIndex = tabs.length;
    for (const row of findChildren(sheetData, "row")) {
      if (budgetExhausted) break;
      for (const cell of findChildren(row, "c")) {
        const ref = cell.attrs.r?.toUpperCase();
        if (!ref) continue;
        const parsedAddr = parseCellAddress(ref);
        if (parsedAddr === null) {
          tabTruncated = true;
          continue;
        }

        const cellType = cell.attrs.t ?? "n";
        const styleIdx = cell.attrs.s !== undefined ? Number(cell.attrs.s) : -1;
        const isDate = styleIdx >= 0 && styles.xfIsDate[styleIdx] === true;
        const fEl = findChild(cell, "f");
        const vEl = findChild(cell, "v");
        const isEl = findChild(cell, "is");

        let value: string | number | boolean | undefined;
        let isLiteralString = false;
        let pendingLiveFormula:
          | {
              formula: string;
              cachedValue: string | number | boolean | undefined;
              isDate: boolean;
            }
          | undefined;
        let cellTaintsDownstreamFormulas = false;

        if (fEl) {
          const formulaText = collectText(fEl).trim();
          const formulaType = fEl.attrs.t;
          // Check type and length before any further processing (O(1) guard).
          const isSharedOrArray = formulaType === "array" || formulaType === "shared";
          const normalizedFormula =
            !isSharedOrArray && formulaText.length > 0 && formulaText.length <= SHEET_LIMITS.formulaChars
              ? formulaText.startsWith("=")
                ? formulaText
                : `=${formulaText}`
              : null;
          const withinFormulaCap =
            normalizedFormula !== null && normalizedFormula.length <= SHEET_LIMITS.formulaChars;

          const parsedCache = parseCachedCellValue(vEl, cellType, isDate, date1904);
          const normalizedCache = parsedCache
            ? normalizeCellValue(parsedCache.value, parsedCache.isLiteralString)
            : undefined;

          if (withinFormulaCap && normalizedFormula !== null) {
            if (isFormulaSupported(normalizedFormula)) {
              value = normalizedFormula;
              pendingLiveFormula = {
                formula: normalizedFormula,
                cachedValue: normalizedCache,
                isDate,
              };
            } else if (normalizedCache !== undefined) {
              value = normalizedCache;
              cellTaintsDownstreamFormulas = isDate && typeof normalizedCache === "string";
              unsupported.add("Unsupported Excel formulas (showing cached values)");
            } else {
              // No cached value is present; mark the cell unavailable instead of letting
              // live evaluation silently mask an unsupported function (e.g. inside IFERROR).
              value = "#UNSUPPORTED";
              cellTaintsDownstreamFormulas = true;
              unsupported.add("Unsupported Excel formulas (some cells have no cached value)");
            }
          } else {
            if (isSharedOrArray) {
              unsupported.add("Shared/array formulas (showing cached values)");
            } else if (formulaText.length > 0) {
              unsupported.add("Long formulas (showing cached values)");
            }
            if (normalizedCache !== undefined) {
              value = normalizedCache;
              cellTaintsDownstreamFormulas = isDate && typeof normalizedCache === "string";
            }
          }
        } else if (cellType === "s") {
          const idx = Number(vEl ? collectText(vEl) : "");
          if (Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length) {
            value = normalizeCellValue(sharedStrings[idx]!, true);
          }
        } else if (cellType === "inlineStr") {
          value = normalizeCellValue(isEl ? collectText(isEl) : "", true);
        } else {
          const parsedCell = parseCachedCellValue(vEl, cellType, isDate, date1904);
          if (parsedCell !== undefined) {
            value = normalizeCellValue(parsedCell.value, parsedCell.isLiteralString);
            isLiteralString = parsedCell.isLiteralString;
            cellTaintsDownstreamFormulas = isDate && typeof value === "string";
          }
        }

        if (value === undefined) continue;
        void isLiteralString;

        // Count exact JSON-serialized byte length (including escaping and delimiters)
        // so heavily escaped text cannot overflow SHEET_LIMITS.bytes after insertion.
        const estEntryBytes =
          Buffer.byteLength(JSON.stringify(ref)) + Buffer.byteLength(JSON.stringify(value)) + 4;
        if (
          cellCount >= MAX_PREVIEW_CELLS_PER_TAB ||
          totalWorkbookCells >= SHEET_LIMITS.cells ||
          approxJsonBytes + estEntryBytes > MAX_APPROX_JSON_BYTES
        ) {
          tabTruncated = true;
          budgetExhausted = true;
          break;
        }
        cells[ref] = value;
        cellCount += 1;
        totalWorkbookCells += 1;
        approxJsonBytes += estEntryBytes;
        if (pendingLiveFormula) {
          liveFormulaEntries.push({
            tabIndex: currentTabIndex,
            ref,
            col: parsedAddr.col,
            row: parsedAddr.row,
            ...pendingLiveFormula,
          });
        } else if (cellTaintsDownstreamFormulas) {
          recordConvertedDate(currentTabIndex, parsedAddr.col, parsedAddr.row);
        }

        if (styleIdx >= 0 && !isDate && formatCount < SHEET_LIMITS.rangeEntries) {
          const fmt = styles.xfFormat[styleIdx];
          if (fmt) {
            const fmtBytes = Buffer.byteLength(JSON.stringify(ref)) + Buffer.byteLength(JSON.stringify(fmt)) + 4;
            if (approxJsonBytes + fmtBytes < MAX_APPROX_JSON_BYTES) {
              formats[ref] = fmt;
              formatCount += 1;
              approxJsonBytes += fmtBytes;
            }
          }
        }
        if (styleIdx >= 0 && styleCount < SHEET_LIMITS.rangeEntries) {
          const st = styles.xfStyle[styleIdx];
          if (st) {
            const stBytes = Buffer.byteLength(JSON.stringify(ref)) + Buffer.byteLength(JSON.stringify(st)) + 4;
            if (approxJsonBytes + stBytes < MAX_APPROX_JSON_BYTES) {
              cellStyles[ref] = st;
              styleCount += 1;
              approxJsonBytes += stBytes;
            }
          }
        }
      }
    }

    if (tabTruncated) {
      truncatedSheets += 1;
    }

    tabs.push({
      name,
      cells,
      ...(Object.keys(formats).length > 0 ? { formats } : {}),
      ...(Object.keys(cellStyles).length > 0 ? { styles: cellStyles } : {}),
      ...(Object.keys(widths).length > 0 ? { widths } : {}),
    });
  }

  if (tabs.length === 0) {
    throw new OoxmlPreviewError("invalid", "No readable worksheets were found in this workbook.");
  }

  // Conservatively fall back live formulas to their cached values when workbook truncation
  // could have omitted referenced inputs, or when a formula depends on date serials that
  // were converted to ISO text strings (or is itself date-formatted).
  if (truncatedSheets > 0 && liveFormulaEntries.length > 0) {
    for (const entry of liveFormulaEntries) {
      if (entry.cachedValue !== undefined) {
        tabs[entry.tabIndex]!.cells[entry.ref] = entry.cachedValue;
        unsupported.add("Formulas on truncated workbook (showing cached values)");
      } else {
        tabs[entry.tabIndex]!.cells[entry.ref] = "#UNSUPPORTED";
        unsupported.add("Formulas on truncated workbook (some cells have no cached value)");
      }
    }
  } else if (liveFormulaEntries.length > 0) {
    const tabIndexByName = new Map(tabs.map((tab, idx) => [tab.name.toLowerCase(), idx]));
    let remaining = liveFormulaEntries;
    let changed = true;
    while (changed && remaining.length > 0) {
      changed = false;
      const nextRemaining: typeof remaining = [];
      for (const entry of remaining) {
        if (
          entry.isDate ||
          (convertedDateCoordsByTab.size > 0 &&
            formulaDependsOnConvertedDate(
              entry.formula,
              entry.tabIndex,
              tabIndexByName,
              convertedDateCoordsByTab,
            ))
        ) {
          if (entry.cachedValue !== undefined) {
            tabs[entry.tabIndex]!.cells[entry.ref] = entry.cachedValue;
            unsupported.add("Formulas referencing date or unavailable cells (showing cached values)");
          } else {
            tabs[entry.tabIndex]!.cells[entry.ref] = "#UNSUPPORTED";
            unsupported.add("Formulas referencing date or unavailable cells (some cells have no cached value)");
          }
          // Propagate any cell whose value became a date string or #UNSUPPORTED marker
          // so downstream totals (e.g. SUM over an uncached intermediate) keep their cached values.
          if (entry.isDate || entry.cachedValue === undefined || typeof entry.cachedValue === "string") {
            recordConvertedDate(entry.tabIndex, entry.col, entry.row);
          }
          changed = true;
        } else {
          nextRemaining.push(entry);
        }
      }
      remaining = nextRemaining;
    }
  }

  let doc: SheetDocument = {
    v: SHEET_ARTIFACT_VERSION,
    kind: SHEET_ARTIFACT_KIND,
    title: title.slice(0, SHEET_LIMITS.titleChars),
    tabs,
  };

  let sheetJson = JSON.stringify(doc);

  // If serialized JSON still exceeds SHEET_LIMITS.bytes, drop optional styling metadata before failing.
  if (Buffer.byteLength(sheetJson) > SHEET_LIMITS.bytes) {
    doc = {
      ...doc,
      tabs: doc.tabs.map((tab) => ({ name: tab.name, cells: tab.cells })),
    };
    sheetJson = JSON.stringify(doc);
    if (Buffer.byteLength(sheetJson) > SHEET_LIMITS.bytes) {
      throw new OoxmlPreviewError("too_large", "This workbook exceeds the preview size limit.");
    }
  }

  const validation = validateSheetDocument(doc);
  if (!validation.ok) {
    throw new OoxmlPreviewError("invalid", `Could not build a valid workbook preview: ${validation.error}`);
  }

  return {
    sheetJson,
    sheetCount: sheetNodes.length,
    truncatedSheets,
    unsupportedFeatures: [...unsupported],
  };
}
