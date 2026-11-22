import { describe, expect, it } from "vite-plus/test";

import { evaluateSheet, isFormulaSupported, isSheetError } from "./formula.ts";
import { FINANCIAL_FUNCTIONS, dateSerial, evaluateFinancial } from "./formulaFinance.ts";
import {
  type SheetCellInput,
  SHEET_LIMITS,
  parseCellAddress,
  validateSheetDocument,
} from "./model.ts";

function evaluated(cells: Record<string, SheetCellInput>) {
  const result = validateSheetDocument({ title: "Test", tabs: [{ name: "Main", cells }] });
  if (!result.ok) throw new Error(result.error);
  const evaluation = evaluateSheet(result.document);
  return Object.assign((cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!), {
    evaluation,
  });
}

/** One formula's number, failing the test when it is not a number. */
function number(formula: string, cells: Record<string, SheetCellInput> = {}): number {
  const value = evaluated({ ...cells, Z1: formula })("Z1");
  if (typeof value !== "number") throw new Error(`${formula} gave ${JSON.stringify(value)}`);
  return value;
}

function errorOf(formula: string, cells: Record<string, SheetCellInput> = {}): string | null {
  const value = evaluated({ ...cells, Z1: formula })("Z1");
  return isSheetError(value) ? value.error : null;
}

/** Within 1e-6 of the reference, relative to its size. */
function near(actual: number, reference: number): void {
  expect(Math.abs(actual - reference)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(reference)));
}

// Reference values: Microsoft's documented examples, each recomputed by
// simulating the schedule period by period at 40 digits.
describe("loan and annuity functions", () => {
  it("PMT matches the documented payments, at period end and at period start", () => {
    near(number("=PMT(0.08/12, 10, 10000)"), -1037.0320893591522);
    near(number("=PMT(0.08/12, 10, 10000, 0, 1)"), -1030.1643271779657);
    near(number("=PMT(0.06/12, 18*12, 0, 50000)"), -129.08116086799092);
  });

  it("PMT at a zero rate divides the amount evenly", () => {
    expect(number("=PMT(0, 12, 1200)")).toBe(-100);
    expect(number("=PMT(0, 10, 1000, 500)")).toBe(-150);
  });

  it("FV, PV and NPER match the documented results", () => {
    near(number("=FV(0.06/12, 10, -200, -500, 1)"), 2581.4033740601792);
    near(number("=FV(0.12/12, 12, -1000)"), 12682.503013196972);
    near(number("=PV(0.08/12, 12*20, 500, , 0)"), -59777.14585118802);
    near(number("=NPER(0.12/12, -100, -1000, 10000, 1)"), 59.67386567429457);
    expect(number("=FV(0, 5, -100, -50)")).toBe(550);
    expect(number("=PV(0, 5, -100)")).toBe(500);
    expect(number("=NPER(0, -100, 1000)")).toBe(10);
  });

  it("NPER holds a term whose growth ratio is far from one", () => {
    // 0.5^n = 1 / (1 + 1E16)
    near(number("=NPER(-0.5, -0.5, 1E16)"), Math.log(1e16) / Math.log(2));
    near(number("=NPER(1E-12, -100, 1200)"), 12);
    // The payments hold the balance at exactly 100 short of the target: no term gets there.
    expect(errorOf("=NPER(-0.07, -7, -300, 100)")).toBe("#NUM!");
  });

  it("IPMT and PPMT split a payment into interest and principal", () => {
    near(number("=IPMT(0.1/12, 1, 3*12, 8000)"), -66.66666666666667);
    near(number("=IPMT(0.1, 3, 3, 8000)"), -292.4471299093656);
    near(number("=PPMT(0.1/12, 1, 2*12, 2000)"), -75.62318600836634);
    near(number("=PPMT(0.08, 10, 10, 200000)"), -27598.053462421375);
    // Paid at the start of the period: the first payment is all principal.
    expect(number("=IPMT(0.09/12, 1, 360, 125000, 0, 1)")).toBe(0);
    near(number("=PPMT(0.09/12, 1, 360, 125000, 0, 1)"), -998.2910880208223);
    near(number("=IPMT(0.09/12, 2, 360, 125000, 0, 1)"), -930.0128168398438);
  });

  it("every payment is its interest plus its principal", () => {
    for (const period of [1, 2, 7, 59, 60]) {
      const payment = number("=PMT(0.07/12, 60, 25000)");
      const parts = number(
        `=IPMT(0.07/12, ${period}, 60, 25000) + PPMT(0.07/12, ${period}, 60, 25000)`,
      );
      near(parts, payment);
    }
  });

  it("CUMIPMT and CUMPRINC total a stretch of the schedule", () => {
    near(number("=CUMIPMT(0.09/12, 30*12, 125000, 13, 24, 0)"), -11135.232130750843);
    near(number("=CUMIPMT(0.09/12, 30*12, 125000, 1, 1, 0)"), -937.5);
    near(number("=CUMPRINC(0.09/12, 30*12, 125000, 13, 24, 0)"), -934.1071234208983);
    near(number("=CUMIPMT(0.09/12, 30*12, 125000, 13, 24, 1)"), -11052.339583871804);
    near(number("=CUMPRINC(0.09/12, 30*12, 125000, 13, 24, 1)"), -927.1534723780628);
    // The whole term repays the whole loan.
    near(number("=CUMPRINC(0.05/12, 48, 20000, 1, 48, 0)"), -20000);
  });

  it("RATE finds the documented rate and a zero rate", () => {
    near(number("=RATE(4*12, -200, 8000)"), 0.007701472488202044);
    near(number("=RATE(10, -100, 1000)"), 0);
    near(number("=RATE(12, -1000, 0, 12682.503013196972)"), 0.01);
  });

  it("keeps its precision at a rate close to zero", () => {
    near(number("=FV(1E-14, 12, -100, 0)"), 1200.0000000000657);
    near(number("=PMT(1E-14, 12, 1200)"), -100.00000000000651);
    near(number("=FV(1E-16, 12, -100, 0)"), 1200);
    near(number("=PV(1E-16, 12, -100, 0)"), 1200);
    near(number("=NPER(1E-16, -100, 1200)"), 12);
    near(number("=NPER(1E-9, -100, 1200)"), 12.000000066);
    near(number("=EFFECT(0.05, 1000000000000000)"), 0.051271096376024);
    near(number("=NOMINAL(0.051271096376024, 1000000000000000)"), 0.05);
  });

  it("SLN, EFFECT and NOMINAL match the documented results", () => {
    expect(number("=SLN(30000, 7500, 10)")).toBe(2250);
    near(number("=EFFECT(0.0525, 4)"), 0.05354266737075819);
    near(number("=NOMINAL(0.053543, 4)"), 0.052500319868356016);
  });
});

describe("cash flow functions", () => {
  const flows = { A1: -70000, A2: 12000, A3: 15000, A4: 18000, A5: 21000, A6: 26000 };

  it("NPV discounts the first value by one period", () => {
    near(number("=NPV(0.1, -10000, 3000, 4200, 6800)"), 1188.443412335223);
    near(number("=NPV(0.1, A1:A4)", { A1: -10000, A2: 3000, A3: 4200, A4: 6800 }), 1188.443412335223);
    expect(number("=NPV(0, 100, 200)")).toBe(300);
  });

  it("IRR matches the documented returns, positive and negative", () => {
    near(number("=IRR(A1:A6)", flows), 0.08663094803653162);
    near(number("=IRR(A1:A5)", flows), -0.021244848273410991);
    near(number("=IRR(A1:A6, 0.5)", flows), 0.08663094803653162);
  });

  it("IRR is the rate at which NPV is zero", () => {
    const rate = number("=IRR(A1:A6)", flows);
    const worth = number(`=NPV(${rate}, A2:A6) + A1`, flows);
    expect(Math.abs(worth)).toBeLessThan(1e-4);
  });

  it("IRR still converges from a poor guess and on steep flows", () => {
    near(number("=IRR(A1:A6, 5)", flows), 0.08663094803653162);
    near(number("=IRR(A1:A2)", { A1: -100, A2: 1000 }), 9);
    near(number("=IRR(A1:A2)", { A1: -1000, A2: 10 }), -0.99);
  });

  it("MIRR matches the documented return", () => {
    const cells = { A1: -120000, A2: 39000, A3: 30000, A4: 21000, A5: 37000, A6: 46000 };
    near(number("=MIRR(A1:A6, 0.1, 0.12)", cells), 0.1260941303659051);
  });

  it("reads a range row by row even when the file lists cells out of order", () => {
    // B1:C2 holds -100, 50, 30, 60 in reading order; the file order is scrambled.
    const cells = { C2: 60, B1: -100, C1: 50, B2: 30 };
    near(number("=NPV(0.1, B1:C2)", cells), -100 / 1.1 + 50 / 1.21 + 30 / 1.331 + 60 / 1.4641);
  });

  it("skips text and empty cells inside a range, as a spreadsheet does", () => {
    const cells = { A1: -1000, A2: "note", A4: 600, A5: true, A6: 600 };
    near(number("=NPV(0.05, A1:A6)", cells), -1000 / 1.05 + 600 / 1.05 ** 2 + 600 / 1.05 ** 3);
  });

  const dated = {
    A1: -10000,
    A2: 2750,
    A3: 4250,
    A4: 3250,
    A5: 2750,
    B1: "2008-01-01",
    B2: "2008-03-01",
    B3: "2008-10-30",
    B4: "2009-02-15",
    B5: "2009-04-01",
  };

  it("XNPV and XIRR match the documented results with ISO dates", () => {
    near(number("=XNPV(0.09, A1:A5, B1:B5)", dated), 2086.6476020315354);
    near(number("=XIRR(A1:A5, B1:B5)", dated), 0.37336253351883136);
  });

  it("XNPV and XIRR give the same results with serial dates", () => {
    const serials = { ...dated, B1: 39448, B2: 39508, B3: 39751, B4: 39859, B5: 39904 };
    near(number("=XNPV(0.09, A1:A5, B1:B5)", serials), 2086.6476020315354);
    near(number("=XIRR(A1:A5, B1:B5, 0.2)", serials), 0.37336253351883136);
  });

  it("turns ISO dates into Excel serial days", () => {
    expect(dateSerial("1970-01-01")).toBe(25569);
    expect(dateSerial("2008-01-01")).toBe(39448);
    expect(dateSerial("2024-02-29")).toBe(45351);
    expect(dateSerial("2026-11-22 14:32")).toBe(46348);
    expect(dateSerial(46348.75)).toBe(46348);
    expect(dateSerial("2023-02-29")).toEqual({ error: "#VALUE!" });
    expect(dateSerial("22/11/2026")).toEqual({ error: "#VALUE!" });
    expect(dateSerial(true)).toEqual({ error: "#VALUE!" });
  });
});

describe("financial function errors and limits", () => {
  it("answers #NUM! outside a function's domain", () => {
    expect(errorOf("=PMT(0.05, 0, 1000)")).toBe("#NUM!");
    expect(errorOf("=PMT(-1, 10, 1000)")).toBe("#NUM!");
    expect(errorOf("=IPMT(0.05, 0, 10, 1000)")).toBe("#NUM!");
    expect(errorOf("=PPMT(0.05, 11, 10, 1000)")).toBe("#NUM!");
    // A payment below the interest never repays the loan.
    expect(errorOf("=NPER(0.05, -10, 1000)")).toBe("#NUM!");
    expect(errorOf("=NPER(0, 0, 1000)")).toBe("#NUM!");
    expect(errorOf("=CUMIPMT(0, 12, 1000, 1, 12, 0)")).toBe("#NUM!");
    expect(errorOf("=CUMPRINC(0.01, 12, 1000, 5, 4, 0)")).toBe("#NUM!");
    expect(errorOf("=CUMPRINC(0.01, 12, 1000, 1, 13, 0)")).toBe("#NUM!");
    expect(errorOf("=CUMIPMT(0.01, 12, 1000, 1, 12, 2)")).toBe("#NUM!");
    expect(errorOf("=EFFECT(0, 4)")).toBe("#NUM!");
    expect(errorOf("=NOMINAL(0.05, 0)")).toBe("#NUM!");
    expect(errorOf("=XNPV(-1, A1:A2, B1:B2)", { A1: -1, A2: 2, B1: 1, B2: 2 })).toBe("#NUM!");
  });

  it("answers #NUM! when no rate of return exists", () => {
    expect(errorOf("=IRR(A1:A3)", { A1: 100, A2: 200, A3: 300 })).toBe("#NUM!");
    expect(errorOf("=IRR(A1:A3)", { A1: -100, A2: -200, A3: -300 })).toBe("#NUM!");
    expect(errorOf("=XIRR(A1:A2, B1:B2)", { A1: 5, A2: 5, B1: 1, B2: 400 })).toBe("#NUM!");
    expect(errorOf("=RATE(10, 100, 1000)")).toBe("#NUM!");
  });

  it("answers #NUM! when the balance only fades toward zero and never crosses it", () => {
    // 100(x*x - x + 1) / x^3 with x = 1 + rate is positive for every rate above -100%.
    const flows = { A1: 0, A2: 100, A3: -100, A4: 100, B1: 1, B2: 366, B3: 731, B4: 1096 };
    expect(errorOf("=IRR(A1:A4)", flows)).toBe("#NUM!");
    expect(errorOf("=XIRR(A1:A4, B1:B4)", flows)).toBe("#NUM!");
    // 200(1 + rate) is zero only at -100%, outside the domain.
    expect(errorOf("=RATE(1, 100, 100, 0, 1)")).toBe("#NUM!");
    expect(errorOf("=RATE(5, 0, 0)")).toBe("#NUM!");
  });

  it("does not take an amount that rounded away to nothing for a zero balance", () => {
    // 2,000 empty periods ahead of flows with no root: the discount factor overflows.
    const late: Record<string, SheetCellInput> = { A2001: 100, A2002: -100, A2003: 100 };
    for (let row = 1; row <= 2000; row += 1) late[`A${row}`] = 0;
    expect(errorOf("=IRR(A1:A2003)", late)).toBe("#NUM!");
    const flows = { A1: 0, A2: 100, A3: -100, A4: 100, B1: 1, B2: 36501, B3: 36866, B4: 37231 };
    expect(errorOf("=IRR(A1:A4, 1E155)", flows)).toBe("#NUM!");
    expect(errorOf("=XIRR(A1:A4, B1:B4, 2000)", flows)).toBe("#NUM!");
    expect(errorOf("=RATE(2000, 0, 100, 0, -0.9)")).toBe("#NUM!");
    // The growth factor is still a number here, the amount times it is not.
    expect(errorOf("=RATE(1070, 0, 0.01)")).toBe("#NUM!");
    // A long plan with a real answer still finds it.
    const plan: Record<string, SheetCellInput> = { A1: -1000 };
    for (let row = 2; row <= 361; row += 1) plan[`A${row}`] = 10;
    near(number("=IRR(A1:A361)", plan), number("=RATE(360, 10, -1000)"));
  });

  it("finds the rate of tiny amounts instead of accepting the guess", () => {
    near(number("=IRR(A1:A2)", { A1: -1e-12, A2: 2e-12 }), 1);
    // The same loan a million million times larger has the same rate.
    near(number("=RATE(10, -1E-12, 8E-12)"), number("=RATE(10, -1, 8)"));
    expect(number("=RATE(10, -1E-12, 8E-12)")).toBeLessThan(0.05);
    near(number("=IRR(A1:A2, 0.9)", { A1: -1e-12, A2: 2e-12 }), 1);
  });

  it("answers #NUM! when dates and values do not line up", () => {
    const cells = { A1: -100, A2: 60, A3: 60, B1: "2025-01-01", B2: "2025-06-01", B3: "2026-01-01" };
    expect(errorOf("=XNPV(0.1, A1:A3, B1:B2)", cells)).toBe("#NUM!");
    expect(errorOf("=XNPV(0.1, A1:A3, B1:B3)", { ...cells, B3: "2024-12-31" })).toBe("#NUM!");
    expect(errorOf("=XNPV(0.1, A1:A3, B1:B3)", { ...cells, B2: "soon" })).toBe("#VALUE!");
    expect(errorOf("=XNPV(0.1, A1:A3, B1:B3)", { A1: -100, A2: 60, B1: "2025-01-01" })).toBe(
      "#VALUE!",
    );
  });

  it("answers #DIV/0! where a spreadsheet does", () => {
    expect(errorOf("=NPV(-1, 100, 200)")).toBe("#DIV/0!");
    expect(errorOf("=SLN(1000, 100, 0)")).toBe("#DIV/0!");
    expect(errorOf("=MIRR(A1:A3, 0.1, 0.1)", { A1: 100, A2: 200, A3: 300 })).toBe("#DIV/0!");
  });

  it("answers #VALUE! on a wrong number of arguments or on text", () => {
    expect(errorOf("=PMT(0.05, 10)")).toBe("#VALUE!");
    expect(errorOf("=PMT(0.05, 10, 1000, 0, 0, 1)")).toBe("#VALUE!");
    expect(errorOf('=PMT("five", 10, 1000)')).toBe("#VALUE!");
    expect(errorOf("=NPV(0.1)")).toBe("#VALUE!");
    expect(errorOf("=IRR()")).toBe("#VALUE!");
    expect(errorOf("=XIRR(A1:A2)", { A1: -1, A2: 2 })).toBe("#VALUE!");
  });

  it("passes on an error inside its arguments", () => {
    expect(errorOf("=PMT(1/0, 10, 1000)")).toBe("#DIV/0!");
    expect(errorOf("=NPV(0.1, A1:A3)", { A1: -100, A2: "=1/0", A3: 50 })).toBe("#DIV/0!");
    expect(errorOf("=IRR(A1:A3)", { A1: -100, A2: "=NOPE()", A3: 50 })).toBe("#NAME?");
    expect(errorOf("=PMT(0.05, 10, Missing!A1)")).toBe("#REF!");
  });

  it("takes an omitted argument as its default", () => {
    near(number("=PMT(0.08/12, 10, 10000, , 1)"), -1030.1643271779657);
    near(number("=FV(0.06/12, 10, -200, , 1)"), 2055.8333080397824);
    near(number("=PMT(0.08/12, 10, 10000,)"), -1037.0320893591522);
    expect(number("=SUM(1, , 2)")).toBe(3);
    expect(number("=IF(FALSE, 1, )")).toBe(0);
  });

  it("IFERROR catches a solver that finds nothing", () => {
    expect(number('=IFERROR(IRR(A1:A2), -1)', { A1: 1, A2: 2 })).toBe(-1);
  });

  it("follows the cells it reads, so a change upstream recomputes", () => {
    const at = evaluated({ A1: 0.06, A2: "=A1/12", A3: 360, A4: 250000, B1: "=PMT(A2, A3, A4)" });
    near(at("B1") as number, -1498.8763132010584);
    expect(at.evaluation.errors).toEqual([]);
  });

  it("is in the closed function list, so an imported workbook recomputes", () => {
    for (const name of FINANCIAL_FUNCTIONS) expect(isFormulaSupported(`=${name}(A1:A9)`)).toBe(true);
    expect(isFormulaSupported("=YIELD(A1:A9)")).toBe(false);
  });

  it("charges every solver pass to the step budget and stops when it runs out", () => {
    let spent = 0;
    const cells = Array.from({ length: 1000 }, (_, offset) => ({
      offset,
      value: offset === 0 ? -1000 : 2,
    }));
    const result = evaluateFinancial("IRR", [{ kind: "range", size: 1000, cells }], (count) => {
      spent += count;
      return true;
    });
    expect(typeof result).toBe("number");
    // 1,000 flows per pass, and at most 222 passes.
    expect(spent % 1000).toBe(0);
    expect(spent).toBeGreaterThanOrEqual(2000);
    expect(spent).toBeLessThanOrEqual(222_000);
    let allowance = 3;
    expect(
      evaluateFinancial("IRR", [{ kind: "range", size: 1000, cells }], () => {
        allowance -= 1;
        return allowance >= 0;
      }),
    ).toEqual({ error: "#LIMIT!" });
  });

  it("never runs past its pass limit on flows with no settled answer", () => {
    let passes = 0;
    // An enormous swing: whatever the solver does, it must stop.
    const cells = [-1e300, 1e300, -1e300, 1e300].map((value, offset) => ({ offset, value }));
    evaluateFinancial("IRR", [{ kind: "range", size: 4, cells }], () => {
      passes += 1;
      return true;
    });
    expect(passes).toBeLessThanOrEqual(224);
  });

  it("stops the whole sheet with #LIMIT! when cash flows are too many for the budget", () => {
    const cells: Record<string, SheetCellInput> = {};
    for (let row = 1; row <= 40000; row += 1) cells[`A${row}`] = row === 1 ? -1e9 : 1;
    // Each IRR walks the 40,000 flows at least twice: 130 of them cannot fit the budget.
    for (let row = 1; row <= 130; row += 1) cells[`B${row}`] = "=IRR(A1:A40000)";
    expect(SHEET_LIMITS.steps).toBeLessThan(130 * 2 * 40000);
    const at = evaluated(cells);
    expect(at.evaluation.limitReached).toBe(true);
    const answers = Array.from({ length: 130 }, (_, index) => at(`B${index + 1}`));
    expect(
      answers.some((value) => isSheetError(value) && value.error === "#LIMIT!"),
    ).toBe(true);
    expect(answers.every((value) => typeof value === "number" || isSheetError(value))).toBe(true);
  });
});
