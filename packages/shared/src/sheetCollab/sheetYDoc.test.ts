import { describe, expect, it } from "vite-plus/test";

import {
  type SheetDocument,
  addTab,
  deleteTab,
  renameTab,
  serializeSheetDocument,
  setCells,
  setFormat,
  validateSheetDocument,
} from "../officeSheet/index.ts";
import {
  type SheetYDoc,
  applySheetUpdate,
  cloneSheetYDoc,
  createSheetUndo,
  createSheetYDoc,
  encodeSheetMissing,
  encodeSheetState,
  encodeSheetStateVector,
  onSheetUpdate,
  readSheetYDoc,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  sheetYDocFrom,
  summarizeSheetChange,
  writeSheetChange,
} from "./sheetYDoc.ts";

const validated = (input: unknown): SheetDocument => sheet(input);

function sheet(input: unknown): SheetDocument {
  const checked = validateSheetDocument(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.document;
}

const BUDGET = sheet({
  title: "Q3 budget",
  designSystem: "brand",
  tabs: [
    {
      name: "Plan",
      // Out of reading order on purpose: the file's own order is kept.
      cells: { B2: 1200, A1: "Item", A2: "Rent", B1: "Cost", B3: "=SUM(B2:B2)", A3: true },
      formats: {
        "B2:B9": { kind: "currency", currency: "USD", decimals: 2 },
        B3: { kind: "number", decimals: 0 },
        "A1:B1": { kind: "text" },
      },
      styles: { "A1:B9": { bold: true }, B3: { bold: false, topBorder: true }, A1: { fill: true } },
      chips: ["A2:A9"],
      widths: { B: 140, A: 220 },
      columnOrder: ["B", "A"],
      hiddenColumns: ["C"],
      rowGroups: [{ id: "g1", label: "Costs", startRow: 2, endRow: 3 }],
      charts: [
        { id: "second", type: "bar", title: "Costs by item", labels: "A2:A3", values: "B2:B3" },
        { id: "first", type: "donut", title: "Share", labels: "A2:A3", values: "B2:B3", at: "D2" },
      ],
      gridlines: false,
    },
    { name: "Notes", cells: { A1: "'=kept as text" } },
  ],
});

/** Two documents that have exchanged everything. */
function sync(left: SheetYDoc, right: SheetYDoc): void {
  const toRight = encodeSheetMissing(left, encodeSheetStateVector(right));
  const toLeft = encodeSheetMissing(right, encodeSheetStateVector(left));
  if (toRight) applySheetUpdate(right, toRight, "remote");
  if (toLeft) applySheetUpdate(left, toLeft, "remote");
}

function pair(document: SheetDocument) {
  const server = sheetYDocFrom(document);
  const left = createSheetYDoc();
  const right = createSheetYDoc();
  applySheetUpdate(left, encodeSheetState(server), "remote");
  applySheetUpdate(right, encodeSheetState(server), "remote");
  return { left, right };
}

function edit(doc: SheetYDoc, change: (current: SheetDocument) => SheetDocument): void {
  const before = readSheetYDoc(doc);
  writeSheetChange(doc, before, change(before.document), "local");
}

describe("sheet as a Yjs document", () => {
  it("round-trips a sheet byte for byte, also through an update into a new document", () => {
    const hint = { document: BUDGET, tabIds: readSheetYDoc(sheetYDocFrom(BUDGET)).tabIds };
    const doc = sheetYDocFrom(BUDGET);
    const direct = readSheetYDoc(doc, { ...hint, tabIds: readSheetYDoc(doc).tabIds });
    expect(serializeSheetDocument(direct.document)).toBe(serializeSheetDocument(BUDGET));

    const copy = createSheetYDoc();
    const encoded = sheetUpdateFromBase64(sheetUpdateToBase64(encodeSheetState(doc)));
    expect(encoded).not.toBeNull();
    expect(applySheetUpdate(copy, encoded!, "remote")).toBe(true);
    const read = readSheetYDoc(copy, { document: BUDGET, tabIds: readSheetYDoc(copy).tabIds });
    expect(serializeSheetDocument(read.document)).toBe(serializeSheetDocument(BUDGET));
    // What comes out is still a valid sheet, unchanged by validation.
    expect(serializeSheetDocument(sheet(read.document))).toBe(serializeSheetDocument(BUDGET));
  });

  it("keeps formats and styles in file order without a hint, where later entries win", () => {
    const read = readSheetYDoc(cloneSheetYDoc(sheetYDocFrom(BUDGET))).document;
    expect(Object.keys(read.tabs[0]!.formats!)).toEqual(["B2:B9", "B3", "A1:B1"]);
    expect(Object.keys(read.tabs[0]!.styles!)).toEqual(["A1:B9", "B3", "A1"]);
    expect(read.tabs[0]!.charts!.map((chart) => chart.id)).toEqual(["second", "first"]);
  });

  it("merges edits two writers made to different cells", () => {
    const { left, right } = pair(BUDGET);
    edit(left, (doc) => setCells(doc, 0, [[{ col: 0, row: 4 }, "Travel"]]));
    edit(right, (doc) => setCells(doc, 0, [[{ col: 1, row: 4 }, 300]]));
    sync(left, right);
    const merged = readSheetYDoc(left).document;
    expect(merged.tabs[0]!.cells.A5).toBe("Travel");
    expect(merged.tabs[0]!.cells.B5).toBe(300);
    expect(readSheetYDoc(right).document).toEqual(merged);
    expect(validateSheetDocument(merged).ok).toBe(true);
  });

  it("resolves two edits of one cell to the same value for both writers", () => {
    const { left, right } = pair(BUDGET);
    edit(left, (doc) => setCells(doc, 0, [[{ col: 1, row: 1 }, 1500]]));
    edit(right, (doc) => setCells(doc, 0, [[{ col: 1, row: 1 }, 900]]));
    sync(left, right);
    const value = readSheetYDoc(left).document.tabs[0]!.cells.B2;
    expect([1500, 900]).toContain(value);
    expect(readSheetYDoc(right).document.tabs[0]!.cells.B2).toBe(value);
  });

  it("keeps a format one writer adds while another clears a cell", () => {
    const { left, right } = pair(BUDGET);
    edit(left, (doc) =>
      setFormat(
        doc,
        0,
        { start: { col: 1, row: 4 }, end: { col: 1, row: 4 } },
        { kind: "percent" },
      ),
    );
    const painted = readSheetYDoc(left).document.tabs[0]!.formats!;
    edit(right, (doc) => setCells(doc, 0, [[{ col: 0, row: 1 }, ""]]));
    sync(left, right);
    const merged = readSheetYDoc(right).document.tabs[0]!;
    expect(merged.formats!.B5).toEqual({ kind: "percent" });
    expect(merged.cells.A2).toBeUndefined();
    // The other writer reads the formats in the order the first one wrote them.
    expect(Object.entries(merged.formats!)).toEqual(Object.entries(painted));
  });

  it("adds, renames and deletes tabs, and keeps a tab each of two writers added", () => {
    const { left, right } = pair(BUDGET);
    edit(left, (doc) => addTab(doc, { after: 0 }).document);
    edit(right, (doc) => renameTab(doc, 1, "Remarks"));
    sync(left, right);
    const merged = readSheetYDoc(left).document;
    expect(merged.tabs.map((tab) => tab.name)).toEqual(["Plan", "Sheet3", "Remarks"]);
    expect(merged.tabs[2]!.cells.A1).toBe("'=kept as text");

    edit(left, (doc) => addTab(doc).document);
    edit(right, (doc) => addTab(doc).document);
    sync(left, right);
    const both = readSheetYDoc(right).document;
    expect(both.tabs).toHaveLength(5);
    expect(validateSheetDocument(both).ok).toBe(true);
    expect(readSheetYDoc(left).document).toEqual(both);

    edit(left, (doc) => deleteTab(doc, 1));
    sync(left, right);
    expect(readSheetYDoc(right).document.tabs.map((tab) => tab.name)).not.toContain("Sheet3");
  });

  it("lays a change made to the file over edits the document already holds", () => {
    const doc = sheetYDocFrom(BUDGET);
    const saved = readSheetYDoc(doc);
    // An edit in the session that has not reached the file yet.
    edit(doc, (current) => setCells(current, 0, [[{ col: 0, row: 5 }, "Unsaved"]]));
    // Meanwhile the file changed on disk: one cell and one more tab.
    const onDisk = sheet({
      ...BUDGET,
      tabs: [
        { ...BUDGET.tabs[0]!, cells: { ...BUDGET.tabs[0]!.cells, B2: 1350 } },
        BUDGET.tabs[1]!,
        { name: "Extra", cells: { A1: "From disk" } },
      ],
    });
    writeSheetChange(doc, saved, onDisk, "file");
    const merged = readSheetYDoc(doc).document;
    expect(merged.tabs[0]!.cells.B2).toBe(1350);
    expect(merged.tabs[0]!.cells.A6).toBe("Unsaved");
    expect(merged.tabs.map((tab) => tab.name)).toEqual(["Plan", "Notes", "Extra"]);
  });

  it("leaves a format someone else changed when an edit built on the earlier sheet ends", () => {
    const doc = sheetYDocFrom(BUDGET);
    const atStart = readSheetYDoc(doc);
    // Someone else changes a format while this writer's edit (a column being dragged) is open.
    const theirs = setFormat(
      atStart.document,
      0,
      { start: { col: 1, row: 2 }, end: { col: 1, row: 2 } },
      { kind: "percent", decimals: 1 },
    );
    writeSheetChange(doc, atStart, theirs, "theirs");
    // The edit ends: the sheet as it was at the start, with one width changed.
    const mine = {
      ...atStart.document,
      tabs: [
        { ...atStart.document.tabs[0]!, widths: { A: 200 } },
        ...atStart.document.tabs.slice(1),
      ],
    };
    writeSheetChange(doc, atStart, mine, "mine");
    const merged = readSheetYDoc(doc).document.tabs[0]!;
    expect(merged.widths).toEqual({ A: 200 });
    expect(merged.formats?.B3).toEqual({ kind: "percent", decimals: 1 });
  });

  it("leaves a chart someone else removed when an edit built on the earlier sheet ends", () => {
    const chart = { id: "chart-1", type: "bar", title: "Costs", labels: "A2:A3", values: "B2:B3" };
    const start = sheet({
      title: "Charts",
      tabs: [{ name: "Plan", cells: { A2: "Rent", B2: 1 }, charts: [chart] }],
    });
    const doc = sheetYDocFrom(start);
    const atStart = readSheetYDoc(doc);
    const theirs = { ...atStart.document, tabs: [{ ...atStart.document.tabs[0]!, charts: [] }] };
    writeSheetChange(doc, atStart, validated(theirs), "theirs");
    expect(readSheetYDoc(doc).document.tabs[0]!.charts).toBeUndefined();
    // This writer's edit still names the chart, unchanged, and changes one width.
    const mine = {
      ...atStart.document,
      tabs: [{ ...atStart.document.tabs[0]!, widths: { A: 200 } }],
    };
    writeSheetChange(doc, atStart, mine, "mine");
    const merged = readSheetYDoc(doc).document.tabs[0]!;
    expect(merged.widths).toEqual({ A: 200 });
    expect(merged.charts).toBeUndefined();
  });

  it("writes nothing when the sheet did not change", () => {
    const doc = sheetYDocFrom(BUDGET);
    let updates = 0;
    const stop = onSheetUpdate(doc, () => {
      updates += 1;
    });
    writeSheetChange(doc, readSheetYDoc(doc), readSheetYDoc(doc).document, "local");
    stop();
    expect(updates).toBe(0);
  });

  it("undoes only the writer's own edit", () => {
    const { left, right } = pair(BUDGET);
    const undo = createSheetUndo(left, "local");
    edit(left, (doc) => setCells(doc, 0, [[{ col: 0, row: 4 }, "Mine"]]));
    edit(right, (doc) => setCells(doc, 0, [[{ col: 1, row: 4 }, "Theirs"]]));
    sync(left, right);
    expect(undo.canUndo()).toBe(true);
    expect(undo.undo()).toBe(true);
    sync(left, right);
    const after = readSheetYDoc(right).document.tabs[0]!.cells;
    expect(after.A5).toBeUndefined();
    expect(after.B5).toBe("Theirs");
    expect(undo.redo()).toBe(true);
    expect(readSheetYDoc(left).document.tabs[0]!.cells.A5).toBe("Mine");
    undo.destroy();
  });

  it("refuses bytes that are not an update and says when nothing is missing", () => {
    const doc = sheetYDocFrom(BUDGET);
    expect(applySheetUpdate(doc, new Uint8Array([255, 255, 255, 1, 2, 3]), "remote")).toBe(false);
    expect(sheetUpdateFromBase64("not base64 !!")).toBeNull();
    expect(encodeSheetMissing(doc, encodeSheetStateVector(doc))).toBeNull();
    expect(readSheetYDoc(doc).document.title).toBe("Q3 budget");
  });

  it("summarizes a change for the activity list", () => {
    const next = setCells(BUDGET, 0, [
      [{ col: 1, row: 1 }, 1300],
      [{ col: 0, row: 6 }, "New"],
    ]);
    expect(summarizeSheetChange(BUDGET, next)).toEqual({
      cells: 2,
      first: "Plan!B2",
      layout: false,
    });
    expect(summarizeSheetChange(BUDGET, renameTab(BUDGET, 1, "Remarks")).layout).toBe(true);
  });
});
