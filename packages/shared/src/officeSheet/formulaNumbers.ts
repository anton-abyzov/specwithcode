/**
 * Number rules of the Sheet formula interpreter that a spreadsheet applies to
 * decimal digits rather than to binary floats: rounding, equality and the text
 * a number turns into. Pure.
 */

/** A spreadsheet holds 15 significant digits. */
const DIGITS = 15;

/** The number as a spreadsheet holds it: float noise past 15 digits removed. */
export function settled(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(DIGITS)) : value;
}

/** Which is larger, as a spreadsheet compares numbers: 0.1 + 0.2 equals 0.3. */
export function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  return settled(a) - settled(b);
}

/** The text a number joins as: 3.3, not 3.3000000000000003. */
export function numberText(value: number): string {
  return String(settled(value));
}

/**
 * Round to `digits` decimal places on the number's own decimal digits, with no
 * float scaling, so a large or long number never gains or loses a unit.
 * "half" rounds half away from zero, "up" away from zero, "down" toward zero.
 * Negative `digits` round to tens, hundreds and so on.
 */
export function roundDecimal(value: number, digits: number, mode: "half" | "up" | "down"): number {
  const magnitude = Math.abs(value);
  if (magnitude === 0 || !Number.isFinite(value) || !Number.isFinite(digits)) return value;
  // The power of ten of the last digit kept.
  const target = -Math.trunc(digits);
  const [mantissa = "0", exponentText = "0"] = magnitude.toExponential().split("e");
  const exponent = Number(exponentText);
  const all = mantissa.replace(".", "");
  // The shortest digits that give this number back; the last one is never zero.
  if (target <= exponent - (all.length - 1)) return value;
  const keep = exponent - target + 1;
  let kept = keep > 0 ? BigInt(all.slice(0, keep)) : 0n;
  const next = keep >= 0 ? (all[keep] ?? "0") : "0";
  if (mode === "up" || (mode === "half" && next >= "5")) kept += 1n;
  const rounded = Number(`${kept.toString()}e${target}`);
  return value < 0 ? -rounded : rounded;
}
