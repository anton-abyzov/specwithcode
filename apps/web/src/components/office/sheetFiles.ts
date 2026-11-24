/**
 * Files made from a Sheet in the browser: an Excel workbook (.xlsx, zipped
 * with jszip, loaded only when asked for) and one tab as .csv.
 */
import {
  type SheetDocument,
  type SheetEvaluation,
  XLSX_MIME,
  buildXlsxParts,
  sheetTabToCsv,
  xlsxPartOrder,
} from "@specweave-studio/shared/officeSheet";

/** A file name from a title: lowercase words joined by dashes, with the extension. */
export function sheetFileName(title: string, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || "sheet"}.${extension}`;
}

export async function sheetXlsxBlob(document: SheetDocument, evaluation: SheetEvaluation): Promise<Blob> {
  const parts = buildXlsxParts(document, evaluation);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  // Fixed times keep the same Sheet byte-for-byte the same file.
  const date = new Date(Date.UTC(1980, 0, 1));
  for (const name of xlsxPartOrder(parts)) zip.file(name, parts[name]!, { date });
  return zip.generateAsync({ type: "blob", mimeType: XLSX_MIME, compression: "DEFLATE" });
}

export function sheetCsvBlob(document: SheetDocument, tabIndex: number, evaluation: SheetEvaluation): Blob {
  const tab = document.tabs[tabIndex] ?? document.tabs[0]!;
  return new Blob([sheetTabToCsv(tab, tabIndex, evaluation)], { type: "text/csv;charset=utf-8" });
}

/** Saves a blob through the browser's download. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL === "undefined" || typeof window === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
