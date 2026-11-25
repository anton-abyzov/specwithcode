// @effect-diagnostics nodeBuiltinImport:off -- The fixture folder is laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type SheetDocument,
  buildXlsxParts,
  evaluateSheet,
  serializeSheetDocument,
  setCells,
  sheetContentRevision,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import {
  applySheetUpdate,
  createSheetYDoc,
  encodeSheetState,
  onSheetUpdate,
  readSheetYDoc,
  writeSheetChange,
} from "@specweave-studio/shared/sheetCollab";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  SHEET_SIDECAR_DIR,
  appendSheetSidecar,
  compactSheetSidecar,
  loadSheet,
  parseSheetSidecar,
  readSheetFileText,
  readSheetSidecar,
  removeSheetSidecar,
  sheetFileText,
  sheetSidecarHeader,
  sheetSidecarLine,
  sheetSidecarPath,
  writeSheetSidecar,
} from "./sheetYDoc.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sheet-ydoc-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function sheet(input: unknown): SheetDocument {
  const checked = validateSheetDocument(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.document;
}

const FORECAST = sheet({
  title: "Forecast",
  tabs: [
    {
      name: "Plan",
      cells: {
        B2: 1200,
        A1: "Month",
        A2: "Jan",
        B1: "Revenue",
        A3: "Feb",
        B3: 1350,
        B4: "=SUM(B2:B3)",
        A4: "Total",
      },
      formats: {
        "B2:B4": { kind: "currency", currency: "EUR" },
        B4: { kind: "number", decimals: 1 },
      },
      styles: {
        "A1:B1": { bold: true, fill: true },
        "A4:B4": { topBorder: true },
        B4: { bold: true },
      },
      widths: { B: 120, A: 90 },
      charts: [
        { id: "trend", type: "line", title: "Revenue grows", labels: "A2:A3", values: "B2:B3" },
      ],
    },
    { name: "Notes", cells: { A1: "Assumes no churn" }, gridlines: false },
  ],
});
const TEXT = serializeSheetDocument(FORECAST);

const xlsx = (document: SheetDocument) => buildXlsxParts(document, evaluateSheet(document));

describe("a sheet file and its merge document", () => {
  it("reads a file, with or without a byte order mark, to the same revision", () => {
    const plain = readSheetFileText(TEXT);
    const marked = readSheetFileText(`﻿${TEXT}`);
    expect(plain.ok && marked.ok).toBe(true);
    if (!plain.ok || !marked.ok) return;
    expect(plain.file.revision).toBe(sheetContentRevision(TEXT));
    expect(marked.file.revision).toBe(plain.file.revision);
    expect(marked.file.byteOrderMark).toBe(true);
    expect(readSheetFileText("{").ok).toBe(false);
  });

  it("gives the file back byte for byte when nothing merged", () => {
    const loaded = loadSheet(FORECAST, null, "e1");
    expect(loaded.restored).toBe(false);
    const text = sheetFileText(readSheetYDoc(loaded.doc, loaded.saved));
    expect(text.ok && text.text).toBe(TEXT);
  });

  it("keeps the workbook Excel opens the same after a session's edit is undone by hand", () => {
    const loaded = loadSheet(FORECAST, null, "e1");
    const edit = (change: (document: SheetDocument) => SheetDocument) => {
      const before = readSheetYDoc(loaded.doc, loaded.saved);
      writeSheetChange(loaded.doc, before, change(before.document), "window");
    };
    edit((document) => setCells(document, 0, [[{ col: 1, row: 1 }, 1500]]));
    const edited = sheetFileText(readSheetYDoc(loaded.doc, loaded.saved));
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // Only the edited cell differs, in the file and in the workbook built from it.
    expect(edited.text).toBe(TEXT.replace('"B2": 1200', '"B2": 1500'));
    expect(xlsx(edited.document)).toEqual(
      xlsx(setCells(FORECAST, 0, [[{ col: 1, row: 1 }, 1500]])),
    );
    edit((document) => setCells(document, 0, [[{ col: 1, row: 1 }, 1200]]));
    const back = sheetFileText(readSheetYDoc(loaded.doc, loaded.saved));
    expect(back.ok && back.text).toBe(TEXT);
    expect(back.ok && xlsx(back.document)).toEqual(xlsx(FORECAST));
  });

  it("puts new cells after the ones the file had, in reading order", () => {
    const loaded = loadSheet(FORECAST, null, "e1");
    const before = readSheetYDoc(loaded.doc, loaded.saved);
    writeSheetChange(
      loaded.doc,
      before,
      setCells(before.document, 0, [
        [{ col: 2, row: 1 }, "late"],
        [{ col: 2, row: 0 }, "Note"],
      ]),
      "window",
    );
    const text = sheetFileText(readSheetYDoc(loaded.doc, loaded.saved));
    expect(text.ok && Object.keys(text.document.tabs[0]!.cells)).toEqual([
      ...Object.keys(FORECAST.tabs[0]!.cells),
      "C1",
      "C2",
    ]);
  });

  it("refuses to save a sheet the writers left invalid", () => {
    const doc = createSheetYDoc();
    expect(sheetFileText(readSheetYDoc(doc)).ok).toBe(false);
  });
});

describe("the sidecar log", () => {
  it("restores the merge state and lets the file win where it changed since", () => {
    const first = loadSheet(FORECAST, null, "e1");
    const updates: Uint8Array[] = [];
    const stop = onSheetUpdate(first.doc, (update) => updates.push(update));
    const before = readSheetYDoc(first.doc, first.saved);
    writeSheetChange(
      first.doc,
      before,
      setCells(before.document, 0, [[{ col: 0, row: 5 }, "Merged"]]),
      "window",
    );
    stop();
    const log = `${compactSheetSidecar("e1", loadSheet(FORECAST, null, "e1").doc)}`;
    expect(parseSheetSidecar(log)?.epoch).toBe("e1");

    const sidecar = `${sheetSidecarHeader("e1")}${sheetSidecarLine(encodeSheetState(first.doc))}`;
    // The file on disk moved on without the session: B2 changed, A6 never reached it.
    const onDisk = setCells(FORECAST, 0, [[{ col: 1, row: 1 }, 999]]);
    const restored = loadSheet(onDisk, sidecar, "e2");
    expect(restored.restored).toBe(true);
    expect(restored.epoch).toBe("e1");
    const text = sheetFileText(readSheetYDoc(restored.doc, restored.saved));
    expect(text.ok && text.text).toBe(serializeSheetDocument(onDisk));
    // A window that still holds the old state merges into the restored document.
    const late = createSheetYDoc();
    applySheetUpdate(late, encodeSheetState(first.doc), "remote");
    expect(applySheetUpdate(restored.doc, encodeSheetState(late), "remote")).toBe(true);
    expect(validateSheetDocument(readSheetYDoc(restored.doc).document).ok).toBe(true);
  });

  it("skips a cut-off last line and starts over from the file when the log is unreadable", () => {
    const loaded = loadSheet(FORECAST, null, "e1");
    const good = `${sheetSidecarHeader("e1")}${sheetSidecarLine(encodeSheetState(loaded.doc))}`;
    expect(parseSheetSidecar(`${good}{"u":"AAEC`)?.entries).toHaveLength(1);
    expect(parseSheetSidecar("")).toBeNull();
    expect(parseSheetSidecar("not json\n")).toBeNull();
    expect(parseSheetSidecar(`${JSON.stringify({ v: 9, epoch: "x" })}\n`)).toBeNull();
    const fresh = loadSheet(FORECAST, "garbage\n", "e7");
    expect(fresh.restored).toBe(false);
    expect(fresh.epoch).toBe("e7");
  });

  it("lives in an ignored folder beside the file and goes when the document goes", async () => {
    const folder = NodePath.join(root, "artifacts");
    NodeFS.mkdirSync(folder, { recursive: true });
    const file = NodePath.join(folder, "forecast.sheet.json");
    NodeFS.writeFileSync(file, TEXT);
    const sidecar = sheetSidecarPath(file);
    expect(sidecar).toBe(NodePath.join(folder, SHEET_SIDECAR_DIR, "forecast.sheet.json.ylog"));
    expect(await readSheetSidecar(sidecar)).toBeNull();

    expect(await writeSheetSidecar(sidecar, sheetSidecarHeader("e1"), ".tmp-1")).toBe(true);
    expect(await appendSheetSidecar(sidecar, sheetSidecarLine(new Uint8Array([0, 0])))).toBe(true);
    expect(parseSheetSidecar((await readSheetSidecar(sidecar))!)?.entries).toHaveLength(1);
    // Git skips the folder, and no listing of sheets takes its file for one.
    expect(
      NodeFS.readFileSync(NodePath.join(folder, SHEET_SIDECAR_DIR, ".gitignore"), "utf8"),
    ).toBe("*\n");
    expect(NodeFS.readdirSync(folder).filter((name) => name.endsWith(".sheet.json"))).toEqual([
      "forecast.sheet.json",
    ]);
    // The file itself is untouched by any of it.
    expect(NodeFS.readFileSync(file, "utf8")).toBe(TEXT);

    await removeSheetSidecar(sidecar);
    expect(NodeFS.existsSync(NodePath.join(folder, SHEET_SIDECAR_DIR))).toBe(false);
  });

  it("never follows a link put in place of the sidecar folder", async () => {
    const folder = NodePath.join(root, "linked");
    const elsewhere = NodePath.join(root, "elsewhere");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    NodeFS.symlinkSync(elsewhere, NodePath.join(folder, SHEET_SIDECAR_DIR), "dir");
    const sidecar = sheetSidecarPath(NodePath.join(folder, "x.sheet.json"));
    expect(await appendSheetSidecar(sidecar, sheetSidecarHeader("e1"))).toBe(false);
    expect(await writeSheetSidecar(sidecar, sheetSidecarHeader("e1"), ".tmp-2")).toBe(false);
    expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
  });
});
