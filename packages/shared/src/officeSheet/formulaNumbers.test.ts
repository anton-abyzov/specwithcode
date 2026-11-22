import { describe, expect, it } from "vite-plus/test";

import { evaluateSheet, isSheetError } from "./formula.ts";
import { compareNumbers, numberText, roundDecimal } from "./formulaNumbers.ts";
import { type SheetCellInput, parseCellAddress, validateSheetDocument } from "./model.ts";

function evaluated(cells: Record<string, SheetCellInput>) {
  const result = validateSheetDocument({ title: "Test", tabs: [{ name: "Main", cells }] });
  if (!result.ok) throw new Error(result.error);
  const evaluation = evaluateSheet(result.document);
  return Object.assign((cell: string) => evaluation.valueAt(0, parseCellAddress(cell)!), {
    evaluation,
  });
}

function one(formula: string, cells: Record<string, SheetCellInput> = {}) {
  const value = evaluated({ ...cells, Z1: formula })("Z1");
  return isSheetError(value) ? value.error : value;
}

describe("decimal rounding", () => {
  it("rounds on decimal digits, so a large or long number keeps its last unit", () => {
    expect(roundDecimal(1_000_000_000_000, 0, "down")).toBe(1_000_000_000_000);
    expect(roundDecimal(5e12, 0, "down")).toBe(5e12);
    expect(roundDecimal(123456789.123, 4, "down")).toBe(123456789.123);
    expect(roundDecimal(10000000000.555, 2, "down")).toBe(10000000000.55);
    expect(roundDecimal(1234.5678, 9, "up")).toBe(1234.5678);
    expect(roundDecimal(1e300, 15, "up")).toBe(1e300);
  });

  it("rounds up away from zero and down toward it", () => {
    expect(roundDecimal(2.11, 1, "up")).toBe(2.2);
    expect(roundDecimal(2.99, 1, "down")).toBe(2.9);
    expect(roundDecimal(-2.11, 1, "up")).toBe(-2.2);
    expect(roundDecimal(-2.99, 0, "down")).toBe(-2);
    expect(roundDecimal(2, 0, "up")).toBe(2);
    expect(roundDecimal(0.001, 2, "up")).toBe(0.01);
    expect(roundDecimal(0.001, 2, "down")).toBe(0);
  });

  it("rounds to tens and hundreds with negative digits", () => {
    expect(roundDecimal(4, -2, "up")).toBe(100);
    expect(roundDecimal(149, -2, "down")).toBe(100);
    expect(roundDecimal(150, -2, "half")).toBe(200);
    expect(roundDecimal(60, -2, "half")).toBe(100);
    expect(roundDecimal(4, -2, "half")).toBe(0);
  });

  it("rounds half away from zero on the decimal the number shows", () => {
    expect(roundDecimal(2.5, 0, "half")).toBe(3);
    expect(roundDecimal(-2.5, 0, "half")).toBe(-3);
    expect(roundDecimal(1.005, 2, "half")).toBe(1.01);
    expect(roundDecimal(0, 2, "up")).toBe(0);
  });

  it("is what ROUND, ROUNDUP and ROUNDDOWN answer", () => {
    expect(one("=ROUNDDOWN(1000000000000, 0)")).toBe(1_000_000_000_000);
    expect(one("=ROUNDDOWN(123456789.123, 4)")).toBe(123456789.123);
    expect(one("=ROUNDUP(1234.5678, 9)")).toBe(1234.5678);
    expect(one("=ROUNDUP(2.11, 1)")).toBe(2.2);
    expect(one("=ROUND(1.005, 2)")).toBe(1.01);
  });
});

describe("rounding a computed number", () => {
  it("rounds the number the sheet holds, not its float noise", () => {
    expect(one("=ROUNDUP(0.1+0.2,1)")).toBe(0.3);
    expect(one("=ROUNDUP(1.1+2.2,1)")).toBe(3.3);
    expect(one("=ROUNDDOWN(0.3-0.2,1)")).toBe(0.1);
    expect(one("=ROUNDDOWN(0.3-0.1,1)")).toBe(0.2);
    expect(one("=ROUND(1.15-0.1,1)")).toBe(1.1);
    expect(one("=ROUNDUP(0.31,1)")).toBe(0.4);
    expect(one("=ROUNDDOWN(-0.39,1)")).toBe(-0.3);
  });

  it("keeps every digit of a whole number", () => {
    expect(roundDecimal(1000000000000001, 0, "half")).toBe(1000000000000001);
    expect(roundDecimal(1000000000000001, -1, "up")).toBe(1000000000000010);
  });

  it("answers for a unit larger than any number", () => {
    expect(one("=ROUND(1,-1E21)")).toBe(0);
    expect(one("=ROUNDDOWN(5,-400)")).toBe(0);
    expect(one("=ROUNDUP(1,-400)")).toBe("#VALUE!");
  });
});

describe("numbers as a spreadsheet holds them", () => {
  it("keeps two different whole numbers apart, and the largest number comparable", () => {
    expect(compareNumbers(1000000000000001, 1000000000000002)).toBeLessThan(0);
    expect(compareNumbers(Number.MAX_VALUE, 1)).toBeGreaterThan(0);
    expect(Number.isNaN(compareNumbers(Number.MAX_VALUE, Number.MAX_VALUE / 2))).toBe(false);
  });

  it("a lookup takes a number as it is and never a key that is only close", () => {
    // 0.1 + 0.2 is not 0.3 in binary: no row holds the key asked for.
    const drift = { A1: "=0.1+0.2", B1: 17, A2: 1, B2: 42 };
    expect(one("=VLOOKUP(0.3,A1:B2,2,FALSE)", drift)).toBe("#N/A");
    expect(one("=MATCH(0.3,A1:A2,0)", drift)).toBe("#N/A");
    expect(one("=VLOOKUP(0.3,A1:B2,2,TRUE)", drift)).toBe("#N/A");
    expect(one("=MATCH(0.3,A1:A2,1)", drift)).toBe("#N/A");
    expect(one("=VLOOKUP(A1,A1:B2,2,FALSE)", drift)).toBe(17);
    // A key 15 digits away from the one asked for is another key.
    const close = { A1: "=(2.03-2)*1E17", B1: 17 };
    expect(one("=VLOOKUP(2999999999999980,A1:B1,2,FALSE)", close)).toBe("#N/A");
    const shadow = { A1: "=(2.03-2)*1E17", B1: 17, A2: 2999999999999980, B2: 42 };
    expect(one("=VLOOKUP(A2,A1:B2,2,FALSE)", shadow)).toBe(42);
    expect(one("=MATCH(A2,A1:A2,0)", shadow)).toBe(2);
    const sorted = { A1: 2999999999999980, B1: 42, A2: "=(2.03-2)*1E17", B2: 17 };
    expect(one("=VLOOKUP(A1,A1:B2,2,TRUE)", sorted)).toBe(42);
    expect(one("=MATCH(A1,A1:A2,1)", sorted)).toBe(1);
    // The first of two keys that are the same number wins an exact lookup.
    const twice = { A1: "=(1.01-1)*100", B1: 42, A2: 1, B2: 17, A3: 1, B3: 5 };
    expect(one("=VLOOKUP(1,A1:B3,2,FALSE)", twice)).toBe(17);
    // Whole-number ids of 16 digits stay apart.
    const ids = { A1: 4111111111111111, B1: "first", A2: 4111111111111112, B2: "second" };
    expect(one("=VLOOKUP(4111111111111112,A1:B2,2,FALSE)", ids)).toBe("second");
    expect(one("=MATCH(4111111111111111,A1:A2,1)", ids)).toBe(1);
  });

  it("compares on 15 significant digits", () => {
    expect(compareNumbers(0.1 + 0.2, 0.3)).toBe(0);
    expect(compareNumbers(1, 2)).toBeLessThan(0);
    expect(compareNumbers(1e-20, 0)).toBeGreaterThan(0);
    expect(one("=0.1+0.2=0.3")).toBe(true);
    expect(one("=COUNTIF(A1:A2, 0.3)", { A1: "=0.1+0.2", A2: 0.3 })).toBe(2);
  });

  it("joins a number as its 15-digit text", () => {
    expect(numberText(3 * 1.1)).toBe("3.3");
    expect(one('="Total: "&A1*1.1', { A1: 3 })).toBe("Total: 3.3");
    expect(one("=LEN(0.1*3)")).toBe(3);
    expect(one("=CONCAT(1/4, \"-\", 1000000)")).toBe("0.25-1000000");
  });
});

describe("lookups", () => {
  it("an empty key finds nothing, and an empty row is never a match", () => {
    const cells = { A1: "apple", B1: 1, A2: "pear", B2: 2, B4: 99 };
    expect(one("=VLOOKUP(D2, A1:B10, 2, FALSE)", cells)).toBe("#N/A");
    expect(one('=IFNA(VLOOKUP(D2, A1:B10, 2, FALSE), "none")', cells)).toBe("none");
    expect(one("=MATCH(D2, A1:A10, 0)", cells)).toBe("#N/A");
    expect(one('=VLOOKUP("PEAR", A1:B10, 2, FALSE)', cells)).toBe(2);
  });

  it("orders text the same way on every machine", () => {
    // By code unit, "ä" sorts after "b" and "c"; a locale would put it beside "a".
    const cells = { A1: "a", B1: 1, A2: "ä", B2: 2, A3: "c", B3: 3 };
    expect(one('=VLOOKUP("b", A1:B3, 2)', cells)).toBe(1);
    expect(one('=MATCH("b", A1:A3, 1)', cells)).toBe(1);
    expect(one('="ä">"c"')).toBe(true);
  });
});

describe("range walks", () => {
  it("reads a sparse range in reading order whatever the file's key order", () => {
    // Ten cells of range over three filled cells takes the sparse walk.
    expect(one("=CONCAT(A1:A10)", { A1: "a", A3: "c", A2: "b" })).toBe("abc");
    expect(one("=CONCAT(A1:B2)", { B2: "d", A2: "c", B1: "b", A1: "a" })).toBe("abcd");
  });

  it("charges COUNTIFS and SUMIFS for every criterion they test", () => {
    const pairs = Array.from({ length: 100 }, () => 'A1:A100000,""').join(",");
    const at = evaluated({ B1: `=COUNTIFS(${pairs})`, C1: "=1+1" });
    // 100,000 cells by 100 criteria is twice the step budget.
    expect(at("B1")).toEqual({ error: "#LIMIT!" });
    expect(at.evaluation.limitReached).toBe(true);
    // The same formula with one criterion is well inside it.
    expect(one('=COUNTIFS(A1:A100000,"")')).toBe(100000);
  });
});
