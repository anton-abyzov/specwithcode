import { describe, expect, it } from "vite-plus/test";

import { formatSheetNumber, formatSheetValue } from "./format.ts";

describe("sheet number formats", () => {
  it("renders currency, percent, separators and fixed decimals", () => {
    expect(formatSheetNumber(1234567.891, { kind: "currency", currency: "USD" })).toBe(
      "$1,234,567.89",
    );
    expect(formatSheetNumber(1234567.891, { kind: "currency", currency: "USD", decimals: 0 })).toBe(
      "$1,234,568",
    );
    expect(formatSheetNumber(0.1234, { kind: "percent", decimals: 1 })).toBe("12.3%");
    expect(formatSheetNumber(0.5, { kind: "percent" })).toBe("50%");
    expect(formatSheetNumber(1234567.5, { kind: "number" })).toBe("1,234,568");
    expect(formatSheetNumber(1234.5, { kind: "number", decimals: 2 })).toBe("1,234.50");
    expect(formatSheetNumber(1234.5, { kind: "number", decimals: 2, thousands: false })).toBe(
      "1234.50",
    );
  });

  it("writes negative amounts in parentheses when asked", () => {
    expect(
      formatSheetNumber(-48000, {
        kind: "currency",
        currency: "USD",
        decimals: 0,
        negative: "parens",
      }),
    ).toBe("($48,000)");
    expect(formatSheetNumber(-48000, { kind: "number", negative: "parens" })).toBe("(48,000)");
    expect(formatSheetNumber(-48000, { kind: "number" })).toBe("-48,000");
    expect(formatSheetNumber(48000, { kind: "number", negative: "parens" })).toBe("48,000");
  });

  it("shows general numbers, booleans, errors and empty cells", () => {
    expect(formatSheetValue(0.1 + 0.2, undefined)).toBe("0.3");
    expect(formatSheetValue(1234567, undefined)).toBe("1234567");
    expect(formatSheetValue(true, undefined)).toBe("TRUE");
    expect(formatSheetValue({ error: "#DIV/0!" }, { kind: "currency" })).toBe("#DIV/0!");
    expect(formatSheetValue(null, undefined)).toBe("");
    expect(formatSheetValue("Revenue", { kind: "currency" })).toBe("Revenue");
  });
});
