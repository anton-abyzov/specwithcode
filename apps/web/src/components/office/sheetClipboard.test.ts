// @vitest-environment jsdom
import {
  type SheetDocument,
  evaluateSheet,
  parseCellRange,
  rangeLookup,
} from "@specweave-studio/shared/officeSheet";
import { describe, expect, it } from "vite-plus/test";

import {
  copySheetRange,
  parseClipboardHtml,
  parseTsv,
  planSheetPaste,
  readSheetClipboard,
} from "./sheetClipboard";

const r = (text: string) => parseCellRange(text)!;
const LIMITS = { rows: 100_000, columns: 702 };

const SHEET: SheetDocument = {
  v: 1,
  kind: "sheet",
  title: "T",
  tabs: [
    {
      name: "S",
      cells: { A1: "Item", B1: "Cost", A2: "Tea, green", B2: 1200.5, A3: 'Say "hi"\nthere', B3: "=B2*2" },
      formats: { "B2:B3": { kind: "currency", currency: "USD" } },
      styles: { "A1:B1": { bold: true } },
    },
  ],
};

function copy(range: string) {
  const tab = SHEET.tabs[0]!;
  return copySheetRange({
    tab,
    tabIndex: 0,
    evaluation: evaluateSheet(SHEET),
    range: r(range),
    formatOf: rangeLookup(tab.formats),
    styleOf: rangeLookup(tab.styles),
  })!;
}

describe("copy", () => {
  it("writes formatted TSV with Excel quoting, and an HTML table", () => {
    const payload = copy("A1:B3");
    expect(payload.text).toBe('Item\tCost\nTea, green\t$1,200.50\n"Say ""hi""\nthere"\t$2,401.00');
    expect(payload.html).toContain('<td style="font-weight:bold">Item</td>');
    expect(payload.html).toContain("Say &quot;hi&quot;<br>there");
    expect(parseTsv(payload.text)).toEqual([
      ["Item", "Cost"],
      ["Tea, green", "$1,200.50"],
      ['Say "hi"\nthere', "$2,401.00"],
    ]);
  });

  it("pastes its own formulas moved to the new place", () => {
    const grid = readSheetClipboard({ html: copy("B2:B3").html, text: "ignored" })!;
    expect(grid.internal?.origin).toEqual({ col: 1, row: 1 });
    const plan = planSheetPaste(grid, r("D5"), LIMITS)!;
    expect(plan.entries).toEqual([
      [{ col: 3, row: 4 }, 1200.5],
      [{ col: 3, row: 5 }, "=D5*2"],
    ]);
    expect(plan.range).toEqual(r("D5:D6"));
  });
});

describe("paste from other apps", () => {
  it("keeps text that looks like a formula as text", () => {
    const grid = readSheetClipboard({ html: "<table><tr><td>=1+2</td><td>4</td></tr></table>" })!;
    const plan = planSheetPaste(grid, r("A1"), LIMITS)!;
    expect(plan.entries).toEqual([
      [{ col: 0, row: 0 }, "'=1+2"],
      [{ col: 1, row: 0 }, 4],
    ]);
  });

  it("reads an Excel HTML table, numbers and merged cells", () => {
    const excel = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><!--StartFragment--><table>
      <tr><td colspan=2 x:str>Region</td><td>Total</td></tr>
      <tr><td rowspan=2>North</td><td x:num="12">12</td><td x:num>1,234.50</td></tr>
      <tr><td>7</td><td>45%</td></tr></table><!--EndFragment--></body></html>`;
    const grid = parseClipboardHtml(excel)!;
    expect(grid.rows).toEqual([
      ["Region", "", "Total"],
      ["North", "12", "1,234.50"],
      ["", "7", "45%"],
    ]);
    const plan = planSheetPaste(grid, r("A1"), LIMITS)!;
    expect(plan.entries.find(([at]) => at.col === 2 && at.row === 1)?.[1]).toBe(1234.5);
    expect(plan.entries.find(([at]) => at.col === 2 && at.row === 2)?.[1]).toBe(0.45);
    expect(plan.formats).toEqual([[{ col: 2, row: 2 }, { kind: "percent" }]]);
  });

  it("reads a Google Sheets table and never runs what it holds", () => {
    const sheets = `<meta charset="utf-8"><google-sheets-html-origin><style>td{}</style><table xmlns="http://www.w3.org/1999/xhtml" data-sheets-root="1"><tbody><tr><td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;a&quot;}">a<script>window.pwned=1</script></td><td><img src=x onerror="window.pwned=1">b</td></tr></tbody></table></google-sheets-html-origin>`;
    const grid = readSheetClipboard({ html: sheets, text: "a\tb" })!;
    expect(grid.rows).toEqual([["a", "b"]]);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("falls back to TSV and fills a selection from one cell", () => {
    const grid = readSheetClipboard({ text: "5" })!;
    const plan = planSheetPaste(grid, r("B2:C3"), LIMITS)!;
    expect(plan.entries).toHaveLength(4);
    expect(plan.entries.every(([, value]) => value === 5)).toBe(true);
  });

  it("keeps the shape of a block and refuses one past the sheet's edge", () => {
    const grid = readSheetClipboard({ text: "a\tb\r\nc\td\r\n" })!;
    expect(grid.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(planSheetPaste(grid, r("A1"), { rows: 1, columns: 2 })).toBeNull();
  });
});
