// @effect-diagnostics nodeBuiltinImport:off - Spawns LibreOffice and writes scratch files for the recalculation check.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type SheetDocument,
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  buildXlsxParts,
  evaluateSheet,
  parseSheetDocument,
  serializeSheetDocument,
  xlsxPartOrder,
} from "@specweave-studio/shared/officeSheet";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { importWorkbook, saveWorkbook, workbookRevision } from "./WorkbookSave.ts";
import { previewWorkbook } from "./OfficePreview.ts";
import { writeXlsxWorkbook, zipFiles } from "./xlsxExport.ts";
import { readXlsxWorkbook } from "./xlsxImport.ts";

const layerTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-xlsx-export-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const BOOK: SheetDocument = {
  v: SHEET_ARTIFACT_VERSION,
  kind: SHEET_ARTIFACT_KIND,
  title: "Budget",
  tabs: [
    {
      name: "Data",
      cells: {
        A1: "Item",
        B1: "Cost",
        A2: "Tea",
        B2: 4,
        A3: "Cake",
        B3: 6.5,
        A4: "Total",
        B4: "=SUM(B2:B3)",
        C4: '=CONCAT("x",A2)',
        D4: "=PMT(0.05/12,60,-10000)",
        E4: "=IFNA(1,0)",
        F4: "=B4>5",
      },
      formats: { "B2:B4": { kind: "currency", currency: "USD", decimals: 2 }, D4: { kind: "number", decimals: 2 } },
      styles: {
        "A1:B1": { bold: true, fill: true },
        A4: { italic: true, underline: true, borderTop: true, borderBottom: true, align: "right" },
        B4: { fillTone: "positive", tone: "negative" },
      },
      widths: { A: 180 },
    },
    { name: "Summary", cells: { A1: "Double", B1: "=Data!B4*2" } },
  ],
};

function soffice(): string | null {
  for (const candidate of [
    process.env.SOFFICE_PATH,
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ]) {
    if (candidate && NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

describe("xlsx export", () => {
  it("reads back through the importer with values, formulas, formats and styles", async () => {
    const bytes = writeXlsxWorkbook(BOOK);
    expect(writeXlsxWorkbook(BOOK)).toEqual(bytes);
    const result = await readXlsxWorkbook(bytes, "Budget");
    expect(result.truncatedSheets).toBe(0);
    expect(result.unsupportedFeatures).toEqual([]);
    const parsed = parseSheetDocument(result.sheetJson);
    if (!parsed.ok) throw new Error(parsed.error);
    const [data, summary] = parsed.document.tabs;
    expect(data?.name).toBe("Data");
    expect(data?.cells).toMatchObject({
      A1: "Item",
      B2: 4,
      B3: 6.5,
      B4: "=SUM(B2:B3)",
      C4: '=CONCAT("x",A2)',
      E4: "=IFNA(1,0)",
      F4: "=B4>5",
    });
    expect(summary?.cells.B1).toBe("=Data!B4*2");
    expect(Object.values(data?.formats ?? {})).toContainEqual({ kind: "currency", currency: "USD", decimals: 2 });
    const styles = Object.values(data?.styles ?? {});
    expect(styles).toContainEqual({ bold: true, fill: true });
    expect(styles).toContainEqual({ italic: true, underline: true, borderTop: true, borderBottom: true, align: "right" });
    expect(styles).toContainEqual({ fillTone: "positive", tone: "negative" });
    expect(data?.widths?.A).toBeGreaterThan(170);
    const evaluation = evaluateSheet(parsed.document);
    expect(evaluation.valueAt(1, { col: 1, row: 0 })).toBe(21);
  });

  it.skipIf(soffice() === null)(
    "recalculates to the same values in LibreOffice, even when the saved values are wrong",
    () => {
      const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "xlsx-lo-"));
      try {
        // Wrong cached values prove LibreOffice computed the formulas itself.
        const parts = buildXlsxParts(BOOK);
        for (const name of Object.keys(parts)) {
          parts[name] = parts[name]!.replace("<v>10.5</v>", "<v>999</v>").replace("<v>21</v>", "<v>777</v>");
        }
        const encoder = new TextEncoder();
        const file = NodePath.join(scratch, "wrong.xlsx");
        NodeFS.writeFileSync(file, zipFiles(xlsxPartOrder(parts).map((n) => [n, encoder.encode(parts[n]!)] as const)));
        // A private profile that always recalculates Excel files on load.
        NodeFS.mkdirSync(NodePath.join(scratch, "profile", "user"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(scratch, "profile", "user", "registrymodifications.xcu"),
          `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
        );
        NodeChildProcess.execFileSync(
          soffice()!,
          [
            `-env:UserInstallation=${new URL(`file://${NodePath.join(scratch, "profile").replaceAll("\\", "/")}`).href}`,
            "--headless",
            "--convert-to",
            'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1',
            "--outdir",
            scratch,
            file,
          ],
          { stdio: "ignore", timeout: 120_000 },
        );
        const data = NodeFS.readFileSync(NodePath.join(scratch, "wrong-Data.csv"), "utf8").trim().split(/\r?\n/);
        const summary = NodeFS.readFileSync(NodePath.join(scratch, "wrong-Summary.csv"), "utf8").trim();
        const total = data[3]!.split(",");
        const ours = evaluateSheet(BOOK);
        expect(Number(total[1])).toBe(ours.valueAt(0, { col: 1, row: 3 }));
        expect(total[2]).toBe(ours.valueAt(0, { col: 2, row: 3 }));
        expect(Number(total[3])).toBeCloseTo(ours.valueAt(0, { col: 3, row: 3 }) as number, 9);
        expect(total[4]).toBe("1");
        expect(total[5]).toBe("TRUE");
        expect(summary.split(",")[1]).toBe("21");
      } finally {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe("workbook save and import", () => {
  it.effect("saves over the file only at the revision it read, and the file opens again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-xlsx-save-" });
      const file = path.join(root, "budget.xlsx");
      yield* fs.writeFile(file, writeXlsxWorkbook(BOOK));

      const opened = yield* previewWorkbook({ path: file });
      expect(opened.revision).toBe(workbookRevision(yield* fs.readFile(file)));
      const parsed = parseSheetDocument(opened.sheetJson);
      if (!parsed.ok) throw new Error(parsed.error);
      const edited: SheetDocument = {
        ...parsed.document,
        tabs: parsed.document.tabs.map((tab, index) =>
          index === 0 ? { ...tab, cells: { ...tab.cells, B2: 40 } } : tab,
        ),
      };
      const sheetJson = serializeSheetDocument(edited);
      const saved = yield* saveWorkbook({ path: file, sheetJson, expectedRevision: opened.revision! });
      expect(saved.revision).toBe(workbookRevision(yield* fs.readFile(file)));

      const again = yield* previewWorkbook({ path: file });
      const reread = parseSheetDocument(again.sheetJson);
      expect(reread.ok && reread.document.tabs[0]?.cells.B2).toBe(40);

      // The old revision no longer matches the file.
      const stale = yield* saveWorkbook({ path: file, sheetJson, expectedRevision: opened.revision! }).pipe(Effect.flip);
      expect(stale.code).toBe("conflict");

      const missing = yield* saveWorkbook({
        path: path.join(root, "nope.xlsx"),
        sheetJson,
        expectedRevision: saved.revision,
      }).pipe(Effect.flip);
      expect(missing.code).toBe("not_found");

      const wrongType = yield* saveWorkbook({ path: path.join(root, "a.csv"), sheetJson, expectedRevision: "x" }).pipe(
        Effect.flip,
      );
      expect(wrongType.code).toBe("invalid");

      const badJson = yield* saveWorkbook({ path: file, sheetJson: "{}", expectedRevision: saved.revision }).pipe(
        Effect.flip,
      );
      expect(badJson.code).toBe("invalid");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("lets only one of two saves from the same revision win", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-xlsx-race-" });
      const file = path.join(root, "budget.xlsx");
      yield* fs.writeFile(file, writeXlsxWorkbook(BOOK));
      yield* fs.symlink(root, path.join(root, "linked"));
      const revision = workbookRevision(yield* fs.readFile(file));
      const edit = (cell: string) =>
        serializeSheetDocument({
          ...BOOK,
          tabs: BOOK.tabs.map((tab, index) => (index === 0 ? { ...tab, cells: { ...tab.cells, [cell]: 1 } } : tab)),
        });
      const results = yield* Effect.all(
        [
          Effect.result(saveWorkbook({ path: file, sheetJson: edit("G1"), expectedRevision: revision })),
          // The same file through a linked folder still waits for the first save.
          Effect.result(
            saveWorkbook({ path: path.join(root, "linked", "budget.xlsx"), sheetJson: edit("H1"), expectedRevision: revision }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const failures = results.filter((result) => result._tag === "Failure");
      expect(results.length - failures.length).toBe(1);
      expect(failures).toHaveLength(1);
      expect((failures[0] as { failure: { code: string } }).failure.code).toBe("conflict");
    }).pipe(Effect.provide(layerTest)),
  );

  it("names worksheet parts a save would drop, such as filters and validation", async () => {
    const parts = buildXlsxParts(BOOK);
    parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet1.xml"]!.replace(
      "</sheetData>",
      '</sheetData><autoFilter ref="A1:B4"/><dataValidations count="1"><dataValidation sqref="A2"/></dataValidations>',
    );
    const encoder = new TextEncoder();
    const bytes = zipFiles(xlsxPartOrder(parts).map((n) => [n, encoder.encode(parts[n]!)] as const));
    const result = await readXlsxWorkbook(bytes, "Filtered");
    expect(result.unsupportedFeatures).toEqual(expect.arrayContaining(["Filters", "Data validation (dropdowns)"]));
  });

  it("keeps quoted text that mentions a function prefix", async () => {
    const book: SheetDocument = { ...BOOK, tabs: [{ name: "T", cells: { A1: '="literal _xlfn.example"' } }] };
    const parsed = parseSheetDocument((await readXlsxWorkbook(writeXlsxWorkbook(book), "T")).sheetJson);
    expect(parsed.ok && parsed.document.tabs[0]?.cells.A1).toBe('="literal _xlfn.example"');
  });

  it("keeps text that starts with an apostrophe and an equals sign as that text", async () => {
    const book: SheetDocument = { ...BOOK, tabs: [{ name: "T", cells: { A1: "'=1+2", A2: "''=x", A3: "=1+2" } }] };
    const parsed = parseSheetDocument((await readXlsxWorkbook(writeXlsxWorkbook(book), "T")).sheetJson);
    const cells = parsed.ok ? parsed.document.tabs[0]!.cells : {};
    expect(cells).toMatchObject({ A1: "'=1+2", A2: "''=x", A3: "=1+2" });
  });

  it("names print settings and named ranges a save would drop", async () => {
    const parts = buildXlsxParts(BOOK);
    parts["xl/workbook.xml"] = parts["xl/workbook.xml"]!.replace(
      "</sheets>",
      '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$B$4</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$B$4</definedName><definedName name="Costs">Data!$B$2:$B$3</definedName></definedNames>',
    );
    const encoder = new TextEncoder();
    const bytes = zipFiles(xlsxPartOrder(parts).map((n) => [n, encoder.encode(parts[n]!)] as const));
    const result = await readXlsxWorkbook(bytes, "Printed");
    expect(result.unsupportedFeatures).toEqual(expect.arrayContaining(["Print settings", "Named ranges"]));
  });

  it.effect("imports uploaded bytes as a sheet without writing anything", () =>
    Effect.gen(function* () {
      const data = Buffer.from(writeXlsxWorkbook(BOOK)).toString("base64");
      const result = yield* importWorkbook({ title: "budget.xlsx", data });
      const parsed = parseSheetDocument(result.sheetJson);
      expect(parsed.ok && parsed.document.title).toBe("budget");
      expect(result.sheetCount).toBe(2);
      const bad = yield* importWorkbook({ title: "x", data: Buffer.from("not a zip").toString("base64") }).pipe(
        Effect.flip,
      );
      expect(bad.code).toBe("invalid");
    }).pipe(Effect.provide(layerTest)),
  );
});
