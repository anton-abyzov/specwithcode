import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SHEET_HISTORY,
  SheetEditLimitError,
  addTab,
  applyBorders,
  applyStyle,
  cellInputText,
  clearRange,
  deleteColumns,
  deleteRows,
  deleteTab,
  formulaTabName,
  insertColumns,
  insertRows,
  offsetFormula,
  paintRangeMap,
  parseCellInput,
  recordEdit,
  redoEdit,
  renameTab,
  setCells,
  setFormat,
  shiftFormulaRefs,
  stepDecimals,
  tabNameProblem,
  toggleStyleFlag,
  undoEdit,
} from "./edit.ts";
import { collectFormulaReferences, evaluateSheet, isSheetError } from "./formula.ts";
import {
  type SheetDocument,
  parseCellRange,
  rangeLookup,
  validateSheetDocument,
} from "./model.ts";

function doc(tabs: SheetDocument["tabs"]): SheetDocument {
  return { v: 1, kind: "sheet", title: "Test", tabs };
}

const r = (text: string) => parseCellRange(text)!;

describe("parseCellInput", () => {
  it("reads numbers, percents, currency, booleans, formulas and text", () => {
    expect(parseCellInput("")).toEqual({ input: null });
    expect(parseCellInput("42")).toEqual({ input: 42 });
    expect(parseCellInput("-1,234.5")).toEqual({ input: -1234.5 });
    expect(parseCellInput("1e3")).toEqual({ input: 1000 });
    expect(parseCellInput("12%")).toEqual({ input: 0.12, format: { kind: "percent" } });
    expect(parseCellInput("12.5%")).toEqual({
      input: 0.125,
      format: { kind: "percent", decimals: 1 },
    });
    expect(parseCellInput("$1,200")).toEqual({
      input: 1200,
      format: { kind: "currency", currency: "USD", decimals: 2 },
    });
    expect(parseCellInput("-€3.5")).toEqual({
      input: -3.5,
      format: { kind: "currency", currency: "EUR", decimals: 1 },
    });
    expect(parseCellInput("true")).toEqual({ input: true });
    expect(parseCellInput("=SUM(A1:A3)")).toEqual({ input: "=SUM(A1:A3)" });
    expect(parseCellInput("'0012")).toEqual({ input: "0012" });
    expect(parseCellInput("'=not a formula")).toEqual({ input: "'=not a formula" });
    expect(parseCellInput("1.2.3")).toEqual({ input: "1.2.3" });
    expect(parseCellInput("Q1 plan")).toEqual({ input: "Q1 plan" });
  });

  it("shows inputs back as typed", () => {
    expect(cellInputText(true)).toBe("TRUE");
    expect(cellInputText(1.5)).toBe("1.5");
    expect(cellInputText("=A1")).toBe("=A1");
    expect(cellInputText(undefined)).toBe("");
  });
});

describe("cells", () => {
  it("sets, recalculates and clears", () => {
    let sheet = doc([{ name: "S", cells: { A1: 1, A2: 2 } }]);
    sheet = setCells(sheet, 0, [[{ col: 0, row: 2 }, "=SUM(A1:A2)"]]);
    expect(evaluateSheet(sheet).valueAt(0, { col: 0, row: 2 })).toBe(3);
    sheet = setCells(sheet, 0, [[{ col: 0, row: 0 }, 10]]);
    expect(evaluateSheet(sheet).valueAt(0, { col: 0, row: 2 })).toBe(12);
    sheet = clearRange(sheet, 0, r("A1:A2"));
    expect(sheet.tabs[0]!.cells).toEqual({ A3: "=SUM(A1:A2)" });
  });

  it("clears formatting with the inputs when asked", () => {
    let sheet = doc([{ name: "S", cells: { A1: 1 }, styles: { A1: { bold: true } }, formats: { A1: { kind: "percent" } } }]);
    sheet = clearRange(sheet, 0, r("A1"), { formatting: true });
    expect(sheet.tabs[0]!.styles).toBeUndefined();
    expect(sheet.tabs[0]!.formats).toBeUndefined();
  });
});

describe("reference rewriting", () => {
  it("shifts rows below an insert, keeps $ marks and spacing", () => {
    expect(shiftFormulaRefs("=A1+ $B$3 * C2", "S", "S", { axis: "row", at: 1, count: 2 })).toBe(
      "=A1+ $B$5 * C4",
    );
  });

  it("grows a range that spans the insert and moves one that starts at it", () => {
    expect(shiftFormulaRefs("=SUM(A1:A5)", "S", "S", { axis: "row", at: 2, count: 1 })).toBe(
      "=SUM(A1:A6)",
    );
    expect(shiftFormulaRefs("=SUM(A3:A5)", "S", "S", { axis: "row", at: 2, count: 1 })).toBe(
      "=SUM(A4:A6)",
    );
  });

  it("turns a deleted cell into #REF! and shrinks a range", () => {
    expect(shiftFormulaRefs("=A2*2", "S", "S", { axis: "row", at: 1, count: -1 })).toBe("=#REF!*2");
    expect(shiftFormulaRefs("=SUM(A1:A5)", "S", "S", { axis: "row", at: 1, count: -2 })).toBe(
      "=SUM(A1:A3)",
    );
    expect(shiftFormulaRefs("=SUM(B2:B3)", "S", "S", { axis: "row", at: 1, count: -2 })).toBe(
      "=SUM(#REF!)",
    );
  });

  it("leaves strings and other tabs alone, and follows cross-tab references", () => {
    expect(shiftFormulaRefs('=CONCAT("A1",A1)', "S", "S", { axis: "col", at: 0, count: 1 })).toBe(
      '=CONCAT("A1",B1)',
    );
    expect(shiftFormulaRefs("=Costs!A1+A1", "S", "Costs", { axis: "row", at: 0, count: 1 })).toBe(
      "=Costs!A2+A1",
    );
    expect(
      shiftFormulaRefs("='Q1 plan'!B2:C3", "S", "q1 PLAN", { axis: "col", at: 1, count: 1 }),
    ).toBe("='Q1 plan'!C2:D3");
  });

  it("references the same cells as the shifted original", () => {
    const formula = "=SUM(B2:D9)+Other!C4-IF(E5>0,$F$6,G7)";
    const shift = { axis: "col" as const, at: 2, count: 3 };
    const before = collectFormulaReferences(formula).filter((ref) => ref.tab === null);
    const after = collectFormulaReferences(shiftFormulaRefs(formula, "S", "S", shift)).filter(
      (ref) => ref.tab === null,
    );
    const move = (col: number) => (col >= 2 ? col + 3 : col);
    expect(after).toEqual(
      before.map((ref) => ({ ...ref, minCol: move(ref.minCol), maxCol: move(ref.maxCol) })),
    );
  });

  it("evaluates a deleted reference as #REF!", () => {
    const sheet = deleteRows(doc([{ name: "S", cells: { A1: 1, A2: 2, A3: "=SUM(A2)", A4: "=A2" } }]), 0, 1);
    const evaluation = evaluateSheet(sheet);
    expect(sheet.tabs[0]!.cells.A2).toBe("=SUM(#REF!)");
    expect(evaluation.valueAt(0, { col: 0, row: 1 })).toEqual({ error: "#REF!" });
    expect(evaluation.valueAt(0, { col: 0, row: 2 })).toEqual({ error: "#REF!" });
  });

  it("moves relative references when a formula is copied", () => {
    expect(offsetFormula("=A1+$B$1+B$2+$C3", 1, 2)).toBe("=B3+$B$1+C$2+$C5");
    expect(offsetFormula("=A1", -1, 0)).toBe("=#REF!");
    expect(offsetFormula("=SUM(A1:B2)", 0, 1)).toBe("=SUM(A2:B3)");
  });

  it("quotes tab names a formula could misread", () => {
    expect(formulaTabName("Costs")).toBe("Costs");
    expect(formulaTabName("Q1 plan")).toBe("'Q1 plan'");
    expect(formulaTabName("A1")).toBe("'A1'");
    expect(formulaTabName("Bob's")).toBe("'Bob''s'");
  });
});

describe("rows and columns", () => {
  const base = () =>
    doc([
      {
        name: "Data",
        cells: { A1: "Item", B1: "Cost", A2: "x", B2: 5, A3: "y", B3: 7, B4: "=SUM(B2:B3)" },
        styles: { "A1:B1": { bold: true, fill: true } },
        formats: { "B2:B4": { kind: "currency" } },
        widths: { B: 120, C: 90 },
        hiddenColumns: ["C"],
        rowGroups: [{ id: "g", label: "Items", startRow: 2, endRow: 3 }],
        charts: [{ id: "c", type: "bar", title: "Costs", labels: "A2:A3", values: "B2:B3", at: "D2" }],
      },
      { name: "Summary", cells: { A1: "=Data!B4", A2: "=SUM(Data!B2:B3)" } },
    ]);

  it("inserts a row and moves everything that carries an address", () => {
    const sheet = insertRows(base(), 0, 2);
    const data = sheet.tabs[0]!;
    expect(data.cells.B5).toBe("=SUM(B2:B4)");
    expect(data.cells.A4).toBe("y");
    expect(data.formats).toEqual({ "B2:B5": { kind: "currency" } });
    expect(data.rowGroups).toEqual([{ id: "g", label: "Items", startRow: 2, endRow: 4 }]);
    expect(data.charts![0]).toMatchObject({ labels: "A2:A4", values: "B2:B4", at: "D2" });
    expect(sheet.tabs[1]!.cells).toEqual({ A1: "=Data!B5", A2: "=SUM(Data!B2:B4)" });
    expect(validateSheetDocument(sheet).ok).toBe(true);
    expect(evaluateSheet(sheet).valueAt(1, { col: 0, row: 0 })).toBe(12);
  });

  it("deletes a column and moves widths, hidden columns and charts", () => {
    const sheet = deleteColumns(base(), 0, 0);
    const data = sheet.tabs[0]!;
    expect(data.cells.A1).toBe("Cost");
    expect(data.cells.A4).toBe("=SUM(A2:A3)");
    expect(data.widths).toEqual({ A: 120, B: 90 });
    expect(data.hiddenColumns).toEqual(["B"]);
    expect(data.styles).toEqual({ A1: { bold: true, fill: true } });
    // The chart's labels were in the deleted column: nothing left to draw.
    expect(data.charts).toBeUndefined();
    expect(sheet.tabs[1]!.cells.A1).toBe("=Data!A4");
    expect(validateSheetDocument(sheet).ok).toBe(true);
  });

  it("inserts a column before the data", () => {
    const sheet = insertColumns(base(), 0, 0, 2);
    expect(sheet.tabs[0]!.cells.D4).toBe("=SUM(D2:D3)");
    expect(sheet.tabs[0]!.charts![0]).toMatchObject({ labels: "C2:C3", values: "D2:D3", at: "F2" });
    expect(sheet.tabs[1]!.cells.A2).toBe("=SUM(Data!D2:D3)");
  });

  it("drops a row group whose rows were all deleted", () => {
    const sheet = deleteRows(base(), 0, 1, 2);
    expect(sheet.tabs[0]!.rowGroups).toBeUndefined();
    expect(sheet.tabs[0]!.cells.B2).toBe("=SUM(#REF!)");
  });
});

describe("tabs", () => {
  it("adds, renames with references following, and deletes", () => {
    let sheet = doc([
      { name: "Data", cells: { A1: 3 }, charts: [{ id: "c", type: "bar", title: "T", labels: "Data!A1:A1", values: "A1:A1" }] },
      { name: "Summary", cells: { A1: "=Data!A1*2", B1: "='Data'!A1" } },
    ]);
    const added = addTab(sheet);
    expect(added.document.tabs.map((tab) => tab.name)).toEqual(["Data", "Summary", "Sheet3"]);
    sheet = renameTab(added.document, 0, "Q1 plan");
    expect(sheet.tabs[1]!.cells).toEqual({ A1: "='Q1 plan'!A1*2", B1: "='Q1 plan'!A1" });
    expect(sheet.tabs[0]!.charts![0]!.labels).toBe("'Q1 plan'!A1");
    expect(evaluateSheet(sheet).valueAt(1, { col: 0, row: 0 })).toBe(6);
    expect(() => renameTab(sheet, 1, "q1 PLAN")).toThrow(SheetEditLimitError);
    expect(tabNameProblem(sheet, "a/b")).toMatch(/cannot hold/);
    sheet = deleteTab(sheet, 0);
    expect(sheet.tabs[0]!.cells.A1).toBe("=#REF!*2");
    expect(isSheetError(evaluateSheet(sheet).valueAt(0, { col: 0, row: 0 }))).toBe(true);
    expect(deleteTab(deleteTab(sheet, 1), 0).tabs).toHaveLength(1);
  });
});

describe("styles and formats", () => {
  it("bolds inside a filled block without losing the fill", () => {
    let sheet = doc([{ name: "S", cells: {}, styles: { "A1:E5": { fill: true } } }]);
    sheet = applyStyle(sheet, 0, r("B2:C3"), { bold: true });
    const styleAt = rangeLookup(sheet.tabs[0]!.styles);
    expect(styleAt({ col: 1, row: 1 })).toEqual({ bold: true, fill: true });
    expect(styleAt({ col: 4, row: 4 })).toEqual({ fill: true });
    expect(styleAt({ col: 0, row: 0 })).toEqual({ fill: true });
    expect(Object.keys(sheet.tabs[0]!.styles!).length).toBeLessThanOrEqual(5);
    sheet = applyStyle(sheet, 0, r("A1:E5"), { bold: undefined, fill: undefined });
    expect(sheet.tabs[0]!.styles).toBeUndefined();
  });

  it("toggles a flag off only when every cell has it", () => {
    let sheet = doc([{ name: "S", cells: {}, styles: { A1: { italic: true } } }]);
    const at = () => rangeLookup(sheet.tabs[0]!.styles);
    sheet = toggleStyleFlag(sheet, 0, r("A1:A2"), "italic", at());
    expect(at()({ col: 0, row: 1 })).toEqual({ italic: true });
    sheet = toggleStyleFlag(sheet, 0, r("A1:A2"), "italic", at());
    expect(sheet.tabs[0]!.styles).toBeUndefined();
  });

  it("draws an outline with edges only", () => {
    const sheet = applyBorders(doc([{ name: "S", cells: {} }]), 0, r("B2:D4"), "outline");
    const at = rangeLookup(sheet.tabs[0]!.styles);
    expect(at({ col: 1, row: 1 })).toEqual({ borderTop: true, borderLeft: true });
    expect(at({ col: 2, row: 2 })).toBeUndefined();
    expect(at({ col: 3, row: 3 })).toEqual({ borderRight: true, borderBottom: true });
    expect(validateSheetDocument(sheet).ok).toBe(true);
  });

  it("sets formats and steps decimals", () => {
    let sheet = setFormat(doc([{ name: "S", cells: { A1: 1.234 } }]), 0, r("A1:A3"), { kind: "currency", currency: "USD" });
    sheet = stepDecimals(sheet, 0, r("A1"), 1);
    expect(rangeLookup(sheet.tabs[0]!.formats)({ col: 0, row: 0 })).toEqual({ kind: "currency", currency: "USD", decimals: 3 });
    sheet = setFormat(sheet, 0, r("A1:A3"), null);
    expect(sheet.tabs[0]!.formats).toBeUndefined();
  });

  it("refuses an edit that would need more ranges than a tab holds", () => {
    let map: Record<string, number> = {};
    for (let row = 0; row < 200; row += 1) map = paintRangeMap(map, r(`A${row * 2 + 1}`), () => row);
    expect(() => paintRangeMap(map, r("C1"), () => 1)).toThrow(SheetEditLimitError);
  });
});

describe("history", () => {
  it("undoes and redoes", () => {
    const first = doc([{ name: "S", cells: { A1: 1 } }]);
    const second = setCells(first, 0, [[{ col: 0, row: 0 }, 2]]);
    let history = recordEdit(EMPTY_SHEET_HISTORY, first);
    const undone = undoEdit(history, second)!;
    expect(undone.document).toBe(first);
    history = undone.history;
    const redone = redoEdit(history, first)!;
    expect(redone.document).toBe(second);
    expect(undoEdit(EMPTY_SHEET_HISTORY, first)).toBeNull();
    expect(recordEdit(redone.history, second).future).toEqual([]);
  });
});
