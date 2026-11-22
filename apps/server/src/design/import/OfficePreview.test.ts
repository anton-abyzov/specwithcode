// @effect-diagnostics nodeBuiltinImport:off - Uses Node Buffer for synthetic OOXML ZIP fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DesignPreviewDocumentResult,
  DesignPreviewWorkbookResult,
} from "@specweave-studio/contracts";
import { evaluateSheet, parseCellAddress, parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { readDocxDocument } from "./docxImport.ts";
import { previewDocument, previewWorkbook } from "./OfficePreview.ts";
import { storedZip } from "./pptxImport.testkit.ts";
import { readXlsxWorkbook } from "./xlsxImport.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-office-preview-test-",
});
const layerTest = layerConfig.pipe(Layer.provideMerge(NodeServices.layer));
const decodeWorkbook = Schema.decodeUnknownSync(DesignPreviewWorkbookResult);
const decodeDocument = Schema.decodeUnknownSync(DesignPreviewDocumentResult);

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function buildSampleXlsx(extraFiles: ReadonlyArray<readonly [string, string | Buffer]> = []): Buffer {
  return storedZip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Revenue" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
    ],
    [
      "xl/sharedStrings.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Quarter</t></si>
  <si><t>Revenue</t></si>
  <si><t>Margin</t></si>
  <si><t>Date</t></si>
  <si><t>Q1</t></si>
  <si><t>Q2</t></si>
  <si><t>Total</t></si>
</sst>`,
    ],
    [
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="$#,##0.00"/>
  </numFmts>
  <fonts count="2">
    <font/>
    <font><b/></font>
  </fonts>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0"/>
    <xf numFmtId="0" fontId="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="164" fontId="0"/>
    <xf numFmtId="10" fontId="0"/>
    <xf numFmtId="14" fontId="0"/>
  </cellXfs>
</styleSheet>`,
    ],
    [
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols><col min="1" max="1" width="18"/><col min="2" max="2" width="14"/></cols>
  <sheetData>
    <row r="1">
      <c r="A1" t="s" s="1"><v>0</v></c>
      <c r="B1" t="s" s="1"><v>1</v></c>
      <c r="C1" t="s" s="1"><v>2</v></c>
      <c r="D1" t="s" s="1"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2" s="2"><v>1200.5</v></c>
      <c r="C2" s="3"><v>0.42</v></c>
      <c r="D2" s="4"><v>46023</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>5</v></c>
      <c r="B3" s="2"><v>1800</v></c>
      <c r="C3" s="3"><v>0.48</v></c>
      <c r="D3" s="4"><v>46113</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s" s="1"><v>6</v></c>
      <c r="B4" s="2"><f>SUM(B2:B3)</f><v>3000.5</v></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="C4:D4"/></mergeCells>
</worksheet>`,
    ],
    [
      "xl/worksheets/sheet2.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Inline note</t></is></c>
      <c r="B1" t="b"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>`,
    ],
    ...extraFiles,
  ]);
}

function buildSampleDocx(extraFiles: ReadonlyArray<readonly [string, string | Buffer]> = []): Buffer {
  return storedZip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Executive Summary</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Revenue grew </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>42%</w:t></w:r>
      <w:r><w:t xml:space="preserve"> — see </w:t></w:r>
      <w:hyperlink r:id="rIdExt"><w:r><w:t>external report</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> or </w:t></w:r>
      <w:hyperlink w:anchor="appendix"><w:r><w:t>Appendix</w:t></w:r></w:hyperlink>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>First bullet item</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Second bullet item</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:trPr><w:tblHeader/></w:trPr>
        <w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>$3.0M</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:docPr id="1" name="Chart snapshot" descr="Q2 chart"/>
          <a:blip r:embed="rIdImg1"/>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p><w:bookmarkStart w:id="9" w:name="appendix"/><w:r><w:t>Appendix notes</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    ],
    [
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.example/tracker" TargetMode="External"/>
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
</Relationships>`,
    ],
    [
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`,
    ],
    ["word/media/chart.png", PNG_1X1],
    ...extraFiles,
  ]);
}

describe("xlsx workbook preview", () => {
  it("parses multi-sheet workbooks into valid SheetDocument JSON with formulas, dates, and formats", async () => {
    const result = await readXlsxWorkbook(buildSampleXlsx([["xl/charts/chart1.xml", "<chart/>"]]), "Q2 Model");
    decodeWorkbook(result);

    expect(result.sheetCount).toBe(2);
    expect(result.truncatedSheets).toBe(0);
    expect(result.unsupportedFeatures).toContain("Merged cell spans");
    expect(result.unsupportedFeatures).toContain("Charts");

    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.title).toBe("Q2 Model");
    expect(parsed.document.tabs).toHaveLength(2);
    const revenue = parsed.document.tabs[0]!;
    expect(revenue.name).toBe("Revenue");
    expect(revenue.cells.A1).toBe("Quarter");
    expect(revenue.cells.B2).toBe(1200.5);
    expect(revenue.cells.B4).toBe("=SUM(B2:B3)");
    // Excel serial 46023 = 2026-01-01
    expect(revenue.cells.D2).toBe("2026-01-01");
    // Cells that share a format are stored as one range.
    expect(revenue.formats?.["B2:B4"]).toEqual({ kind: "currency", currency: "USD", decimals: 2 });
    expect(revenue.formats?.["C2:C3"]).toEqual({ kind: "percent", decimals: 2 });
    expect(revenue.styles?.["A1:D1"]).toEqual({ bold: true, align: "center" });
    expect(revenue.widths?.A).toBeGreaterThan(100);

    const evaluated = evaluateSheet(parsed.document);
    expect(evaluated.valueAt(0, parseCellAddress("B4")!)).toBe(3000.5);
  });

  it("keeps formats and bold on every row of a long table as a few ranges, and says so when it cannot", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => {
      const r = index + 2;
      // Row 150 has no rate: the percent range still runs past the empty cell.
      const rate = r === 150 ? "" : `<c r="C${r}" s="3"><v>0.${10 + (index % 80)}</v></c>`;
      return `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>Row ${r}</t></is></c><c r="B${r}" s="2"><v>${1000 + index}.5</v></c>${rate}</row>`;
    }).join("");
    const long = buildSampleXlsx([
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c><c r="C1" t="s" s="1"><v>2</v></c></row>
    ${rows}
  </sheetData>
</worksheet>`,
      ],
    ]);
    const result = await readXlsxWorkbook(long, "Long");
    const tab = parseSheetDocument(result.sheetJson);
    if (!tab.ok) throw new Error(tab.error);
    const first = tab.document.tabs[0]!;
    expect(first.formats).toEqual({
      "B2:B301": { kind: "currency", currency: "USD", decimals: 2 },
      "C2:C301": { kind: "percent", decimals: 2 },
    });
    expect(first.styles).toEqual({ "A1:C1": { bold: true, align: "center" } });
    expect(result.unsupportedFeatures.join()).not.toContain("too many different ranges");

    // 250 separate formatted cells with unformatted numbers between them cannot be joined.
    const scattered = Array.from({ length: 500 }, (_, index) => {
      const r = index + 1;
      return `<row r="${r}"><c r="A${r}"${index % 2 === 0 ? ' s="2"' : ""}><v>${r}</v></c></row>`;
    }).join("");
    const sparse = buildSampleXlsx([
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${scattered}</sheetData></worksheet>`,
      ],
    ]);
    const capped = await readXlsxWorkbook(sparse, "Sparse");
    const cappedDoc = parseSheetDocument(capped.sheetJson);
    if (!cappedDoc.ok) throw new Error(cappedDoc.error);
    expect(Object.keys(cappedDoc.document.tabs[0]!.formats ?? {})).toHaveLength(200);
    expect(capped.unsupportedFeatures).toContain("Some number formats (too many different ranges)");
  });

  it("recomputes XNPV and XIRR over date cells and still falls back for other date arithmetic", async () => {
    const dated = buildSampleXlsx([
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" s="4"><v>39448</v></c><c r="B1"><v>-10000</v></c></row>
    <row r="2"><c r="A2" s="4"><v>39508</v></c><c r="B2"><v>2750</v></c></row>
    <row r="3"><c r="A3" s="4"><v>39751</v></c><c r="B3"><v>4250</v></c></row>
    <row r="4"><c r="A4" s="4"><v>39859</v></c><c r="B4"><v>3250</v></c></row>
    <row r="5"><c r="A5" s="4"><v>39904</v></c><c r="B5"><v>2750</v></c></row>
    <row r="6"><c r="A6"><f>XNPV(0.09,B1:B5,A1:A5)</f></c><c r="B6"><f>XIRR(B1:B5,A1:A5)</f></c><c r="C6"><f>A5-A1</f><v>456</v></c></row>
  </sheetData>
</worksheet>`,
      ],
    ]);
    const result = await readXlsxWorkbook(dated, "Dated");
    const parsed = parseSheetDocument(result.sheetJson);
    if (!parsed.ok) throw new Error(parsed.error);
    const cells = parsed.document.tabs[0]!.cells;
    expect(cells.A1).toBe("2008-01-01");
    // The formulas stay live although their dates are text.
    expect(cells.A6).toBe("=XNPV(0.09,B1:B5,A1:A5)");
    expect(cells.B6).toBe("=XIRR(B1:B5,A1:A5)");
    // Subtracting dates still shows what Excel computed.
    expect(cells.C6).toBe(456);
    const evaluated = evaluateSheet(parsed.document);
    expect(evaluated.valueAt(0, parseCellAddress("A6")!)).toBeCloseTo(2086.6476020315354, 6);
    expect(evaluated.valueAt(0, parseCellAddress("B6")!)).toBeCloseTo(0.37336253351883136, 8);
    expect(evaluated.errors).toEqual([]);
  });

  it("keeps Excel's saved XNPV and XIRR where its dates and the app's would not agree", async () => {
    const sheet = (rows: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rows}</sheetData>
</worksheet>`;
    const formulas = `<row r="3"><c r="A3"><f>XNPV(0.1,A1:A2,B1:B2)</f><v>0</v></c><c r="B3"><f>XIRR(A1:A2,B1:B2)</f><v>0.1</v></c></row>`;
    const read = async (files: ReadonlyArray<readonly [string, string]>) => {
      const result = await readXlsxWorkbook(buildSampleXlsx(files), "Dates");
      const parsed = parseSheetDocument(result.sheetJson);
      if (!parsed.ok) throw new Error(parsed.error);
      return { cells: parsed.document.tabs[0]!.cells, notes: result.unsupportedFeatures };
    };

    // A 1904 workbook: one date is a plain serial, the other a formatted date.
    const system1904 = await read([
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="1"/>
  <sheets>
    <sheet name="Revenue" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        sheet(
          `<row r="1"><c r="A1"><v>-100</v></c><c r="B1"><v>43830</v></c></row>
    <row r="2"><c r="A2"><v>110</v></c><c r="B2" s="4"><v>44195</v></c></row>${formulas}`,
        ),
      ],
    ]);
    expect(system1904.cells.A3).toBe(0);
    expect(system1904.cells.B3).toBe(0.1);
    expect(system1904.notes.join(" ")).toContain("showing cached values");

    // Serials 59 and 61 are two days apart in Excel and one day apart on the calendar.
    const leapDay = await read([
      [
        "xl/worksheets/sheet1.xml",
        sheet(
          `<row r="1"><c r="A1"><v>-100</v></c><c r="B1" s="4"><v>59</v></c></row>
    <row r="2"><c r="A2"><v>110</v></c><c r="B2" s="4"><v>61</v></c></row>${formulas}`,
        ),
      ],
    ]);
    expect(leapDay.cells.A3).toBe(0);
    expect(leapDay.cells.B3).toBe(0.1);

    // A date with a time zone is not one the formula engine reads.
    const zoned = await read([
      [
        "xl/worksheets/sheet1.xml",
        sheet(
          `<row r="1"><c r="A1"><v>-100</v></c><c r="B1" t="d" s="4"><v>2026-01-01T00:00:00+02:00</v></c></row>
    <row r="2"><c r="A2"><v>110</v></c><c r="B2" t="d" s="4"><v>2027-01-01T00:00:00+02:00</v></c></row>${formulas}`,
        ),
      ],
    ]);
    expect(zoned.cells.A3).toBe(0);
    expect(zoned.cells.B3).toBe(0.1);
    expect(zoned.notes.join(" ")).toContain("showing cached values");
  });

  it("rejects macro-enabled workbooks and XXE/DOCTYPE payloads", async () => {
    const withMacro = buildSampleXlsx([["xl/vbaProject.bin", Buffer.from([1, 2, 3])]]);
    await expect(readXlsxWorkbook(withMacro, "Macros")).rejects.toMatchObject({
      code: "invalid",
    });

    const withXxe = storedZip([
      [
        "xl/workbook.xml",
        `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><workbook/>`,
      ],
    ]);
    await expect(readXlsxWorkbook(withXxe, "XXE")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("handles unsafe column ranges, out-of-grid cells, 1904 dates, and literal '=' strings", async () => {
    const weirdXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="1"/>
  <sheets><sheet name="Edge" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      [
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="9007199254740993" max="9007199254740993" width="12"/>
    <col min="1" max="5000" width="14"/>
  </cols>
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>=notAFormula</t></is></c>
      <c r="B1" s="1"><v>0</v></c>
      <c r="AAA1"><v>99</v></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>kept-after-out-of-grid</t></is></c>
    </row>
  </sheetData>
</worksheet>`,
      ],
    ]);

    const result = await readXlsxWorkbook(weirdXlsx, "Edge");
    expect(result.truncatedSheets).toBe(1);
    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tab = parsed.document.tabs[0]!;
    expect(tab.cells.A1).toBe("'=notAFormula");
    expect(tab.cells.B1).toBe("1904-01-01");
    expect(tab.cells.AAA1).toBeUndefined();
    expect(tab.cells.A2).toBe("kept-after-out-of-grid");
  });

  it("falls back to cached values for long or unsupported formulas and truncates heavily escaped text cleanly", async () => {
    const longFormula = `SUM(${Array.from({ length: 450 }, (_, i) => `B${i + 1}`).join(",")})`;
    expect(longFormula.length).toBeGreaterThan(2000);
    const quoteHeavyNote = '"'.repeat(4500);
    const quoteRows = Array.from(
      { length: 470 },
      (_, i) => `<row r="${i + 3}"><c r="A${i + 3}" t="inlineStr"><is><t>${quoteHeavyNote}</t></is></c></row>`,
    ).join("");

    const xlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Edge2" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1"><f>${longFormula}</f><v>42</v></c>
      <c r="B1" t="str"><f>_xlfn.UNIQUE(C1:C5)</f><v>cached-unique</v></c>
      <c r="C1"><f>SUM(A:A)</f><v>77</v></c>
      <c r="D1" t="b"><f>ISNUMBER(A1)</f><v>1</v></c>
      <c r="E1"><f>SUM(Sales)</f><v></v></c>
      <c r="F1"><f>SUM(Sales)</f><v>0</v></c>
      <c r="G1" t="b"><f>IFERROR(ISNUMBER(A1),FALSE)</f><v>1</v></c>
      <c r="H1"><f>IFERROR(A1/0,99)</f><v>99</v></c>
      <c r="I1"><f>IFERROR(ISNUMBER(A1),FALSE)</f></c>
    </row>
    ${quoteRows}
  </sheetData>
</worksheet>`,
      ],
    ]);

    const result = await readXlsxWorkbook(xlsx, "Edge2");
    expect(result.truncatedSheets).toBe(1);
    expect(result.unsupportedFeatures).toContain("Long formulas (showing cached values)");
    expect(result.unsupportedFeatures).toContain("Unsupported Excel formulas (showing cached values)");
    expect(result.unsupportedFeatures).toContain("Unsupported Excel formulas (some cells have no cached value)");
    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tab = parsed.document.tabs[0]!;
    expect(tab.cells.A1).toBe(42);
    expect(tab.cells.B1).toBe("cached-unique");
    expect(tab.cells.C1).toBe(77);
    expect(tab.cells.D1).toBe(true);
    expect(tab.cells.E1).toBe("#UNSUPPORTED");
    expect(tab.cells.F1).toBe(0);
    expect(tab.cells.G1).toBe(true);
    // Edge2 is truncated by quoteRows, so live formulas conservatively fall back to cached values.
    expect(tab.cells.H1).toBe(99);
    expect(tab.cells.I1).toBe("#UNSUPPORTED");
    expect(result.unsupportedFeatures).toContain("Formulas on truncated workbook (showing cached values)");
  });

  it("preserves cached totals on truncated workbooks and date-dependent formulas without corrupting live numeric formulas", async () => {
    // 1. Truncated workbook (>12,000 cells): B1 = SUM(A2:A12001) with cached 61999 must not recompute to 11999.
    const truncatedRows = [
      `<row r="1"><c r="B1"><f>SUM(A2:A12001)</f><v>61999</v></c><c r="C1"><f>SUM(A2:A12001)</f></c></row>`,
      ...Array.from({ length: 11999 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>1</v></c></row>`),
      `<row r="12001"><c r="A12001"><v>50000</v></c></row>`,
    ].join("");
    const truncatedXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${truncatedRows}</sheetData></worksheet>`,
      ],
    ]);

    const truncRes = await readXlsxWorkbook(truncatedXlsx, "Big");
    expect(truncRes.truncatedSheets).toBe(1);
    expect(truncRes.unsupportedFeatures).toContain("Formulas on truncated workbook (showing cached values)");
    expect(truncRes.unsupportedFeatures).toContain("Formulas on truncated workbook (some cells have no cached value)");
    const truncParsed = parseSheetDocument(truncRes.sheetJson);
    expect(truncParsed.ok).toBe(true);
    if (!truncParsed.ok) return;
    expect(truncParsed.document.tabs[0]!.cells.B1).toBe(61999);
    expect(truncParsed.document.tabs[0]!.cells.C1).toBe("#UNSUPPORTED");

    // 2. Date-formatted cells: formulas referencing converted dates use cached values,
    // while unrelated numeric formulas remain live.
    const dateXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      [
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>46023</v></c><c r="B1" s="1"><f>A1+1</f><v>46024</v></c><c r="C1"><f>SUM(A1)</f><v>46023</v></c><c r="D1"><f>IFERROR(10/0,99)</f><v>99</v></c><c r="E1" s="1"><f>B1+1</f><v>46025</v></c></row></sheetData></worksheet>`,
      ],
    ]);

    const dateRes = await readXlsxWorkbook(dateXlsx, "Dates");
    expect(dateRes.truncatedSheets).toBe(0);
    expect(dateRes.unsupportedFeatures).toContain(
      "Formulas referencing date, error, or unavailable cells (showing cached values)",
    );
    const dateParsed = parseSheetDocument(dateRes.sheetJson);
    expect(dateParsed.ok).toBe(true);
    if (!dateParsed.ok) return;
    const dateTab = dateParsed.document.tabs[0]!;
    expect(dateTab.cells.A1).toBe("2026-01-01");
    expect(dateTab.cells.B1).toBe("2026-01-02");
    expect(dateTab.cells.C1).toBe(46023);
    expect(dateTab.cells.D1).toBe("=IFERROR(10/0,99)");
    expect(dateTab.cells.E1).toBe("2026-01-03");
    const dateEval = evaluateSheet(dateParsed.document);
    expect(dateEval.valueAt(0, parseCellAddress("D1")!)).toBe(99);
  });

  it.effect("previews a host .xlsx file and rejects invalid paths/extensions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-xlsx-preview-" });
      const file = path.join(root, "budget.xlsx");
      yield* fs.writeFile(file, buildSampleXlsx());

      const ok = yield* previewWorkbook({ path: file });
      expect(ok.sheetCount).toBe(2);
      const parsed = parseSheetDocument(ok.sheetJson);
      expect(parsed.ok && parsed.document.title).toBe("budget");

      const wrongExt = path.join(root, "legacy.xls");
      yield* fs.writeFileString(wrongExt, "legacy");
      const extErr = yield* previewWorkbook({ path: wrongExt }).pipe(Effect.flip);
      expect(extErr.code).toBe("invalid");

      const relErr = yield* previewWorkbook({ path: "relative/budget.xlsx" }).pipe(Effect.flip);
      expect(relErr.code).toBe("invalid");
    }).pipe(Effect.provide(layerTest)),
  );

  it("propagates uncached date-dependent intermediates to downstream SUM and rounds large values accurately", async () => {
    const workbook = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      [
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" s="1"><v>46023</v></c>
      <c r="B1"><f>A1+1</f></c>
      <c r="C1"><f>SUM(B1)</f><v>46024</v></c>
      <c r="D1"><f>ROUND(1000000000.1,0)</f><v>1000000000</v></c>
    </row>
  </sheetData>
</worksheet>`,
      ],
    ]);

    const result = await readXlsxWorkbook(workbook, "Summary");
    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const computed = evaluateSheet(parsed.document);
    expect(computed.valueAt(0, parseCellAddress("A1")!)).toBe("2026-01-01");
    expect(computed.valueAt(0, parseCellAddress("B1")!)).toBe("#UNSUPPORTED");
    // C1 must keep its cached value instead of summing #UNSUPPORTED as 0.
    expect(computed.valueAt(0, parseCellAddress("C1")!)).toBe(46024);
    // D1 stays live and evaluates ROUND(1000000000.1, 0) === 1000000000 without drift.
    expect(parsed.document.tabs[0]!.cells.D1).toBe("=ROUND(1000000000.1,0)");
    expect(computed.valueAt(0, parseCellAddress("D1")!)).toBe(1000000000);
  });

  it("handles native error cells, uncached array formulas, exact 15-digit ROUND, and 3,200-row date chains fast", async () => {
    const chainRows = Array.from({ length: 3199 }, (_, i) => {
      const r = i + 1;
      return `<row r="${r}"><c r="A${r}"><f>A${r + 1}</f><v>${46023}</v></c></row>`;
    });
    chainRows.push(`<row r="3200"><c r="A3200" s="1"><v>46023</v></c></row>`);

    const workbook = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Errors" sheetId="1" r:id="rId1"/>
    <sheet name="Chain" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
      ],
      [
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="e"><v>#N/A</v></c>
      <c r="B1" t="e"><f>SUM(A1)</f><v>#N/A</v></c>
      <c r="C1"><f>IFERROR(A1,99)</f><v>99</v></c>
      <c r="D1"><f t="array" ref="D1">SUM(E1:E2)</f></c>
      <c r="E1"><f>SUM(D1)</f><v>42</v></c>
      <c r="F1"><f>ROUND(999999999999999,0)</f><v>999999999999999</v></c>
    </row>
  </sheetData>
</worksheet>`,
      ],
      [
        "xl/worksheets/sheet2.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${chainRows.join("")}</sheetData>
</worksheet>`,
      ],
    ]);

    const t0 = performance.now();
    const result = await readXlsxWorkbook(workbook, "Audit");
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(2000);
    expect(result.unsupportedFeatures).toContain("Shared/array formulas (some cells have no cached value)");

    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const computed = evaluateSheet(parsed.document);
    expect(computed.valueAt(0, parseCellAddress("B1")!)).toBe("#N/A");
    expect(computed.valueAt(0, parseCellAddress("C1")!)).toBe(99);
    expect(computed.valueAt(0, parseCellAddress("D1")!)).toBe("#UNSUPPORTED");
    expect(computed.valueAt(0, parseCellAddress("E1")!)).toBe(42);
    expect(computed.valueAt(0, parseCellAddress("F1")!)).toBe(999999999999999);
    expect(computed.valueAt(1, parseCellAddress("A1")!)).toBe(46023);
  });

  it("uses AST formula refs for spaced ranges, scientific literals, and native t=d dates", async () => {
    const workbook = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Dates" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      [
        "xl/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>`,
      ],
      [
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1"><v>1</v></c>
      <c r="B1" s="1"><v>46023</v></c>
      <c r="C1"><v>2</v></c>
      <c r="D1"><f>SUM(A1 : C1)</f><v>46026</v></c>
      <c r="E1" s="1"><v>46023</v></c>
      <c r="F1"><f>1E1+1</f></c>
      <c r="G1" t="d"><v>2026-01-01T00:00:00</v></c>
      <c r="H1"><f>SUM(G1)</f><v>46023</v></c>
    </row>
  </sheetData>
</worksheet>`,
      ],
    ]);

    const result = await readXlsxWorkbook(workbook, "AstRefs");
    expect(result.unsupportedFeatures).toContain(
      "Formulas referencing date, error, or unavailable cells (showing cached values)",
    );
    const parsed = parseSheetDocument(result.sheetJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const computed = evaluateSheet(parsed.document);
    // Spaced range A1 : C1 catches tainted date B1 -> keeps cached 46026.
    expect(computed.valueAt(0, parseCellAddress("D1")!)).toBe(46026);
    // Scientific literal 1E1+1 does NOT match tainted E1 -> evaluates live to 11.
    expect(computed.valueAt(0, parseCellAddress("F1")!)).toBe(11);
    // Native OOXML t="d" date taints SUM(G1) -> keeps cached 46023.
    expect(computed.valueAt(0, parseCellAddress("H1")!)).toBe(46023);
  });

  it("taints 3-arg SUMIF/AVERAGEIF across expanded target ranges and falls back on step-budget exhaustion", async () => {
    const expandedSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1"><v>1</v></c>
      <c r="B1"><v>1</v></c>
      <c r="C1"><f>SUMIF(A1:A2,1,B1)</f><v>46024</v></c>
      <c r="D1"><f>AVERAGEIF(A1:A2,1,B1)</f><v>23012</v></c>
    </row>
    <row r="2">
      <c r="A2"><v>1</v></c>
      <c r="B2" t="d"><v>2026-01-01</v></c>
    </row>
  </sheetData>
</worksheet>`;

    const expandedXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", expandedSheet],
    ]);

    const expandedRes = await readXlsxWorkbook(expandedXlsx, "expanded.xlsx");
    const expandedDoc = parseSheetDocument(expandedRes.sheetJson);
    expect(expandedDoc.ok).toBe(true);
    if (!expandedDoc.ok) return;
    expect(expandedDoc.document.tabs[0]?.cells.C1).toBe(46024);
    expect(expandedDoc.document.tabs[0]?.cells.D1).toBe(23012);

    // 1,800 rows of SUM($A$1:$A$1800) exceeds evaluateSheet's step budget -> falls back to cached values instead of #LIMIT!.
    const rows: string[] = [];
    for (let r = 1; r <= 1800; r += 1) {
      rows.push(
        `<row r="${r}"><c r="A${r}"><v>1</v></c><c r="B${r}"><f>SUM($A$1:$A$1800)</f><v>1800</v></c></row>`,
      );
    }
    const heavySheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rows.join("")}</sheetData>
</worksheet>`;
    const heavyXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", heavySheet],
    ]);

    const heavyRes = await readXlsxWorkbook(heavyXlsx, "heavy.xlsx");
    const heavyDoc = parseSheetDocument(heavyRes.sheetJson);
    expect(heavyDoc.ok).toBe(true);
    if (!heavyDoc.ok) return;
    const heavyEval = evaluateSheet(heavyDoc.document);
    expect(heavyEval.limitReached).toBe(false);
    expect(heavyEval.valueAt(0, parseCellAddress("B1")!)).toBe(1800);
    expect(heavyEval.valueAt(0, parseCellAddress("B1800")!)).toBe(1800);
    expect(
      heavyRes.unsupportedFeatures.some((u) =>
        u.includes("Formula evaluation exceeded preview step limit"),
      ),
    ).toBe(true);
  });

  it("budgets cached formula replacements against preview byte limit and falls back per-cell #LIMIT! formulas", async () => {
    // 1) Mixed numeric SUMs triggering limitReached + 1,800 short refs with 2,000-char cached strings.
    // Must stay within SHEET_LIMITS.bytes instead of throwing too_large.
    const longText = "x".repeat(2000);
    const budgetRows: string[] = [];
    for (let r = 1; r <= 1800; r += 1) {
      const extraCell =
        r === 1 ? `<c r="D1" t="inlineStr"><is><t>${longText}</t></is></c>` : "";
      budgetRows.push(
        `<row r="${r}">` +
          `<c r="A${r}"><v>1</v></c>` +
          `<c r="B${r}"><f>SUM($A$1:$A$1800)</f><v>1800</v></c>` +
          `<c r="C${r}" t="str"><f>D1</f><v>${longText}</v></c>` +
          extraCell +
          `</row>`,
      );
    }
    const budgetSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${budgetRows.join("")}</sheetData>
</worksheet>`;
    const budgetXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", budgetSheet],
    ]);

    const budgetRes = await readXlsxWorkbook(budgetXlsx, "budget.xlsx");
    const budgetDoc = parseSheetDocument(budgetRes.sheetJson);
    expect(budgetDoc.ok).toBe(true);
    if (!budgetDoc.ok) return;
    expect(budgetDoc.document.tabs[0]?.cells.B1).toBe(1800);
    // Overflow cached strings fall back to #UNSUPPORTED instead of throwing too_large.
    expect(budgetDoc.document.tabs[0]?.cells.C1800).toBe("#UNSUPPORTED");
    expect(
      budgetRes.unsupportedFeatures.some((u) =>
        u.includes("Cached formula results exceeded preview size limit"),
      ),
    ).toBe(true);

    // 2) Per-cell #LIMIT! from text concat exceeding SHEET_LIMITS.textChars, plus dependent LEN and IFERROR.
    const halfText = "a".repeat(3000);
    const fullText = "a".repeat(6000);
    const perCellSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>${halfText}</t></is></c>
      <c r="B1" t="str"><f>A1&amp;A1</f><v>${fullText}</v></c>
      <c r="C1"><f>LEN(B1)</f><v>6000</v></c>
      <c r="D1" t="str"><f>IFERROR(B1,"err")</f><v>ok-cached</v></c>
    </row>
  </sheetData>
</worksheet>`;
    const perCellXlsx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      ],
      [
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", perCellSheet],
    ]);

    const perCellRes = await readXlsxWorkbook(perCellXlsx, "percell-limit.xlsx");
    const perCellDoc = parseSheetDocument(perCellRes.sheetJson);
    expect(perCellDoc.ok).toBe(true);
    if (!perCellDoc.ok) return;
    const perCellEval = evaluateSheet(perCellDoc.document);
    expect(perCellEval.errors).toEqual([]);
    expect(perCellEval.valueAt(0, parseCellAddress("C1")!)).toBe(6000);
    expect(perCellEval.valueAt(0, parseCellAddress("D1")!)).toBe("ok-cached");
    expect(
      perCellRes.unsupportedFeatures.some((u) =>
        u.includes("Formula evaluation exceeded preview limit"),
      ),
    ).toBe(true);
  });
});

describe("docx document preview", () => {
  it("extracts paragraphs and tables wrapped in Word content controls (w:sdt)", async () => {
    const sdtDocx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      ],
      [
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:sdt>
      <w:sdtContent>
        <w:p>
          <w:r><w:t>Contract clause: </w:t></w:r>
          <w:sdt>
            <w:sdtContent>
              <w:r><w:rPr><w:b/></w:rPr><w:t>Net 30</w:t></w:r>
            </w:sdtContent>
          </w:sdt>
        </w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Fee</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>$5,000</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:sdtContent>
    </w:sdt>
  </w:body>
</w:document>`,
      ],
    ]);

    const result = await readDocxDocument(sdtDocx);
    decodeDocument(result);
    const para = result.blocks.find((b) => b.type === "paragraph");
    expect(para?.type).toBe("paragraph");
    if (para?.type === "paragraph") {
      expect(para.runs.map((r) => r.text).join("")).toBe("Contract clause: Net 30");
      expect(para.runs.some((r) => r.text === "Net 30" && r.bold === true)).toBe(true);
    }
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(table.rows[0]?.cells[1]?.runs[0]?.text).toBe("$5,000");
    }
  });

  it("flattens and discloses nested tables and discloses deeply nested content controls", async () => {
    let deepSdt = `<w:p><w:r><w:t>Hidden deep text</w:t></w:r></w:p>`;
    for (let i = 0; i < 17; i += 1) {
      deepSdt = `<w:sdt><w:sdtContent>${deepSdt}</w:sdtContent></w:sdt>`;
    }
    const docx = storedZip([
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      ],
      [
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>Charges</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Fee</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>$5000</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:tc>
      </w:tr>
    </w:tbl>
    ${deepSdt}
  </w:body>
</w:document>`,
      ],
    ]);

    const result = await readDocxDocument(docx);
    decodeDocument(result);
    expect(result.unsupportedFeatures).toContain("Nested tables (flattened into cell text)");
    expect(result.unsupportedFeatures).toContain("Deeply nested content controls (omitted)");
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      const cellText = table.rows[0]?.cells[0]?.runs.map((r) => r.text).join("") ?? "";
      expect(cellText).toContain("Charges");
      expect(cellText).toContain("Fee");
      expect(cellText).toContain("$5000");
    }
  });
  it("parses headings, styled runs, lists, tables, images, and strips external links", async () => {
    const result = await readDocxDocument(
      buildSampleDocx([["word/comments.xml", "<w:comments/>"]]),
    );
    decodeDocument(result);

    expect(result.unsupportedFeatures).toContain("Comments");
    expect(result.imagesOmitted).toBe(0);

    const heading = result.blocks.find((b) => b.type === "heading");
    expect(heading).toMatchObject({ type: "heading", level: 1 });
    expect(heading?.type === "heading" ? heading.runs[0]?.text : "").toBe("Executive Summary");

    const para = result.blocks.find((b) => b.type === "paragraph");
    expect(para?.type).toBe("paragraph");
    if (para?.type === "paragraph") {
      expect(para.runs.some((r) => r.text === "42%" && r.bold === true)).toBe(true);
      // External link is stripped to plain text (no anchor)
      const extRun = para.runs.find((r) => r.text === "external report");
      expect(extRun).toBeDefined();
      expect(extRun?.anchor).toBeUndefined();
      // Internal fragment anchor is preserved
      const anchorRun = para.runs.find((r) => r.text === "Appendix");
      expect(anchorRun?.anchor).toBe("appendix");
    }

    const list = result.blocks.find((b) => b.type === "list");
    expect(list).toMatchObject({ type: "list", ordered: false });
    if (list?.type === "list") {
      expect(list.items).toHaveLength(2);
    }

    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]?.cells[0]?.header).toBe(true);
    }

    const img = result.blocks.find((b) => b.type === "image");
    expect(img?.type).toBe("image");
    if (img?.type === "image") {
      expect(img.alt).toBe("Q2 chart");
      expect(result.images[img.asset]).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
    }
  });

  it("points a contents entry and a cross-reference at the paragraph that carries their bookmark", async () => {
    const docx = buildSampleDocx([
      [
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:hyperlink w:anchor="_Toc100"><w:r><w:t>1. Scope</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink w:anchor="terms"><w:r><w:t>See terms</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink w:anchor="nowhere"><w:r><w:t>Dangling</w:t></w:r></w:hyperlink></w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:bookmarkStart w:id="0" w:name="_GoBack"/>
      <w:bookmarkStart w:id="1" w:name="_Toc100"/>
      <w:bookmarkStart w:id="2" w:name="scope"/>
      <w:r><w:t>Scope</w:t></w:r>
    </w:p>
    <w:bookmarkStart w:id="3" w:name="terms"/>
    <w:p><w:r><w:t>Terms and conditions</w:t></w:r></w:p>
  </w:body>
</w:document>`,
      ],
    ]);
    const result = await readDocxDocument(docx);
    decodeDocument(result);
    const heading = result.blocks.find((block) => block.type === "heading");
    expect(heading).toMatchObject({ id: "_Toc100" });
    const terms = result.blocks.find(
      (block) => block.type === "paragraph" && block.runs[0]?.text === "Terms and conditions",
    );
    expect(terms).toMatchObject({ id: "terms" });
    const anchors = result.blocks.flatMap((block) =>
      block.type === "paragraph" ? block.runs.map((run) => run.anchor) : [],
    );
    // The link to a bookmark the document does not have is plain text, and says so.
    expect(anchors.filter(Boolean)).toEqual(["_Toc100", "terms"]);
    expect(result.unsupportedFeatures).toContain(
      "Links to places the preview does not show (shown as text)",
    );
    // A link to the heading's second bookmark lands on the same paragraph.
    const viaSecond = await readDocxDocument(
      buildSampleDocx([
        [
          "word/document.xml",
          `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:hyperlink w:anchor="scope"><w:r><w:t>Scope</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:bookmarkStart w:id="1" w:name="_Toc100"/><w:bookmarkStart w:id="2" w:name="scope"/><w:r><w:t>Scope text</w:t></w:r></w:p>
  </w:body>
</w:document>`,
        ],
      ]),
    );
    expect(viaSecond.blocks[0]).toMatchObject({ runs: [{ anchor: "_Toc100" }] });
    expect(viaSecond.blocks[1]).toMatchObject({ id: "_Toc100" });
  });

  it("reads a list that comes from the paragraph style", async () => {
    const docx = buildSampleDocx([
      [
        "word/styles.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet2"><w:name w:val="List Bullet 2"/><w:basedOn w:val="ListBullet"/></w:style>
</w:styles>`,
      ],
      [
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ListBullet2"/></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Not a list item</w:t></w:r></w:p>
  </w:body>
</w:document>`,
      ],
    ]);
    const result = await readDocxDocument(docx);
    decodeDocument(result);
    expect(result.blocks).toMatchObject([
      { type: "list", items: [{ runs: [{ text: "One" }] }, { runs: [{ text: "Two" }] }] },
      { type: "paragraph", runs: [{ text: "Not a list item" }] },
    ]);
  });

  it("rejects macro-enabled documents and path-traversal entries", async () => {
    const withMacro = buildSampleDocx([["word/vbaProject.bin", Buffer.from([1, 2, 3])]]);
    await expect(readDocxDocument(withMacro)).rejects.toMatchObject({
      code: "invalid",
    });

    const traversal = storedZip([["../evil.xml", "<x/>"]]);
    await expect(readDocxDocument(traversal)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it.effect("previews a host .docx file and rejects .doc files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-docx-preview-" });
      const file = path.join(root, "spec.docx");
      yield* fs.writeFile(file, buildSampleDocx());

      const ok = yield* previewDocument({ path: file });
      expect(ok.blocks.length).toBeGreaterThanOrEqual(4);

      const legacy = path.join(root, "old.doc");
      yield* fs.writeFileString(legacy, "old");
      const err = yield* previewDocument({ path: legacy }).pipe(Effect.flip);
      expect(err.code).toBe("invalid");
    }).pipe(Effect.provide(layerTest)),
  );
});
