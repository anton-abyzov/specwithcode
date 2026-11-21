/**
 * Read-only Excel (.xlsx) OOXML preview parser.
 * Converts an `.xlsx` workbook into SpecWithCode's canonical `SheetDocument` JSON
 * so `SheetView` renders multi-sheet workbooks with tabs, formatted values,
 * formulas, column widths, and honest disclosure of unsupported workbook features.
 */
import type { DesignPreviewWorkbookResult } from "@specweave-studio/contracts";
import {
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  type SheetCellStyle,
  type SheetDocument,
  type SheetNumberFormat,
  type SheetTab,
} from "@specweave-studio/shared/officeSheet";

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

const CELL_ADDRESS_RE = /^([A-Z]{1,3})([1-9]\d{0,5})$/;
const MAX_PREVIEW_CELLS_PER_TAB = Math.min(SHEET_LIMITS.cells, 12_000);
const MAX_PREVIEW_TABS = SHEET_LIMITS.tabs;

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
  // Excel built-in date/time formats: 14-22, 45-47
  if ((numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47)) {
    return { isDate: true };
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
  if (/[ymdhs]/i.test(stripped) && !/[#0]/.test(stripped.replace(/0+/g, ""))) {
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

/** Converts an Excel serial date number (1900 date system) into YYYY-MM-DD without `new Date()`. */
function excelSerialToIsoDate(serial: number): string {
  // Excel's 1900 leap-year bug treats serial 60 as 1900-02-29; Unix epoch 1970-01-01 is serial 25569.
  const unixDays = Math.floor(serial) - 25569;
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
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
  let truncatedSheets = 0;

  for (const sheetNode of sheetNodes) {
    if (tabs.length >= MAX_PREVIEW_TABS) {
      truncatedSheets += 1;
      continue;
    }
    const rawName = (sheetNode.attrs.name ?? `Sheet ${tabs.length + 1}`).trim() || `Sheet ${tabs.length + 1}`;
    const name = rawName.slice(0, SHEET_LIMITS.tabNameChars);
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
        Number.isInteger(min) &&
        Number.isInteger(max) &&
        Number.isFinite(widthChars) &&
        widthChars > 0
      ) {
        const px = Math.max(48, Math.min(480, Math.round(widthChars * 7.5 + 12)));
        const cappedMax = Math.min(max, min + 40);
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

    const sheetData = findChild(sheetXml, "sheetData");
    for (const row of findChildren(sheetData, "row")) {
      if (tabTruncated) break;
      for (const cell of findChildren(row, "c")) {
        const ref = cell.attrs.r?.toUpperCase();
        if (!ref || !CELL_ADDRESS_RE.test(ref)) continue;

        const cellType = cell.attrs.t ?? "n";
        const styleIdx = cell.attrs.s !== undefined ? Number(cell.attrs.s) : -1;
        const isDate = styleIdx >= 0 && styles.xfIsDate[styleIdx] === true;
        const fEl = findChild(cell, "f");
        const vEl = findChild(cell, "v");
        const isEl = findChild(cell, "is");

        let value: string | number | boolean | undefined;

        if (fEl) {
          const formulaText = collectText(fEl).trim();
          const formulaType = fEl.attrs.t;
          if (formulaText.length > 0 && formulaType !== "array" && formulaType !== "shared") {
            value = formulaText.startsWith("=") ? formulaText : `=${formulaText}`;
          } else {
            if (formulaType === "array" || formulaType === "shared") {
              unsupported.add("Shared/array formulas (showing cached values)");
            }
            if (vEl) {
              const rawV = collectText(vEl);
              const num = Number(rawV);
              value =
                cellType === "str" || cellType === "e" || Number.isNaN(num)
                  ? rawV
                  : isDate
                    ? excelSerialToIsoDate(num)
                    : num;
            }
          }
        } else if (cellType === "s") {
          const idx = Number(vEl ? collectText(vEl) : "");
          if (Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length) {
            value = sharedStrings[idx]!;
          }
        } else if (cellType === "inlineStr") {
          value = isEl ? collectText(isEl) : "";
        } else if (cellType === "b") {
          value = vEl ? collectText(vEl).trim() === "1" : false;
        } else if (cellType === "str" || cellType === "e") {
          value = vEl ? collectText(vEl) : "";
        } else if (vEl) {
          const rawV = collectText(vEl).trim();
          if (rawV.length > 0) {
            const num = Number(rawV);
            value = Number.isNaN(num) ? rawV : isDate ? excelSerialToIsoDate(num) : num;
          }
        }

        if (value === undefined) continue;
        if (typeof value === "string" && value.length > SHEET_LIMITS.textChars) {
          value = `${value.slice(0, SHEET_LIMITS.textChars - 1)}…`;
        }

        if (cellCount >= MAX_PREVIEW_CELLS_PER_TAB) {
          tabTruncated = true;
          truncatedSheets += 1;
          break;
        }
        cells[ref] = value;
        cellCount += 1;

        if (styleIdx >= 0 && !isDate && formatCount < SHEET_LIMITS.rangeEntries) {
          const fmt = styles.xfFormat[styleIdx];
          if (fmt) {
            formats[ref] = fmt;
            formatCount += 1;
          }
        }
        if (styleIdx >= 0 && styleCount < SHEET_LIMITS.rangeEntries) {
          const st = styles.xfStyle[styleIdx];
          if (st) {
            cellStyles[ref] = st;
            styleCount += 1;
          }
        }
      }
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

  const doc: SheetDocument = {
    v: SHEET_ARTIFACT_VERSION,
    kind: SHEET_ARTIFACT_KIND,
    title: title.slice(0, SHEET_LIMITS.titleChars),
    tabs,
  };

  return {
    sheetJson: JSON.stringify(doc),
    sheetCount: sheetNodes.length,
    truncatedSheets,
    unsupportedFeatures: [...unsupported],
  };
}
