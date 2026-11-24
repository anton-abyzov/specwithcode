// @effect-diagnostics nodeBuiltinImport:off -- Writes the page to a private temporary file and the PDF where the person chose.
/**
 * Export PDF for the Word editor: the document's page (HTML the app built from
 * its own model, with pictures as data URLs) is printed in a hidden window
 * that runs no script and may load nothing but that page and its data URLs,
 * then saved where the person picks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { PRINT_DOCUMENT_PDF_CHANNEL } from "../channels.ts";

const PrintDocumentInput = Schema.Struct({
  html: Schema.String.check(Schema.isMaxLength(64 * 1024 * 1024)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  pageSize: Schema.optional(Schema.Literals(["A4", "Letter"])),
});

const PrintDocumentResult = Schema.Struct({ path: Schema.NullOr(Schema.String) });

/** A file name with nothing a file system refuses. */
export function pdfFileName(name: string): string {
  const stem = name
    .replace(/\.(docx|pdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${stem.length > 0 ? stem : "Document"}.pdf`;
}

/**
 * Exports share one session, and a session keeps only its last request filter,
 * so one print runs at a time: a second can never narrow the first one's filter.
 */
let printing: Promise<unknown> = Promise.resolve();
function printToPdf(html: string, pageSize: "A4" | "Letter"): Promise<Buffer> {
  const run = printing.then(() => printOnce(html, pageSize));
  printing = run.catch(() => undefined);
  return run;
}

async function printOnce(html: string, pageSize: "A4" | "Letter"): Promise<Buffer> {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-print-"));
  const page = NodePath.join(folder, "document.html");
  const pageUrl = NodeURL.pathToFileURL(page).href;
  const window = new Electron.BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "swc-document-print",
      spellcheck: false,
    },
  });
  try {
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !(details.url === pageUrl || details.url.startsWith("data:")) });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await NodeFSP.writeFile(page, html, "utf8");
    await window.loadFile(page);
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize,
      // One inch on every side, as Word lays out a page.
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
    });
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
    window.destroy();
    await NodeFSP.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const printDocumentPdf = DesktopIpc.makeIpcMethod({
  channel: PRINT_DOCUMENT_PDF_CHANNEL,
  payload: PrintDocumentInput,
  result: PrintDocumentResult,
  handler: ({ html, name, pageSize }, event) =>
    Effect.promise(async () => {
      const pdf = await printToPdf(html, pageSize ?? "Letter");
      const contents = event === undefined ? undefined : Electron.webContents.fromId(event.sender.id);
      const parent = contents === undefined ? null : Electron.BrowserWindow.fromWebContents(contents);
      const options: Electron.SaveDialogOptions = {
        defaultPath: NodePath.join(Electron.app.getPath("downloads"), pdfFileName(name)),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      };
      const chosen =
        parent === null
          ? await Electron.dialog.showSaveDialog(options)
          : await Electron.dialog.showSaveDialog(parent, options);
      if (chosen.canceled || chosen.filePath === undefined) return { path: null };
      await NodeFSP.writeFile(chosen.filePath, pdf);
      return { path: chosen.filePath };
    }),
});
