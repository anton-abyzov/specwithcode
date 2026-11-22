/**
 * Read-only Excel (.xlsx) OOXML preview parser.
 * Converts an `.xlsx` workbook into SpecWithCode's canonical `SheetDocument` JSON
 * so `SheetView` renders multi-sheet workbooks with tabs, formatted values,
 * formulas, column widths, and honest disclosure of unsupported workbook features.
 */
import type { DesignPreviewWorkbookResult } from "@specweave-studio/contracts";
import {
  dateSerial,
  collectFormulaReferences,
  evaluateSheet,
  isFormulaSupported,
  isSheetError,
  parseCellAddress,
  rangeName,
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  validateSheetDocument,
  type SheetCellInput,
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
  if (cellType === "str" || cellType === "e" || cellType === "d") {
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

/** 1900-03-01: from here on a date and its serial number agree in every workbook of the 1900 system. */
const FIRST_UNAMBIGUOUS_SERIAL = 61;

/**
 * True when XNPV and XIRR read this imported date exactly as Excel did: text
 * the formula engine turns back into the serial the cell held. Dates before
 * March 1900 sit on Excel's phantom leap day, and a date with a time zone is
 * not one the engine reads; a formula over those keeps Excel's saved number.
 * A workbook of the 1904 system is ruled out by the caller, since its plain
 * serial numbers count from another day than its dates.
 */
function isDatedFlowDate(value: string | number | boolean): boolean {
  if (typeof value !== "string") return false;
  const serial = dateSerial(value);
  return typeof serial === "number" && serial >= FIRST_UNAMBIGUOUS_SERIAL;
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

const MAX_TAINT_PROPAGATION_OPS = 200_000;

const FORMATS_DROPPED_NOTE = "Some number formats (too many different ranges)";
const STYLES_DROPPED_NOTE = "Some bold and alignment (too many different ranges)";
const STYLING_DROPPED_NOTE = "Number formats, bold, alignment and column widths (workbook too large)";

/** One cell that carries a number format or a style, by the JSON of what it carries. */
interface CellMark {
  readonly col: number;
  readonly row: number;
  readonly key: string;
}

/** The widest run of rows without the mark that a range may still cover. */
const MAX_BRIDGED_ROWS = 64;

/**
 * Join cells that carry the same mark into rectangles, top of the sheet first,
 * so a formatted column costs one range instead of one per cell. `mayCover`
 * says whether an unmarked cell between two marked ones may sit inside the
 * range; without it only touching cells are joined.
 */
function mergeCellMarks(
  marks: ReadonlyArray<CellMark>,
  mayCover?: (col: number, row: number) => boolean,
): Array<{ readonly range: string; readonly key: string }> {
  const byKey = new Map<string, Map<number, number[]>>();
  for (const mark of marks) {
    let columns = byKey.get(mark.key);
    if (!columns) byKey.set(mark.key, (columns = new Map()));
    const rows = columns.get(mark.col);
    if (rows) rows.push(mark.row);
    else columns.set(mark.col, [mark.row]);
  }
  const bridges = (col: number, from: number, to: number): boolean => {
    if (!mayCover || to - from + 1 > MAX_BRIDGED_ROWS) return false;
    for (let row = from; row <= to; row += 1) if (!mayCover(col, row)) return false;
    return true;
  };
  const boxes: Array<{ left: number; right: number; top: number; bottom: number; key: string }> = [];
  for (const [key, columns] of byKey) {
    const runs: Array<{ col: number; top: number; bottom: number }> = [];
    for (const [col, rows] of columns) {
      rows.sort((a, b) => a - b);
      let top = rows[0]!;
      let bottom = top;
      for (const row of rows) {
        if (row <= bottom + 1 || bridges(col, bottom + 1, row - 1)) {
          bottom = Math.max(bottom, row);
          continue;
        }
        runs.push({ col, top, bottom });
        top = bottom = row;
      }
      runs.push({ col, top, bottom });
    }
    // Columns side by side that span the same rows make one rectangle.
    runs.sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.col - b.col);
    let box: (typeof boxes)[number] | undefined;
    for (const run of runs) {
      if (box && box.top === run.top && box.bottom === run.bottom && run.col === box.right + 1) {
        box.right = run.col;
        continue;
      }
      box = { left: run.col, right: run.col, top: run.top, bottom: run.bottom, key };
      boxes.push(box);
    }
  }
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  return boxes.map((box) => ({
    key: box.key,
    range: rangeName({
      start: { col: box.left, row: box.top },
      end: { col: box.right, row: box.bottom },
    }),
  }));
}

interface ParsedFormulaRef {
  readonly tabIndex: number;
  readonly minCol: number;
  readonly maxCol: number;
  readonly minRow: number;
  readonly maxRow: number;
  /** The dates argument of XNPV or XIRR: a date cell there is read, not a reason to fall back. */
  readonly dates: boolean;
}

function extractFormulaRefs(
  formula: string,
  currentTabIndex: number,
  tabIndexByName: Map<string, number>,
): ParsedFormulaRef[] {
  const refs: ParsedFormulaRef[] = [];
  for (const ref of collectFormulaReferences(formula)) {
    const targetTabIndex =
      ref.tab !== null ? tabIndexByName.get(ref.tab.toLowerCase()) : currentTabIndex;
    if (targetTabIndex === undefined) continue;
    refs.push({
      tabIndex: targetTabIndex,
      minCol: ref.minCol,
      maxCol: ref.maxCol,
      minRow: ref.minRow,
      maxRow: ref.maxRow,
      dates: ref.dates === true,
    });
  }
  return refs;
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

  const tabs: Array<Omit<SheetTab, "cells"> & { cells: Record<string, SheetCellInput> }> = [];
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
  // Plain date cells, kept as `YYYY-MM-DD` text. XNPV and XIRR read them as they are.
  const dateCellKeys = new Set<string>();
  const taintedCoordKeys = new Set<string>();
  const taintedQueue: Array<{ tabIndex: number; col: number; row: number }> = [];
  const enqueueTaintedCoord = (tabIndex: number, col: number, row: number): void => {
    const key = `${tabIndex}:${col}:${row}`;
    if (taintedCoordKeys.has(key)) return;
    taintedCoordKeys.add(key);
    taintedQueue.push({ tabIndex, col, row });
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
    const formatMarks: CellMark[] = [];
    const styleMarks: CellMark[] = [];
    const filled = new Set<number>();
    let cellCount = 0;
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
        const isDate = cellType === "d" || (styleIdx >= 0 && styles.xfIsDate[styleIdx] === true);
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
              cellTaintsDownstreamFormulas =
                (isDate && typeof normalizedCache === "string") || cellType === "e";
              unsupported.add("Unsupported Excel formulas (showing cached values)");
            } else {
              // No cached value is present; mark the cell unavailable instead of letting
              // live evaluation silently mask an unsupported function (e.g. inside IFERROR).
              value = "#UNSUPPORTED";
              cellTaintsDownstreamFormulas = true;
              unsupported.add("Unsupported Excel formulas (some cells have no cached value)");
            }
          } else {
            if (normalizedCache !== undefined) {
              value = normalizedCache;
              cellTaintsDownstreamFormulas =
                (isDate && typeof normalizedCache === "string") || cellType === "e";
              if (isSharedOrArray) {
                unsupported.add("Shared/array formulas (showing cached values)");
              } else if (formulaText.length > 0) {
                unsupported.add("Long formulas (showing cached values)");
              }
            } else if (isSharedOrArray || formulaText.length > 0) {
              value = "#UNSUPPORTED";
              cellTaintsDownstreamFormulas = true;
              if (isSharedOrArray) {
                unsupported.add("Shared/array formulas (some cells have no cached value)");
              } else {
                unsupported.add("Long formulas (some cells have no cached value)");
              }
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
            cellTaintsDownstreamFormulas =
              (isDate && typeof value === "string") || cellType === "e";
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
          if (cellType !== "e" && isDate && !date1904 && isDatedFlowDate(value)) {
            dateCellKeys.add(`${currentTabIndex}:${parsedAddr.col}:${parsedAddr.row}`);
          }
          enqueueTaintedCoord(currentTabIndex, parsedAddr.col, parsedAddr.row);
        }

        filled.add(parsedAddr.row * SHEET_LIMITS.columns + parsedAddr.col);
        if (styleIdx >= 0) {
          const fmt = isDate ? undefined : styles.xfFormat[styleIdx];
          if (fmt) {
            formatMarks.push({ col: parsedAddr.col, row: parsedAddr.row, key: JSON.stringify(fmt) });
          }
          const st = styles.xfStyle[styleIdx];
          if (st) {
            styleMarks.push({ col: parsedAddr.col, row: parsedAddr.row, key: JSON.stringify(st) });
          }
        }
      }
    }

    if (tabTruncated) {
      truncatedSheets += 1;
    }

    // A number format, bold and alignment show nothing on an empty cell, so a
    // range may run over one.
    const keep = <Mark>(
      marks: ReadonlyArray<CellMark>,
      into: Record<string, Mark>,
      mayCover?: (col: number, row: number) => boolean,
    ): boolean => {
      let kept = 0;
      for (const entry of mergeCellMarks(marks, mayCover)) {
        const bytes = Buffer.byteLength(JSON.stringify(entry.range)) + Buffer.byteLength(entry.key) + 4;
        if (kept >= SHEET_LIMITS.rangeEntries || approxJsonBytes + bytes >= MAX_APPROX_JSON_BYTES) {
          return false;
        }
        into[entry.range] = JSON.parse(entry.key) as Mark;
        kept += 1;
        approxJsonBytes += bytes;
      }
      return true;
    };
    const isEmpty = (col: number, row: number): boolean =>
      !filled.has(row * SHEET_LIMITS.columns + col);
    const everyFormat = keep(formatMarks, formats, isEmpty);
    const everyStyle = keep(styleMarks, cellStyles, isEmpty);
    if (!everyFormat) unsupported.add(FORMATS_DROPPED_NOTE);
    if (!everyStyle) unsupported.add(STYLES_DROPPED_NOTE);

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
  const UNSUPPORTED_MARKER = "#UNSUPPORTED";
  const UNSUPPORTED_MARKER_BYTES = Buffer.byteLength(JSON.stringify(UNSUPPORTED_MARKER));
  const CACHE_BUDGET_EXCEEDED_NOTE =
    "Cached formula results exceeded preview size limit (some cells unavailable)";

  const replaceFormulaCellBudgeted = (
    entry: (typeof liveFormulaEntries)[number],
    cachedNote: string,
    missingNote: string,
  ): boolean => {
    const tabCells = tabs[entry.tabIndex]!.cells;
    const currentVal = tabCells[entry.ref];
    const oldBytes = currentVal === undefined ? 0 : Buffer.byteLength(JSON.stringify(currentVal));
    if (entry.cachedValue !== undefined) {
      const newBytes = Buffer.byteLength(JSON.stringify(entry.cachedValue));
      const delta = newBytes - oldBytes;
      if (approxJsonBytes + delta <= MAX_APPROX_JSON_BYTES) {
        tabCells[entry.ref] = entry.cachedValue;
        approxJsonBytes += delta;
        unsupported.add(cachedNote);
        return true;
      }
      tabCells[entry.ref] = UNSUPPORTED_MARKER;
      approxJsonBytes += UNSUPPORTED_MARKER_BYTES - oldBytes;
      unsupported.add(CACHE_BUDGET_EXCEEDED_NOTE);
      return false;
    }
    tabCells[entry.ref] = UNSUPPORTED_MARKER;
    approxJsonBytes += UNSUPPORTED_MARKER_BYTES - oldBytes;
    unsupported.add(missingNote);
    return false;
  };

  if (truncatedSheets > 0 && liveFormulaEntries.length > 0) {
    for (const entry of liveFormulaEntries) {
      replaceFormulaCellBudgeted(
        entry,
        "Formulas on truncated workbook (showing cached values)",
        "Formulas on truncated workbook (some cells have no cached value)",
      );
    }
  } else if (liveFormulaEntries.length > 0) {
    // Build a reverse dependency index once and propagate tainted inputs via BFS with a work budget
    // so long dependency chains resolve in O(N) instead of cubic rescans.
    const tabIndexByName = new Map(tabs.map((tab, idx) => [tab.name.toLowerCase(), idx]));
    const cellDependents = new Map<string, Array<{ idx: number; dates: boolean }>>();
    const rangeDependentsByTab = new Map<
      number,
      Array<{
        idx: number;
        minCol: number;
        maxCol: number;
        minRow: number;
        maxRow: number;
        dates: boolean;
      }>
    >();
    const downgraded = new Uint8Array(liveFormulaEntries.length);

    const downgradeEntry = (
      idx: number,
      cachedNote: string,
      missingNote: string,
      forceTaint = false,
    ): void => {
      if (downgraded[idx]) return;
      downgraded[idx] = 1;
      const entry = liveFormulaEntries[idx]!;
      const placedCache = replaceFormulaCellBudgeted(entry, cachedNote, missingNote);
      // Propagate any cell whose value became a date string, native error string, or #UNSUPPORTED
      // marker so downstream totals (e.g. SUM over an uncached intermediate) keep their cached values.
      if (
        forceTaint ||
        !placedCache ||
        entry.isDate ||
        entry.cachedValue === undefined ||
        typeof entry.cachedValue === "string"
      ) {
        enqueueTaintedCoord(entry.tabIndex, entry.col, entry.row);
      }
    };

    const DATE_OR_UNAVAILABLE_CACHED =
      "Formulas referencing date, error, or unavailable cells (showing cached values)";
    const DATE_OR_UNAVAILABLE_MISSING =
      "Formulas referencing date, error, or unavailable cells (some cells have no cached value)";

    for (let idx = 0; idx < liveFormulaEntries.length; idx += 1) {
      const entry = liveFormulaEntries[idx]!;
      if (entry.isDate) {
        downgradeEntry(idx, DATE_OR_UNAVAILABLE_CACHED, DATE_OR_UNAVAILABLE_MISSING);
        continue;
      }
      const refs = extractFormulaRefs(entry.formula, entry.tabIndex, tabIndexByName);
      for (const ref of refs) {
        if (ref.minCol === ref.maxCol && ref.minRow === ref.maxRow) {
          const key = `${ref.tabIndex}:${ref.minCol}:${ref.minRow}`;
          let list = cellDependents.get(key);
          if (!list) {
            list = [];
            cellDependents.set(key, list);
          }
          list.push({ idx, dates: ref.dates });
        } else {
          let ranges = rangeDependentsByTab.get(ref.tabIndex);
          if (!ranges) {
            ranges = [];
            rangeDependentsByTab.set(ref.tabIndex, ranges);
          }
          ranges.push({
            idx,
            minCol: ref.minCol,
            maxCol: ref.maxCol,
            minRow: ref.minRow,
            maxRow: ref.maxRow,
            dates: ref.dates,
          });
        }
      }
    }

    let taintHead = 0;
    let workSteps = 0;
    let budgetExceeded = false;
    const drainTaintQueue = (cachedNote: string, missingNote: string): void => {
      for (; taintHead < taintedQueue.length && !budgetExceeded; taintHead += 1) {
        const coord = taintedQueue[taintHead]!;
        const coordKey = `${coord.tabIndex}:${coord.col}:${coord.row}`;
        const isDateCell = dateCellKeys.has(coordKey);
        const directDeps = cellDependents.get(coordKey);
        if (directDeps) {
          for (const dep of directDeps) {
            workSteps += 1;
            if (workSteps > MAX_TAINT_PROPAGATION_OPS) {
              budgetExceeded = true;
              break;
            }
            if (dep.dates && isDateCell) continue;
            downgradeEntry(dep.idx, cachedNote, missingNote);
          }
        }
        if (budgetExceeded) break;
        const rangeDeps = rangeDependentsByTab.get(coord.tabIndex);
        if (rangeDeps && rangeDeps.length > 0) {
          for (let i = rangeDeps.length - 1; i >= 0; i -= 1) {
            const range = rangeDeps[i]!;
            if (downgraded[range.idx]) {
              rangeDeps[i] = rangeDeps[rangeDeps.length - 1]!;
              rangeDeps.pop();
              continue;
            }
            workSteps += 1;
            if (workSteps > MAX_TAINT_PROPAGATION_OPS) {
              budgetExceeded = true;
              break;
            }
            if (
              coord.col >= range.minCol &&
              coord.col <= range.maxCol &&
              coord.row >= range.minRow &&
              coord.row <= range.maxRow &&
              !(range.dates && isDateCell)
            ) {
              downgradeEntry(range.idx, cachedNote, missingNote);
              rangeDeps[i] = rangeDeps[rangeDeps.length - 1]!;
              rangeDeps.pop();
            }
          }
        }
      }
    };

    drainTaintQueue(DATE_OR_UNAVAILABLE_CACHED, DATE_OR_UNAVAILABLE_MISSING);

    if (budgetExceeded) {
      for (let idx = 0; idx < liveFormulaEntries.length; idx += 1) {
        downgradeEntry(
          idx,
          "Complex formula dependencies (showing cached values)",
          "Complex formula dependencies (some cells have no cached value)",
        );
      }
    } else if (liveFormulaEntries.some((_, idx) => !downgraded[idx])) {
      const previewEval = evaluateSheet({
        v: SHEET_ARTIFACT_VERSION,
        kind: SHEET_ARTIFACT_KIND,
        title: title.slice(0, SHEET_LIMITS.titleChars),
        tabs,
      });
      if (previewEval.limitReached) {
        for (let idx = 0; idx < liveFormulaEntries.length; idx += 1) {
          downgradeEntry(
            idx,
            "Formula evaluation exceeded preview step limit (showing cached values)",
            "Formula evaluation exceeded preview step limit (some cells have no cached value)",
          );
        }
      } else {
        const limitHitIndices: number[] = [];
        for (let idx = 0; idx < liveFormulaEntries.length; idx += 1) {
          if (downgraded[idx]) continue;
          const entry = liveFormulaEntries[idx]!;
          const evaluatedVal = previewEval.valueAt(entry.tabIndex, {
            col: entry.col,
            row: entry.row,
          });
          if (isSheetError(evaluatedVal) && evaluatedVal.error === "#LIMIT!") {
            limitHitIndices.push(idx);
          }
        }
        if (limitHitIndices.length > 0) {
          const PER_CELL_LIMIT_CACHED =
            "Formula evaluation exceeded preview limit (showing cached values)";
          const PER_CELL_LIMIT_MISSING =
            "Formula evaluation exceeded preview limit (some cells have no cached value)";
          for (const idx of limitHitIndices) {
            downgradeEntry(idx, PER_CELL_LIMIT_CACHED, PER_CELL_LIMIT_MISSING, true);
          }
          drainTaintQueue(PER_CELL_LIMIT_CACHED, PER_CELL_LIMIT_MISSING);
          if (budgetExceeded) {
            for (let idx = 0; idx < liveFormulaEntries.length; idx += 1) {
              downgradeEntry(
                idx,
                "Complex formula dependencies (showing cached values)",
                "Complex formula dependencies (some cells have no cached value)",
              );
            }
          }
        }
      }
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
    unsupported.add(STYLING_DROPPED_NOTE);
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
