import { describe, expect, it } from "vite-plus/test";

import { csvToSheetDocument, detectDelimiter, parseDelimited, sheetTabToCsv } from "./csv.ts";
import { evaluateSheet } from "./formula.ts";
import { type SheetDocument, SHEET_ARTIFACT_KIND, SHEET_ARTIFACT_VERSION } from "./model.ts";
import { insertRows, SheetEditLimitError } from "./edit.ts";
import {
  buildXlsxParts,
  fromXlsxFormulaText,
  xlsxColumnWidth,
  xlsxFormulaText,
  xlsxNumberFormatCode,
  xlsxPartOrder,
  xlsxSheetNames,
} from "./xlsxParts.ts";

const doc = (tabs: SheetDocument["tabs"]): SheetDocument => ({
  v: SHEET_ARTIFACT_VERSION,
  kind: SHEET_ARTIFACT_KIND,
  title: "Budget <Q1>",
  tabs,
});

const BOOK = doc([
  {
    name: "Data",
    cells: { A1: "Item", B1: "Cost", A2: "Tea & milk", B2: 4, A3: "Cake", B3: 6.5, A4: "Total", B4: "=SUM(B2:B3)", C4: "=B4>5", D4: '=CONCAT("a",A2)', E4: "=1/0" },
    formats: { "B2:B4": { kind: "currency", currency: "EUR", decimals: 2 } },
    styles: { "A1:B1": { bold: true, fill: true }, A4: { italic: true, underline: true, borderTop: true, borderBottom: true, align: "right" }, B4: { fillTone: "positive", tone: "negative" } },
    widths: { A: 180 },
    hiddenColumns: ["E"],
    gridlines: false,
  },
  { name: "A tab name that is far longer than Excel allows", cells: { A1: "=Data!B4*2" } },
]);

describe("xlsx parts", () => {
  it("writes number format codes Excel understands", () => {
    expect(xlsxNumberFormatCode(undefined)).toBeNull();
    expect(xlsxNumberFormatCode({ kind: "text" })).toBe("@");
    expect(xlsxNumberFormatCode({ kind: "percent", decimals: 1 })).toBe("0.0%");
    expect(xlsxNumberFormatCode({ kind: "number", decimals: 2 })).toBe("#,##0.00");
    expect(xlsxNumberFormatCode({ kind: "number", thousands: false })).toBe("0");
    expect(xlsxNumberFormatCode({ kind: "currency", currency: "USD", negative: "parens" })).toBe('"$"#,##0.00;("$"#,##0.00)');
    expect(xlsxNumberFormatCode({ kind: "currency", currency: "CHF" })).toBe('"CHF "#,##0.00');
  });

  it("prefixes newer functions and drops the equals sign, not inside strings", () => {
    expect(xlsxFormulaText('=CONCAT("concat(",A1)&IFNA(B1,0)')).toBe('_xlfn.CONCAT("concat(",A1)&_xlfn.IFNA(B1,0)');
    expect(xlsxFormulaText("=SUM(A1:A3)")).toBe("SUM(A1:A3)");
  });

  it("keeps tab names within 31 characters and distinct", () => {
    const names = xlsxSheetNames(doc([
      { name: "x".repeat(40), cells: {} },
      { name: "x".repeat(41), cells: {} },
    ]));
    expect(names[0]).toHaveLength(31);
    expect(names[1]).toHaveLength(31);
    expect(names[1]).toMatch(/ \(2\)$/);
  });

  it("builds every part with values, cached results and styles", () => {
    const parts = buildXlsxParts(BOOK, evaluateSheet(BOOK));
    expect(xlsxPartOrder(parts)[0]).toBe("[Content_Types].xml");
    const sheet = parts["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('<c r="B4" s="');
    expect(sheet).toMatch(/<c r="B4" s="\d+"><f>SUM\(B2:B3\)<\/f><v>10.5<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C4" t="b"><f>B4&gt;5<\/f><v>1<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="D4" t="str"><f>_xlfn.CONCAT\(&quot;a&quot;,A2\)<\/f><v>aTea &amp; milk<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="E4" t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v><\/c>/);
    expect(sheet).toContain('showGridLines="0"');
    expect(sheet).toContain(`width="${xlsxColumnWidth(180)}" customWidth="1"`);
    expect(sheet).toMatch(/<col min="5" max="5" [^>]*hidden="1"/);
    const styles = parts["xl/styles.xml"]!;
    expect(styles).toContain('formatCode="&quot;€&quot;#,##0.00"');
    expect(styles).toContain("<b/>");
    expect(styles).toContain("<i/><u/>");
    expect(styles).toContain('<fgColor rgb="FFDCFCE7"/>');
    expect(styles).toContain('<color rgb="FFDC2626"/>');
    expect(styles).toContain('<top style="thin">');
    expect(styles).toContain('horizontal="right"');
    const workbook = parts["xl/workbook.xml"]!;
    expect(workbook).toContain('fullCalcOnLoad="1"');
    const longName = xlsxSheetNames(BOOK)[1]!;
    expect(workbook).toContain(`name="${longName}"`);
    expect(parts["xl/worksheets/sheet2.xml"]).toContain("<f>Data!B4*2</f><v>21</v>");
    expect(parts["xl/sharedStrings.xml"]).toContain("<t>Tea &amp; milk</t>");
    expect(parts["docProps/core.xml"]).toContain("Budget &lt;Q1&gt;");
  });

  it("rewrites references to a renamed tab", () => {
    const book = doc([
      { name: "A tab name that is far longer than Excel allows", cells: { A1: 3 } },
      { name: "Use", cells: { A1: "='A tab name that is far longer than Excel allows'!A1+1" } },
    ]);
    const parts = buildXlsxParts(book);
    expect(parts["xl/worksheets/sheet2.xml"]).toContain(`<f>'${xlsxSheetNames(book)[0]}'!A1+1</f><v>4</v>`);
  });
});

describe("csv", () => {
  it("exports computed values with quoting, CRLF, BOM and formula guards", () => {
    const book = doc([{ name: "T", cells: { A1: "a,b", B1: 'say "hi"', A2: "=1+1", B2: "-danger", C2: true, A3: "=1/0" } }]);
    const csv = sheetTabToCsv(book.tabs[0]!, 0, evaluateSheet(book));
    expect(csv).toBe('﻿"a,b","say ""hi""",\r\n2,\'-danger,TRUE\r\n#DIV/0!,,\r\n');
  });

  it("detects the delimiter and reads quoted fields", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter('"x,y";z\n')).toBe(";");
    expect(parseDelimited('﻿a,"b\r\nc",d\r\n1,2,3', ",")).toEqual([["a", "b\r\nc", "d"], ["1", "2", "3"]]);
  });

  it("imports as a new Sheet with typed values and column formats", () => {
    const { document, truncated } = csvToSheetDocument("Item,Cost,Share\nTea,$4.50,12%\nCake,$6.00,30%\n", { title: "Import" });
    expect(truncated).toBe(false);
    const tab = document.tabs[0]!;
    expect(tab.cells).toMatchObject({ A1: "Item", B2: 4.5, B3: 6, C2: 0.12, C3: 0.3 });
    expect(tab.formats?.["B2:B3"]).toEqual({ kind: "currency", currency: "USD", decimals: 2 });
    expect(tab.formats?.["C2:C3"]).toEqual({ kind: "percent" });
  });

  it("round trips text that looks like a formula", () => {
    const book = doc([{ name: "T", cells: { A1: "'=not a formula", B1: "-x" } }]);
    const csv = sheetTabToCsv(book.tabs[0]!, 0, evaluateSheet(book));
    const back = csvToSheetDocument(csv, { title: "Back" }).document.tabs[0]!;
    expect(back.cells).toEqual({ A1: "'=not a formula", B1: "-x" });
  });
});

describe("review fixes", () => {
  it("renames all tabs at once, so a truncated name never captures another tab's references", () => {
    const long = "T".repeat(32);
    const short = "T".repeat(31);
    const book = doc([
      { name: long, cells: { A1: 10 } },
      { name: short, cells: { A1: 99 } },
      { name: "Use", cells: { A1: `='${long}'!A1` } },
    ]);
    const names = xlsxSheetNames(book);
    const sheet3 = buildXlsxParts(book)["xl/worksheets/sheet3.xml"]!;
    expect(names[0]).toBe(short);
    expect(sheet3).toContain(`<f>${names[0]}!A1</f><v>10</v>`);
    expect(sheet3).not.toContain(names[1]!);
  });

  it("leaves quoted text and quoted tab names alone when it prefixes or strips functions", () => {
    expect(xlsxFormulaText("='Forecast IFNA(1)'!A1+IFNA(B1,0)")).toBe("'Forecast IFNA(1)'!A1+_xlfn.IFNA(B1,0)");
    expect(fromXlsxFormulaText('"literal _xlfn.example"&_xlfn.CONCAT(A1)')).toBe('="literal _xlfn.example"&CONCAT(A1)');
    expect(fromXlsxFormulaText("'It''s _xlfn.IFNA('!A1")).toBe("='It''s _xlfn.IFNA('!A1");
  });

  it("refuses an insert that would push cells off the sheet", () => {
    const book = doc([{ name: "T", cells: { A100000: 42, B1: "=A100000" } }]);
    expect(() => insertRows(book, 0, 0)).toThrow(SheetEditLimitError);
    expect(insertRows(doc([{ name: "T", cells: { A5: 1 } }]), 0, 0).tabs[0]!.cells).toEqual({ A6: 1 });
  });

  it("guards CSV text that starts with an apostrophe, so its own files read back exactly", () => {
    const book = doc([{ name: "T", cells: { A1: "''=x", A2: "'hello", A3: "=1+1" } }]);
    const csv = sheetTabToCsv(book.tabs[0]!, 0, evaluateSheet(book));
    expect(csv).toContain("''=x");
    const back = csvToSheetDocument(csv, { title: "Back" }).document;
    const values = evaluateSheet(back);
    expect([0, 1, 2].map((row) => values.valueAt(0, { col: 0, row }))).toEqual(["'=x", "'hello", 2]);
  });

  it("imports CSV text that looks like a formula as text", () => {
    const tab = csvToSheetDocument("a,=1+2\n", { title: "x" }).document.tabs[0]!;
    expect(tab.cells.B1).toBe("'=1+2");
    expect(evaluateSheet(doc([tab])).valueAt(0, { col: 1, row: 0 })).toBe("=1+2");
  });

  it("prefixes a newer function written with a space before its bracket", () => {
    expect(xlsxFormulaText("=IFNA (1,0)")).toBe("_xlfn.IFNA (1,0)");
    expect(fromXlsxFormulaText("_xlfn.IFNA (1,0)")).toBe("=IFNA (1,0)");
  });

  it("flags a CSV field cut at the cell limit", () => {
    const result = csvToSheetDocument(`a,${"y".repeat(6000)}\n`, { title: "x" });
    expect(result.truncated).toBe(true);
    expect((result.document.tabs[0]!.cells.B1 as string).length).toBe(5000);
    expect(csvToSheetDocument("a,b\n", { title: "x" }).truncated).toBe(false);
  });

  it("writes text the user escaped with an apostrophe as the text they see", () => {
    const book = doc([{ name: "T", cells: { A1: "'=1+2", A2: "''=x" } }]);
    const values = evaluateSheet(book);
    expect(values.valueAt(0, { col: 0, row: 0 })).toBe("=1+2");
    expect(values.valueAt(0, { col: 0, row: 1 })).toBe("'=x");
    const strings = buildXlsxParts(book, values)["xl/sharedStrings.xml"]!;
    expect(strings).toMatch(/<t[^>]*>=1\+2<\/t>/);
    expect(strings).toMatch(/<t[^>]*>(?:'|&apos;)=x<\/t>/);
  });

  it("keeps other CSV apostrophes as text and flags only fields the cell cannot hold", () => {
    const tab = csvToSheetDocument("'North,',x\n", { title: "x" }).document.tabs[0]!;
    const values = evaluateSheet(doc([tab]));
    expect([0, 1, 2].map((col) => values.valueAt(0, { col, row: 0 }))).toEqual(["'North", "'", "x"]);
    expect(csvToSheetDocument(`${"y".repeat(5000)}\n`, { title: "x" }).truncated).toBe(false);
    expect(csvToSheetDocument(`=${"y".repeat(4999)}\n`, { title: "x" }).truncated).toBe(true);
  });
});
