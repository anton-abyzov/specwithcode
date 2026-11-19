import { type SheetValue, isSheetError } from "./formula.ts";
import type { SheetNumberFormat } from "./model.ts";

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat("en-US", options);
    formatters.set(key, found);
  }
  return found;
}

function clampDecimals(decimals: number | undefined, fallback: number): number {
  return decimals === undefined ? fallback : Math.max(0, Math.min(10, decimals));
}

/** A number as text under a format; negative amounts can use accounting parentheses. */
export function formatSheetNumber(value: number, format: SheetNumberFormat | undefined): string {
  if (!format || format.kind === "text") {
    // General: up to 10 significant decimals, no trailing zeros.
    return formatter("general", { maximumFractionDigits: 10, useGrouping: false }).format(value);
  }
  const parens = format.negative === "parens" && value < 0;
  const magnitude = parens ? Math.abs(value) : value;
  let text: string;
  if (format.kind === "percent") {
    const decimals = clampDecimals(format.decimals, 0);
    text = formatter(`percent:${decimals}`, {
      style: "percent",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(magnitude);
  } else if (format.kind === "currency") {
    const decimals = clampDecimals(format.decimals, 2);
    const currency = format.currency ?? "USD";
    const grouping = format.thousands !== false;
    try {
      text = formatter(`currency:${currency}:${decimals}:${grouping}`, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: grouping,
      }).format(magnitude);
    } catch {
      text = `${currency} ${magnitude.toFixed(decimals)}`;
    }
  } else {
    const decimals = clampDecimals(format.decimals, 0);
    const grouping = format.thousands !== false;
    text = formatter(`number:${decimals}:${grouping}`, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    }).format(magnitude);
  }
  return parens ? `(${text})` : text;
}

/** What a cell shows: formatted numbers, TRUE/FALSE, error codes, text as is. */
export function formatSheetValue(value: SheetValue, format: SheetNumberFormat | undefined): string {
  if (value === null) return "";
  if (isSheetError(value)) return value.error;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatSheetNumber(value, format);
  return value;
}
