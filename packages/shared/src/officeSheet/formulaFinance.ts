/**
 * Financial functions of the Sheet formula interpreter: loans, annuities, net
 * present value and rates of return. Pure arithmetic with no I/O and no clock.
 * The two solvers stop after a fixed number of passes, and every pass over a
 * list of cash flows is charged to the caller's step budget.
 */
import type { SheetError, SheetValue } from "./formulaParser.ts";

export const FINANCIAL_FUNCTIONS = [
  "PMT",
  "IPMT",
  "PPMT",
  "PV",
  "FV",
  "NPER",
  "RATE",
  "NPV",
  "IRR",
  "MIRR",
  "XNPV",
  "XIRR",
  "CUMIPMT",
  "CUMPRINC",
  "SLN",
  "EFFECT",
  "NOMINAL",
] as const;

export type FinancialFunction = (typeof FINANCIAL_FUNCTIONS)[number];

export const FINANCIAL_FUNCTION_SET: ReadonlySet<string> = new Set(FINANCIAL_FUNCTIONS);

/** One argument as the interpreter hands it over. */
export type FinancialArgument =
  | { readonly kind: "value"; readonly value: SheetValue }
  | {
      readonly kind: "range";
      /** How many cells the range spans, filled or not. */
      readonly size: number;
      /** The filled cells in reading order; `offset` counts cells from the first. */
      readonly cells: ReadonlyArray<{ readonly offset: number; readonly value: SheetValue }>;
    };

/** Charges `count` steps; false when the budget ran out. */
export type SpendSteps = (count: number) => boolean;

const VALUE: SheetError = { error: "#VALUE!" };
const NUM: SheetError = { error: "#NUM!" };
const DIV: SheetError = { error: "#DIV/0!" };
const LIMIT: SheetError = { error: "#LIMIT!" };

function isError(value: unknown): value is SheetError {
  return typeof value === "object" && value !== null && "error" in value;
}

function coerceNumber(value: SheetValue): number | SheetError {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : VALUE;
}

/** A single number: the value itself, or the first cell of a range. */
function scalar(argument: FinancialArgument | undefined, fallback?: number): number | SheetError {
  if (argument === undefined) return fallback ?? VALUE;
  if (argument.kind === "value") {
    return argument.value === null && fallback !== undefined
      ? fallback
      : coerceNumber(argument.value);
  }
  const first = argument.cells[0];
  if (first === undefined || first.offset !== 0) return fallback ?? 0;
  return coerceNumber(first.value);
}

/** Payments at the start of a period (1) or at its end (0). */
function timing(argument: FinancialArgument | undefined): 0 | 1 | SheetError {
  const value = scalar(argument, 0);
  if (isError(value)) return value;
  return value === 0 ? 0 : 1;
}

/**
 * The numbers an argument stands for, in order. As in a spreadsheet, text,
 * booleans and empty cells inside a range are skipped; a typed value is coerced.
 */
function flows(argument: FinancialArgument, into: number[]): SheetError | null {
  if (argument.kind === "value") {
    if (argument.value === null) return null;
    const number = coerceNumber(argument.value);
    if (isError(number)) return number;
    into.push(number);
    return null;
  }
  for (const cell of argument.cells) {
    if (isError(cell.value)) return cell.value;
    if (typeof cell.value === "number") into.push(cell.value);
  }
  return null;
}

function finite(value: number): number | SheetError {
  return Number.isFinite(value) ? value : NUM;
}

// ------------------------------------------------------------ annuities

/** (1 + rate)^periods, the growth of one unit over the term. */
function growth(rate: number, periods: number): number {
  return rate > -1 ? Math.exp(periods * Math.log1p(rate)) : (1 + rate) ** periods;
}

/** (1 + rate)^periods - 1, exact also for a rate so small that 1 + rate is 1. */
function gain(rate: number, periods: number): number {
  return rate > -1 ? Math.expm1(periods * Math.log1p(rate)) : (1 + rate) ** periods - 1;
}

export function futureValue(
  rate: number,
  periods: number,
  payment: number,
  present: number,
  type: 0 | 1,
): number {
  if (rate === 0) return -(present + payment * periods);
  const q = growth(rate, periods);
  return -(present * q + (payment * (1 + rate * type) * gain(rate, periods)) / rate);
}

export function presentValue(
  rate: number,
  periods: number,
  payment: number,
  future: number,
  type: 0 | 1,
): number {
  if (rate === 0) return -(future + payment * periods);
  const q = growth(rate, periods);
  return -(future + (payment * (1 + rate * type) * gain(rate, periods)) / rate) / q;
}

export function payment(
  rate: number,
  periods: number,
  present: number,
  future: number,
  type: 0 | 1,
): number {
  if (rate === 0) return -(present + future) / periods;
  const q = growth(rate, periods);
  return (-rate * (present * q + future)) / ((1 + rate * type) * gain(rate, periods));
}

/** The interest part of payment number `period` (1-based). */
export function interestPayment(
  rate: number,
  period: number,
  periods: number,
  present: number,
  future: number,
  type: 0 | 1,
): number {
  const each = payment(rate, periods, present, future, type);
  if (period === 1) return type === 1 ? 0 : -present * rate;
  // The balance the interest is charged on, as a negative future value.
  return type === 1
    ? (futureValue(rate, period - 2, each, present, 1) - each) * rate
    : futureValue(rate, period - 1, each, present, 0) * rate;
}

/** What is still owed right after payment number `count`. */
function balanceAfter(
  rate: number,
  count: number,
  each: number,
  present: number,
  type: 0 | 1,
): number {
  if (count === 0) return present;
  return type === 1
    ? -futureValue(rate, count - 1, each, present, 1) + each
    : -futureValue(rate, count, each, present, 0);
}

// ---------------------------------------------------------- cash flows

export function netPresentValue(rate: number, values: ReadonlyArray<number>): number {
  let total = 0;
  let factor = 1;
  for (const value of values) {
    factor *= 1 + rate;
    total += value / factor;
  }
  return total;
}

/** Excel serial day of a date: a number, or ISO `YYYY-MM-DD` text. */
export function dateSerial(value: SheetValue): number | SheetError {
  if (isError(value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : VALUE;
  if (typeof value !== "string") return VALUE;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/.exec(text);
  if (!iso) {
    const parsed = text.length > 0 ? Number(text) : Number.NaN;
    return Number.isFinite(parsed) ? Math.floor(parsed) : VALUE;
  }
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]!) return VALUE;
  // Days from the civil date, without a Date object (Howard Hinnant's algorithm).
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const unixDays = era * 146097 + dayOfEra - 719468;
  // Serial 25569 is 1970-01-01 in the 1900 date system.
  return unixDays + 25569;
}

interface DatedFlows {
  readonly values: number[];
  /** Years from the first date, one per value. */
  readonly years: number[];
}

/** Pair each cash flow with its date. The first date is the base. */
function datedFlows(
  valuesArgument: FinancialArgument,
  datesArgument: FinancialArgument,
): DatedFlows | SheetError {
  const pairs: Array<{ value: SheetValue; date: SheetValue }> = [];
  let firstDate: SheetValue = null;
  if (valuesArgument.kind === "range" && datesArgument.kind === "range") {
    if (valuesArgument.size !== datesArgument.size) return NUM;
    const dates = new Map(datesArgument.cells.map((cell) => [cell.offset, cell.value]));
    firstDate = dates.get(0) ?? null;
    for (const cell of valuesArgument.cells) {
      pairs.push({ value: cell.value, date: dates.get(cell.offset) ?? null });
    }
  } else if (valuesArgument.kind === "value" && datesArgument.kind === "value") {
    firstDate = datesArgument.value;
    pairs.push({ value: valuesArgument.value, date: datesArgument.value });
  } else {
    return NUM;
  }
  const base = dateSerial(firstDate);
  if (isError(base)) return base;
  const values: number[] = [];
  const years: number[] = [];
  for (const pair of pairs) {
    if (isError(pair.value)) return pair.value;
    if (pair.value === null) continue;
    if (typeof pair.value !== "number") return VALUE;
    if (pair.date === null) return VALUE;
    const serial = dateSerial(pair.date);
    if (isError(serial)) return serial;
    if (serial < base) return NUM;
    values.push(pair.value);
    years.push((serial - base) / 365);
  }
  return { values, years };
}

function datedPresentValue(rate: number, dated: DatedFlows): number {
  let total = 0;
  for (let index = 0; index < dated.values.length; index += 1) {
    total += dated.values[index]! / (1 + rate) ** dated.years[index]!;
  }
  return total;
}

// -------------------------------------------------------------- solver

const NEWTON_PASSES = 50;
const BISECTION_PASSES = 100;
/** Rates the bracket search tries, from just above -100% upward. */
const BRACKET_RATES = [
  -0.999999, -0.99, -0.9, -0.75, -0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75,
  1, 2, 5, 10, 100, 1000,
];

/**
 * The rate above -100% where `at(rate)` is zero: Newton's method from `guess`,
 * then bisection on the bracket nearest the guess. A rate counts as a root only
 * when `at` changes sign across it, so a balance that merely fades toward zero
 * at a huge rate, or at -100%, is #NUM! and not an answer. `scale` is the size
 * of the amounts, so the test for zero is relative. `charge` pays for one
 * evaluation; a refused charge ends the search with #LIMIT!. At most
 * 50 * 2 + 2 + 22 + 100 evaluations.
 */
function solveRate(
  at: (rate: number) => number,
  guess: number,
  scale: number,
  charge: () => boolean,
): number | SheetError {
  if (!(scale > 0) || !Number.isFinite(scale)) return NUM;
  const tolerance = 1e-10 * scale;
  const settled = (rate: number, value: number): boolean =>
    Number.isFinite(rate) && rate > -1 && Math.abs(value) <= tolerance;
  /** True when `at` crosses zero within a hair of `rate`. */
  const crosses = (rate: number): boolean | SheetError => {
    const reach = Math.max(1e-9, Math.abs(rate) * 1e-7);
    if (!(rate - reach > -1)) return false;
    if (!charge()) return LIMIT;
    const below = at(rate - reach);
    if (!charge()) return LIMIT;
    const above = at(rate + reach);
    if (!Number.isFinite(below) || !Number.isFinite(above)) return false;
    return below === 0 || above === 0 || below < 0 !== above < 0;
  };
  let rate = guess > -1 && Number.isFinite(guess) ? guess : 0.1;
  let found: number | null = null;
  for (let pass = 0; pass < NEWTON_PASSES; pass += 1) {
    if (!charge()) return LIMIT;
    const value = at(rate);
    if (!Number.isFinite(value)) break;
    if (settled(rate, value)) {
      found = rate;
      break;
    }
    const step = Math.max(1e-7, Math.abs(rate) * 1e-7);
    if (!charge()) return LIMIT;
    const slope = (at(rate + step) - value) / step;
    if (!Number.isFinite(slope) || slope === 0) break;
    let next = rate - value / slope;
    // Never step to or past -100%: go halfway there instead.
    if (!(next > -1)) next = (rate - 1) / 2;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) <= 1e-13 * Math.max(1, Math.abs(rate))) {
      // The step is below what a number can hold.
      found = next;
      break;
    }
    rate = next;
  }
  if (found !== null) {
    const real = crosses(found);
    if (real === true) return found;
    if (real !== false) return real;
  }
  // Bisection: the sign change nearest the guess.
  let bracket: { low: number; high: number; lowValue: number } | null = null;
  let previous: { rate: number; value: number } | null = null;
  for (const candidate of BRACKET_RATES) {
    if (!charge()) return LIMIT;
    const value = at(candidate);
    if (!Number.isFinite(value)) {
      previous = null;
      continue;
    }
    if (value === 0) return candidate;
    if (previous !== null && previous.value < 0 !== value < 0) {
      const closer =
        bracket === null ||
        Math.abs((previous.rate + candidate) / 2 - guess) <
          Math.abs((bracket.low + bracket.high) / 2 - guess);
      if (closer) bracket = { low: previous.rate, high: candidate, lowValue: previous.value };
    }
    previous = { rate: candidate, value };
  }
  if (bracket === null) return NUM;
  let { low, high, lowValue } = bracket;
  for (let pass = 0; pass < BISECTION_PASSES; pass += 1) {
    const middle = (low + high) / 2;
    if (!charge()) return LIMIT;
    const value = at(middle);
    if (!Number.isFinite(value)) return NUM;
    if (settled(middle, value) || high - low <= 1e-14 * Math.max(1, Math.abs(middle))) {
      return middle;
    }
    if (value < 0 === lowValue < 0) {
      low = middle;
      lowValue = value;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

// ------------------------------------------------------------ dispatch

/**
 * Evaluate one financial function. `args` are already evaluated; `spend`
 * charges the interpreter's step budget. Never throws.
 */
export function evaluateFinancial(
  name: string,
  args: ReadonlyArray<FinancialArgument>,
  spend: SpendSteps,
): SheetValue {
  const count = args.length;
  const numbers = (from: number, to: number): number[] | SheetError => {
    const out: number[] = [];
    for (let index = from; index < to; index += 1) {
      const value = scalar(args[index]);
      if (isError(value)) return value;
      out.push(value);
    }
    return out;
  };
  switch (name) {
    case "PMT":
    case "PV":
    case "FV": {
      if (count < 3 || count > 5) return VALUE;
      const head = numbers(0, 3);
      if (isError(head)) return head;
      const last = scalar(args[3], 0);
      if (isError(last)) return last;
      const type = timing(args[4]);
      if (isError(type)) return type;
      const [rate, periods, third] = head as [number, number, number];
      if (rate <= -1) return NUM;
      if (name === "PMT") {
        if (periods === 0) return NUM;
        return finite(payment(rate, periods, third, last, type));
      }
      return finite(
        name === "PV"
          ? presentValue(rate, periods, third, last, type)
          : futureValue(rate, periods, third, last, type),
      );
    }
    case "IPMT":
    case "PPMT": {
      if (count < 4 || count > 6) return VALUE;
      const head = numbers(0, 4);
      if (isError(head)) return head;
      const future = scalar(args[4], 0);
      if (isError(future)) return future;
      const type = timing(args[5]);
      if (isError(type)) return type;
      const [rate, period, periods, present] = head as [number, number, number, number];
      if (rate <= -1 || periods <= 0 || period < 1 || period > periods) return NUM;
      const interest = interestPayment(rate, period, periods, present, future, type);
      return finite(
        name === "IPMT" ? interest : payment(rate, periods, present, future, type) - interest,
      );
    }
    case "NPER": {
      if (count < 3 || count > 5) return VALUE;
      const head = numbers(0, 3);
      if (isError(head)) return head;
      const future = scalar(args[3], 0);
      if (isError(future)) return future;
      const type = timing(args[4]);
      if (isError(type)) return type;
      const [rate, each, present] = head as [number, number, number];
      if (rate <= -1) return NUM;
      if (rate === 0) return each === 0 ? NUM : finite(-(present + future) / each);
      const level = (each * (1 + rate * type)) / rate;
      // ratio - 1, kept apart so a tiny rate does not round the ratio to 1.
      const excess = -(future + present) / (level + present);
      if (!(excess > -1) || !Number.isFinite(excess)) return NUM;
      return finite(Math.log1p(excess) / Math.log1p(rate));
    }
    case "RATE": {
      if (count < 3 || count > 6) return VALUE;
      const head = numbers(0, 3);
      if (isError(head)) return head;
      const future = scalar(args[3], 0);
      if (isError(future)) return future;
      const type = timing(args[4]);
      if (isError(type)) return type;
      const guess = scalar(args[5], 0.1);
      if (isError(guess)) return guess;
      const [periods, each, present] = head as [number, number, number];
      if (periods <= 0) return NUM;
      // The balance left at the end of the term; the rate makes it zero.
      const balance = (rate: number): number => -futureValue(rate, periods, each, present, type) + future;
      const scale = Math.abs(present) + Math.abs(future) + Math.abs(each * periods);
      return solveRate(balance, guess, scale, () => spend(1));
    }
    case "NPV": {
      if (count < 2) return VALUE;
      const rate = scalar(args[0]);
      if (isError(rate)) return rate;
      const values: number[] = [];
      for (let index = 1; index < count; index += 1) {
        const problem = flows(args[index]!, values);
        if (problem) return problem;
      }
      if (rate === -1) return DIV;
      if (!spend(values.length)) return LIMIT;
      return finite(netPresentValue(rate, values));
    }
    case "IRR": {
      if (count < 1 || count > 2) return VALUE;
      const values: number[] = [];
      const problem = flows(args[0]!, values);
      if (problem) return problem;
      const guess = scalar(args[1], 0.1);
      if (isError(guess)) return guess;
      if (!values.some((value) => value > 0) || !values.some((value) => value < 0)) return NUM;
      // Value at the first flow's date: the first flow is not discounted.
      const worth = (rate: number): number => netPresentValue(rate, values) * (1 + rate);
      const scale = values.reduce((total, value) => total + Math.abs(value), 0);
      return solveRate(worth, guess, scale, () => spend(values.length));
    }
    case "MIRR": {
      if (count !== 3) return VALUE;
      const values: number[] = [];
      const problem = flows(args[0]!, values);
      if (problem) return problem;
      const rates = numbers(1, 3);
      if (isError(rates)) return rates;
      const [finance, reinvest] = rates as [number, number];
      const periods = values.length;
      if (periods < 2 || finance === -1 || reinvest === -1) return DIV;
      if (!spend(periods * 2)) return LIMIT;
      const gains = netPresentValue(
        reinvest,
        values.map((value) => Math.max(0, value)),
      );
      const costs = netPresentValue(
        finance,
        values.map((value) => Math.min(0, value)),
      );
      if (gains === 0 || costs === 0) return DIV;
      const ratio = (-gains * growth(reinvest, periods)) / (costs * (1 + finance));
      if (!(ratio > 0)) return NUM;
      return finite(ratio ** (1 / (periods - 1)) - 1);
    }
    case "XNPV": {
      if (count !== 3) return VALUE;
      const rate = scalar(args[0]);
      if (isError(rate)) return rate;
      const dated = datedFlows(args[1]!, args[2]!);
      if (isError(dated)) return dated;
      if (rate <= -1 || dated.values.length === 0) return NUM;
      if (!spend(dated.values.length)) return LIMIT;
      return finite(datedPresentValue(rate, dated));
    }
    case "XIRR": {
      if (count < 2 || count > 3) return VALUE;
      const dated = datedFlows(args[0]!, args[1]!);
      if (isError(dated)) return dated;
      const guess = scalar(args[2], 0.1);
      if (isError(guess)) return guess;
      const { values } = dated;
      if (!values.some((value) => value > 0) || !values.some((value) => value < 0)) return NUM;
      const scale = values.reduce((total, value) => total + Math.abs(value), 0);
      return solveRate(
        (rate) => datedPresentValue(rate, dated),
        guess,
        scale,
        () => spend(values.length),
      );
    }
    case "CUMIPMT":
    case "CUMPRINC": {
      if (count !== 6) return VALUE;
      const all = numbers(0, 6);
      if (isError(all)) return all;
      const [rate, periods, present, startRaw, endRaw, typeRaw] = all as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const start = Math.trunc(startRaw);
      const end = Math.trunc(endRaw);
      if (rate <= 0 || periods <= 0 || present <= 0) return NUM;
      if (start < 1 || end < start || end > periods) return NUM;
      if (typeRaw !== 0 && typeRaw !== 1) return NUM;
      const each = payment(rate, periods, present, 0, typeRaw);
      // Principal repaid is the fall in the balance; the rest of the payments is interest.
      const principal =
        balanceAfter(rate, end, each, present, typeRaw) -
        balanceAfter(rate, start - 1, each, present, typeRaw);
      return finite(name === "CUMPRINC" ? principal : each * (end - start + 1) - principal);
    }
    case "SLN": {
      if (count !== 3) return VALUE;
      const all = numbers(0, 3);
      if (isError(all)) return all;
      const [cost, salvage, life] = all as [number, number, number];
      return life === 0 ? DIV : finite((cost - salvage) / life);
    }
    case "EFFECT":
    case "NOMINAL": {
      if (count !== 2) return VALUE;
      const all = numbers(0, 2);
      if (isError(all)) return all;
      const [rate, perYearRaw] = all as [number, number];
      const perYear = Math.trunc(perYearRaw);
      if (rate <= 0 || perYear < 1) return NUM;
      return finite(
        name === "EFFECT"
          ? Math.expm1(perYear * Math.log1p(rate / perYear))
          : Math.expm1(Math.log1p(rate) / perYear) * perYear,
      );
    }
    default:
      return { error: "#NAME?" };
  }
}
