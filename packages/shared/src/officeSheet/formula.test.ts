import { describe, expect, it } from "vite-plus/test";

import { evaluateSheet, isSheetError } from "./formula.ts";
import {
  type SheetCellInput,
  type SheetDocument,
  SHEET_LIMITS,
  SHEET_NAME_PATTERN,
  mergeSheetInput,
  parseCellAddress,
  parseSheetDocument,
  safeLinkHref,
  sheetSlug,
  validateSheetDocument,
} from "./model.ts";

function sheet(tabs: Record<string, Record<string, SheetCellInput>>): SheetDocument {
  const result = validateSheetDocument({
    title: "Test",
    tabs: Object.entries(tabs).map(([name, cells]) => ({ name, cells })),
  });
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

function evaluated(cells: Record<string, SheetCellInput>) {
  const document = sheet({ Main: cells });
  const evaluation = evaluateSheet(document);
  return (cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!);
}

function value(document: SheetDocument, cell: string, tab = 0) {
  return evaluateSheet(document).valueAt(tab, parseCellAddress(cell)!);
}

describe("sheet formulas", () => {
  it("does arithmetic with precedence, percent and text joining", () => {
    const doc = sheet({
      Main: {
        A1: 10,
        A2: 4,
        B1: "=A1+A2*2",
        B2: "=(A1+A2)*2",
        B3: "=-A1^2",
        B4: "=A1/A2",
        B5: "=50%*A1",
        B6: '="Total: "&A1&" units"',
        B7: "=A1>A2",
        B8: "=A1<>10",
        B9: '="a"="A"',
      },
    });
    expect(value(doc, "B1")).toBe(18);
    expect(value(doc, "B2")).toBe(28);
    expect(value(doc, "B3")).toBe(100);
    expect(value(doc, "B4")).toBe(2.5);
    expect(value(doc, "B5")).toBe(5);
    expect(value(doc, "B6")).toBe("Total: 10 units");
    expect(value(doc, "B7")).toBe(true);
    expect(value(doc, "B8")).toBe(false);
    expect(value(doc, "B9")).toBe(true);
  });

  it("evaluates every listed function", () => {
    const doc = sheet({
      Main: {
        A1: 1,
        A2: 2,
        A3: 3,
        A4: "x",
        A5: -4.5,
        B1: "App",
        B2: "Skill",
        B3: "App",
        C1: "=SUM(A1:A5)",
        C2: "=AVERAGE(A1:A3)",
        C3: "=MIN(A1:A5)",
        C4: "=MAX(A1:A5, 9)",
        C5: "=COUNT(A1:A5)",
        C6: "=COUNTA(A1:A6)",
        C7: '=COUNTIF(B1:B3, "App")',
        C8: '=COUNTIF(A1:A5, ">1")',
        C9: '=SUMIF(B1:B3, "app", A1:A3)',
        C10: '=IF(A1>0, "yes", "no")',
        C11: "=AND(A1>0, A2>0)",
        C12: "=OR(A1>5, A2>5)",
        C13: "=NOT(A1>5)",
        C14: "=ROUND(2.345, 2)",
        C15: "=ABS(A5)",
        C16: '=IFERROR(A1/0, "n/a")',
        C17: "=ROUND(-2.5)",
        C18: '=SUMIF(A1:A3, ">=2")',
      },
    });
    const evaluation = evaluateSheet(doc);
    const at = (cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!);
    expect(at("C1")).toBe(1.5);
    expect(at("C2")).toBe(2);
    expect(at("C3")).toBe(-4.5);
    expect(at("C4")).toBe(9);
    expect(at("C5")).toBe(4);
    expect(at("C6")).toBe(5);
    expect(at("C7")).toBe(2);
    expect(at("C8")).toBe(2);
    expect(at("C9")).toBe(4);
    expect(at("C10")).toBe("yes");
    expect(at("C11")).toBe(true);
    expect(at("C12")).toBe(false);
    expect(at("C13")).toBe(true);
    expect(at("C14")).toBe(2.35);
    expect(at("C15")).toBe(4.5);
    expect(at("C16")).toBe("n/a");
    expect(at("C17")).toBe(-3);
    expect(at("C18")).toBe(5);
    expect(evaluation.errors).toEqual([]);
  });

  it("reads other tabs, quoted or not, whatever the letter case", () => {
    const doc = sheet({
      Toolkit: { A1: "App", A2: "Skill", A3: "App", B1: 5, B2: 7, B3: 1 },
      "Q1 plan": { A1: 100 },
      Breakdown: {
        A1: '=COUNTIF(Toolkit!A1:A3, "App")',
        A2: "=SUM(toolkit!B1:B3)",
        A3: "='Q1 plan'!A1*2",
        A4: "=Missing!A1",
      },
    });
    expect(value(doc, "A1", 2)).toBe(2);
    expect(value(doc, "A2", 2)).toBe(13);
    expect(value(doc, "A3", 2)).toBe(200);
    expect(value(doc, "A4", 2)).toEqual({ error: "#REF!" });
  });

  it("reports each error kind and spreads it to dependents", () => {
    const doc = sheet({
      Main: {
        A1: "=1/0",
        A2: "=NOPE(1)",
        A3: '="x"+1',
        A4: "=A1+1",
        A5: "=SUM(A1:A3)",
        A6: "=1+",
        A7: "=B7",
        B7: "=A7",
        A8: "=B7+1",
        A9: "=unknownname",
      },
    });
    const evaluation = evaluateSheet(doc);
    const at = (cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!);
    expect(at("A1")).toEqual({ error: "#DIV/0!" });
    expect(at("A2")).toEqual({ error: "#NAME?" });
    expect(at("A3")).toEqual({ error: "#VALUE!" });
    expect(at("A4")).toEqual({ error: "#DIV/0!" });
    expect(isSheetError(at("A5"))).toBe(true);
    expect(at("A6")).toEqual({ error: "#ERROR!" });
    expect(at("A7")).toEqual({ error: "#CYCLE!" });
    expect(at("B7")).toEqual({ error: "#CYCLE!" });
    expect(at("A8")).toEqual({ error: "#CYCLE!" });
    expect(at("A9")).toEqual({ error: "#NAME?" });
    expect(evaluation.errors.map((entry) => entry.cell)).toContain("Main!A1");
  });

  it("computes a three-statement model and follows a changed input", () => {
    const quarters = ["B", "C", "D", "E"];
    const build = (q1Revenue: number): SheetDocument => {
      const income: Record<string, SheetCellInput> = {
        A1: "Income statement",
        A2: "Revenue",
        A3: "Cost of goods sold",
        A4: "Gross profit",
        A5: "Operating expenses",
        A6: "Operating income",
        A7: "Tax (21%)",
        A8: "Net income",
      };
      const revenue = [q1Revenue, 132000, 145000, 160000];
      quarters.forEach((col, index) => {
        income[`${col}2`] = revenue[index]!;
        income[`${col}3`] = `=${col}2*40%`;
        income[`${col}4`] = `=${col}2-${col}3`;
        income[`${col}5`] = 30000 + index * 2000;
        income[`${col}6`] = `=${col}4-${col}5`;
        income[`${col}7`] = `=ROUND(${col}6*21%, 0)`;
        income[`${col}8`] = `=${col}6-${col}7`;
      });
      income.F8 = "=SUM(B8:E8)";
      const cash: Record<string, SheetCellInput> = {
        A1: "Cash flow",
        A2: "Net income",
        A3: "Capital spending",
        A4: "Net change in cash",
        A5: "Closing cash",
      };
      quarters.forEach((col, index) => {
        cash[`${col}2`] = `='Income statement'!${col}8`;
        cash[`${col}3`] = -10000;
        cash[`${col}4`] = `=${col}2+${col}3`;
        cash[`${col}5`] = index === 0 ? `=50000+${col}4` : `=${quarters[index - 1]}5+${col}4`;
      });
      const balance: Record<string, SheetCellInput> = {
        A1: "Balance sheet",
        A2: "Cash",
        A3: "Equipment",
        A4: "Total assets",
        A5: "Debt",
        A6: "Equity",
        A7: "Liabilities and equity",
        A8: "Check",
      };
      quarters.forEach((col, index) => {
        balance[`${col}2`] = `='Cash flow'!${col}5`;
        balance[`${col}3`] = index === 0 ? "=80000+10000" : `=${quarters[index - 1]}3+10000`;
        balance[`${col}4`] = `=${col}2+${col}3`;
        balance[`${col}5`] = 40000;
        balance[`${col}6`] =
          index === 0
            ? `=90000+'Income statement'!${col}8`
            : `=${quarters[index - 1]}6+'Income statement'!${col}8`;
        balance[`${col}7`] = `=${col}5+${col}6`;
        balance[`${col}8`] = `=IF(${col}4=${col}7, "Balanced", "Off by "&(${col}4-${col}7))`;
      });
      return sheet({ "Income statement": income, "Cash flow": cash, "Balance sheet": balance });
    };

    const base = evaluateSheet(build(120000));
    const at = (evaluation: typeof base, tab: number, cell: string) =>
      evaluation.valueAt(tab, parseCellAddress(cell)!);
    // Q1: 120000 - 48000 = 72000 gross; - 30000 = 42000; tax 8820; net 33180.
    expect(at(base, 0, "B4")).toBe(72000);
    expect(at(base, 0, "B8")).toBe(33180);
    expect(at(base, 0, "F8")).toBe(33180 + 37288 + 41870 + 47400);
    expect(at(base, 1, "B5")).toBe(73180);
    expect(at(base, 1, "E5")).toBe(50000 + 159738 - 40000);
    expect(at(base, 2, "E4")).toBe(169738 + 120000);
    for (const col of quarters) expect(at(base, 2, `${col}8`)).toBe("Balanced");
    expect(base.errors).toEqual([]);

    const changed = evaluateSheet(build(220000));
    // +100000 revenue in Q1: +60000 gross, +47400 net, through every statement.
    expect(at(changed, 0, "B8")).toBe(33180 + 47400);
    expect(at(changed, 0, "F8")).toBe(159738 + 47400);
    expect(at(changed, 1, "E5")).toBe(169738 + 47400);
    expect(at(changed, 2, "E4")).toBe(289738 + 47400);
    for (const col of quarters) expect(at(changed, 2, `${col}8`)).toBe("Balanced");
  });

  it("evaluates extended statistical, conditional, lookup, math, and text functions", () => {
    const doc = sheet({
      Main: {
        A1: "Region",
        B1: "Category",
        C1: "Amount",
        A2: "US",
        B2: "Cloud",
        C2: 100,
        A3: "EU",
        B3: "Cloud",
        C3: 250,
        A4: "US",
        B4: "Support",
        C4: 150,
        A5: "US",
        B5: "Cloud",
        C5: 300,
        E1: "=MEDIAN(C2:C5)",
        E2: '=AVERAGEIF(A2:A5, "US", C2:C5)',
        E3: '=SUMIFS(C2:C5, A2:A5, "US", B2:B5, "Cloud")',
        E4: '=COUNTIFS(A2:A5, "US", C2:C5, ">120")',
        E5: '=INDEX(C2:C5, MATCH("EU", A2:A5, 0))',
        E6: '=VLOOKUP("EU", A2:C5, 3, FALSE)',
        E7: '=IFNA(VLOOKUP("APAC", A2:C5, 3, FALSE), "Missing")',
        E8: '=CONCAT(TRIM("  hello   world "), "!", LEFT("Spec", 2), RIGHT("Code", 2))',
        E9: '=UPPER(LOWER("AbC"))',
        E10: '=LEN("hello")',
        E11: "=ROUNDUP(2.11, 1)",
        E12: "=ROUNDDOWN(2.99, 1)",
        E13: "=POWER(2, 5)",
        E14: "=MOD(-7, 3)",
      },
    });
    const evaluation = evaluateSheet(doc);
    const at = (cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!);
    expect(evaluation.errors).toEqual([]);
    expect(at("E1")).toBe(200);
    expect(at("E2")).toBeCloseTo(550 / 3, 6);
    expect(at("E3")).toBe(400);
    expect(at("E4")).toBe(2);
    expect(at("E5")).toBe(250);
    expect(at("E6")).toBe(250);
    expect(at("E7")).toBe("Missing");
    expect(at("E8")).toBe("hello world!Spde");
    expect(at("E9")).toBe("ABC");
    expect(at("E10")).toBe(5);
    expect(at("E11")).toBe(2.2);
    expect(at("E12")).toBe(2.9);
    expect(at("E13")).toBe(32);
    expect(at("E14")).toBe(2);
  });

  it("tracks dependencies and cycles across expanded AVERAGEIF/SUMIF target ranges", () => {
    // Key order puts B2 after C1; B2 is a formula cell reached via expanded B1 target.
    const doc = sheet({
      Main: {
        A1: "x",
        A2: "x",
        B1: 10,
        C1: '=AVERAGEIF(A1:A2,"x",B1)',
        B2: "=30",
      },
    });
    const evaluation = evaluateSheet(doc);
    expect(evaluation.errors).toEqual([]);
    expect(evaluation.valueAt(0, parseCellAddress("C1")!)).toBe(20);

    // Back-reference from expanded B2 to C1 must be caught as a #CYCLE!
    const cyclic = sheet({
      Main: {
        A1: "x",
        A2: "x",
        B1: 10,
        C1: '=AVERAGEIF(A1:A2,"x",B1)',
        B2: "=C1+1",
      },
    });
    const cyclicEval = evaluateSheet(cyclic);
    expect(cyclicEval.valueAt(0, parseCellAddress("C1")!)).toEqual({ error: "#CYCLE!" });

    // Clamping at SHEET_LIMITS.rows when target anchor sits near the bottom of the grid.
    const clamped = sheet({
      Main: {
        A1: "x",
        A2: "x",
        A3: "x",
        B99999: 40,
        B100000: 60,
        C1: '=SUMIF(A1:A3,"x",B99999)',
        C2: '=AVERAGEIF(A1:A3,"x",B99999)',
      },
    });
    const clampedEval = evaluateSheet(clamped);
    expect(clampedEval.errors).toEqual([]);
    expect(clampedEval.valueAt(0, parseCellAddress("C1")!)).toBe(100);
    expect(clampedEval.valueAt(0, parseCellAddress("C2")!)).toBe(50);
  });
});

describe("sheet limits and validation", () => {
  it("refuses an over-long formula and names the limit", () => {
    const result = validateSheetDocument({
      title: "T",
      tabs: [{ name: "A", cells: { A1: `=${"1+".repeat(1200)}1` } }],
    });
    expect(result).toEqual({
      ok: false,
      error: 'Tab "A": the formula in A1 is over the 2000 character limit.',
    });
  });

  it("refuses too many cells and names the limit", () => {
    const cells: Record<string, number> = {};
    for (let row = 1; row <= SHEET_LIMITS.cells / 100 + 1; row += 1) {
      for (let col = 0; col < 100; col += 1) {
        cells[
          `${String.fromCharCode(65 + Math.floor(col / 26))}${String.fromCharCode(65 + (col % 26))}${row}`
        ] = 1;
      }
    }
    const result = validateSheetDocument({ title: "T", tabs: [{ name: "A", cells }] });
    expect(result).toEqual({ ok: false, error: "A sheet holds at most 200,000 cells." });
  });

  it("stops a formula nested deeper than the limit", () => {
    const deep = `=${"(".repeat(80)}1${")".repeat(80)}`;
    expect(value(sheet({ A: { A1: deep } }), "A1")).toEqual({ error: "#LIMIT!" });
  });

  it("ends within the step budget when every cell sums a huge range", () => {
    const cells: Record<string, SheetCellInput> = {};
    for (let row = 1; row <= 4000; row += 1) cells[`A${row}`] = row;
    for (let row = 1; row <= 4000; row += 1) cells[`B${row}`] = "=SUM(A1:A4000)+SUM(A1:A4000)";
    const evaluation = evaluateSheet(sheet({ A: cells }));
    expect(evaluation.limitReached).toBe(true);
    expect(evaluation.errors.some((entry) => entry.error === "#LIMIT!")).toBe(true);
  });

  it("evaluates a long dependency chain without recursion", () => {
    const cells: Record<string, SheetCellInput> = { A1: 1 };
    for (let row = 2; row <= 50000; row += 1) cells[`A${row}`] = `=A${row - 1}+1`;
    expect(value(sheet({ A: cells }), "A50000")).toBe(50000);
  });

  it("drops unknown fields, markup stays text, and bad shapes are refused", () => {
    const result = validateSheetDocument({
      title: "T",
      script: "alert(1)",
      tabs: [
        {
          name: "A",
          onload: "x",
          cells: { A1: "<img src=x onerror=alert(1)>", a2: 2 },
          styles: { A1: { bold: true, tone: "accent", color: "url(javascript:1)" } },
          formats: { "B1:B9": { kind: "currency", currency: "USD", evil: 1 } },
          charts: [{ type: "bar", title: "Share", labels: "A1:A2", values: "B1:B2", html: "<b>" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({
      v: 1,
      kind: "sheet",
      title: "T",
      tabs: [
        {
          name: "A",
          cells: { A1: "<img src=x onerror=alert(1)>", A2: 2 },
          formats: { "B1:B9": { kind: "currency", currency: "USD" } },
          styles: { A1: { bold: true, tone: "accent" } },
          charts: [
            { id: "chart-1", type: "bar", title: "Share", labels: "A1:A2", values: "B1:B2" },
          ],
        },
      ],
    });
    expect(validateSheetDocument({ title: "T", tabs: [{ name: "A!B", cells: {} }] }).ok).toBe(
      false,
    );
    expect(
      validateSheetDocument({ title: "T", tabs: [{ name: "A", cells: { ZZZ1: 1 } }] }).ok,
    ).toBe(false);
    expect(
      validateSheetDocument({ title: "T", tabs: [{ name: "A", cells: { A1: { f: 1 } } }] }).ok,
    ).toBe(false);
    expect(validateSheetDocument({ title: "T", kind: "html", tabs: [] }).ok).toBe(false);
    expect(parseSheetDocument("{not json").ok).toBe(false);
  });

  it("links only http, https and mailto", () => {
    expect(safeLinkHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeLinkHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("file:///etc/passwd")).toBeNull();
    expect(safeLinkHref("data:text/html,<b>")).toBeNull();
    expect(safeLinkHref("https://a b")).toBeNull();
    expect(safeLinkHref("example.com")).toBeNull();
    expect(safeLinkHref("HTTPS://Example.com/a")).toBe("https://example.com/a");
    expect(safeLinkHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeLinkHref("java\u0000script:alert(1)")).toBeNull();
    expect(safeLinkHref("https://exa\u0007mple.com")).toBeNull();
    expect(safeLinkHref("https://example.com/\u202egnp.exe")).toBeNull();
    expect(safeLinkHref("https://bank.example@evil.example/login")).toBeNull();
    expect(safeLinkHref("https://user:pw@example.com")).toBeNull();
    expect(safeLinkHref("mailto:a@example.com?subject=Hi&body=Pay")).toBeNull();
    expect(safeLinkHref("mailto:a@example.com,b@example.com")).toBeNull();
    expect(safeLinkHref("https:example.com")).toBeNull();
  });

  it("keeps titles in other scripts apart", () => {
    expect(sheetSlug("预算")).toMatch(/^sheet-[0-9a-f]{6}$/);
    expect(sheetSlug("预算")).toBe(sheetSlug("预算"));
    expect(sheetSlug("预算")).not.toBe(sheetSlug("бюджет"));
    expect(sheetSlug("Café plan")).toBe("cafe-plan");
    expect(SHEET_NAME_PATTERN.test(sheetSlug("Отчёт 2026 " + "x".repeat(80)))).toBe(true);
  });

  it("refuses more format ranges than a grid can check", () => {
    const formats = Object.fromEntries(
      Array.from({ length: SHEET_LIMITS.rangeEntries + 1 }, (_, index) => [
        `A${index + 1}`,
        { kind: "number" },
      ]),
    );
    const checked = validateSheetDocument({
      title: "T",
      tabs: [{ name: "A", cells: { A1: 1 }, formats }],
    });
    expect(checked.ok).toBe(false);
  });

  it("counts and sums empty cells when the criterion fits them", () => {
    const sheet = evaluated({
      A1: "x",
      A3: "y",
      B1: 1,
      B2: 2,
      B3: 4,
      C1: '=COUNTIF(A1:A4,"<>x")',
      C2: '=SUMIF(A1:A3,"<>x",B1:B3)',
      C3: '=COUNTIF(A1:A4,"x")',
      C4: '=SUMIF(A1:A3,"x",B1:B3)',
    });
    expect(sheet("C1")).toBe(3);
    expect(sheet("C2")).toBe(6);
    expect(sheet("C3")).toBe(1);
    expect(sheet("C4")).toBe(1);
  });

  it("keeps a SUMIF sum range inside the sheet's last column", () => {
    const cells: Record<string, SheetCellInput> = { H2: 999, ZZ1: 5, A3: '=SUMIF(A1:J1,"",ZZ1)' };
    for (let row = 4; row < 24; row += 1) cells[`A${row}`] = row;
    expect(evaluated(cells)("A3")).toBe(5);
    expect(evaluated({ H2: 999, ZZ1: 5, A3: '=SUMIF(A1:J1,"",ZZ1)' })("A3")).toBe(5);
  });

  it("gives an error for a number no cell can hold and for AND over no logical values", () => {
    const sheet = evaluated({ A1: "text", B1: "=1e999", B2: "=AND(A1:A3)", B3: "=OR(A1:A3,TRUE)" });
    expect(sheet("B1")).toEqual({ error: "#VALUE!" });
    expect(sheet("B2")).toEqual({ error: "#VALUE!" });
    expect(sheet("B3")).toBe(true);
  });

  it("builds on itself when a merge names one tab twice", () => {
    const base = validateSheetDocument({ title: "T", tabs: [{ name: "A", cells: { A1: 1 } }] });
    if (!base.ok) throw new Error(base.error);
    const merged = validateSheetDocument(
      mergeSheetInput(base.document, {
        tabs: [
          { name: "A", cells: { B1: 2 } },
          { name: "a", cells: { C1: 3 } },
        ],
      }),
    );
    expect(merged.ok && merged.document.tabs).toEqual([
      { name: "A", cells: { A1: 1, B1: 2, C1: 3 } },
    ]);
  });

  it("makes a safe file stem from any title", () => {
    expect(sheetSlug("Q3 Budget: Plan & Actuals")).toBe("q3-budget-plan-actuals");
    expect(sheetSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(sheetSlug("???")).toBe("sheet");
  });

  it("does not report false #CYCLE! when clipped SUMIF/AVERAGEIF formula sits in the unclipped criteria tail", () => {
    const sumCells: Record<string, SheetCellInput> = {
      A1: "keep",
      ZZ1: 5,
      B1: '=SUMIF(A1:J1,"keep",ZZ1)',
      C1: '=AVERAGEIF(A1:J1,"keep",ZZ1)',
    };
    const evalResult = evaluateSheet(sheet({ A: sumCells }));
    expect(evalResult.valueAt(0, parseCellAddress("B1")!)).toBe(5);
    expect(evalResult.valueAt(0, parseCellAddress("C1")!)).toBe(5);
    expect(evalResult.errors).toEqual([]);
  });
});
