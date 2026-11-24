/**
 * The Sheet formula grammar: value types, the closed function list, the tokenizer
 * and the parser. Pure, with no evaluation; `formula.ts` runs what this parses.
 */
import { FINANCIAL_FUNCTIONS } from "./formulaFinance.ts";
import { SHEET_LIMITS, columnIndex } from "./model.ts";

export type SheetErrorCode =
  | "#DIV/0!"
  | "#N/A"
  | "#NAME?"
  | "#REF!"
  | "#VALUE!"
  | "#NUM!"
  | "#CYCLE!"
  | "#ERROR!"
  | "#LIMIT!";

export interface SheetError {
  readonly error: SheetErrorCode;
}

/** A computed cell: null is an empty cell. */
export type SheetValue = number | string | boolean | null | SheetError;

export function isSheetError(value: unknown): value is SheetError {
  return typeof value === "object" && value !== null && "error" in value;
}

export function err(error: SheetErrorCode): SheetError {
  return { error };
}

export const SHEET_FUNCTIONS = [
  "SUM",
  "AVERAGE",
  "MEDIAN",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "COUNTIF",
  "COUNTIFS",
  "SUMIF",
  "SUMIFS",
  "AVERAGEIF",
  "IF",
  "IFERROR",
  "IFNA",
  "AND",
  "OR",
  "NOT",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "ABS",
  "POWER",
  "MOD",
  "CONCAT",
  "LEFT",
  "RIGHT",
  "LEN",
  "LOWER",
  "UPPER",
  "TRIM",
  "INDEX",
  "MATCH",
  "VLOOKUP",
  ...FINANCIAL_FUNCTIONS,
] as const;

const FUNCTION_NAMES: ReadonlySet<string> = new Set(SHEET_FUNCTIONS);

// ---------------------------------------------------------------- tokens

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "name"; readonly v: string }
  | {
      readonly t: "ref";
      readonly tab: string | null;
      readonly col: number;
      readonly row: number;
      /** Where the reference starts in the source, tab prefix included, and ends. */
      readonly start: number;
      readonly end: number;
      readonly colAbsolute: boolean;
      readonly rowAbsolute: boolean;
    }
  | { readonly t: "err"; readonly code: SheetErrorCode }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "(" | ")" | "," | ":" };

class FormulaSyntaxError extends Error {
  readonly code: SheetErrorCode;
  constructor(code: SheetErrorCode) {
    super(code);
    this.code = code;
  }
}

const REF_PATTERN = /^(\$?)([A-Za-z]{1,2})(\$?)([1-9][0-9]{0,5})(?![A-Za-z0-9_])/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*/;
const NUMBER_PATTERN = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const BARE_TAB_PATTERN = /^([A-Za-z_][A-Za-z0-9_. ]*?)!/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let rest = source;
  const position = (): number => source.length - rest.length;
  const readRef = (tab: string | null, start: number): boolean => {
    const match = REF_PATTERN.exec(rest);
    if (!match) return false;
    const col = columnIndex(match[2]!);
    const row = Number(match[4]) - 1;
    if (col >= SHEET_LIMITS.columns || row >= SHEET_LIMITS.rows) {
      throw new FormulaSyntaxError("#REF!");
    }
    rest = rest.slice(match[0].length);
    tokens.push({
      t: "ref",
      tab,
      col,
      row,
      start,
      end: position(),
      colAbsolute: match[1] === "$",
      rowAbsolute: match[3] === "$",
    });
    return true;
  };
  while (rest.length > 0) {
    const char = rest[0]!;
    const at = position();
    if (char === "#" && rest.toUpperCase().startsWith("#REF!")) {
      // What a deleted row, column or tab leaves behind in a formula.
      tokens.push({ t: "err", code: "#REF!" });
      rest = rest.slice(5);
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      rest = rest.slice(1);
      continue;
    }
    if (char === '"') {
      let value = "";
      let index = 1;
      let closed = false;
      while (index < rest.length) {
        if (rest[index] === '"') {
          if (rest[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        value += rest[index];
        index += 1;
      }
      if (!closed) throw new FormulaSyntaxError("#ERROR!");
      tokens.push({ t: "str", v: value });
      rest = rest.slice(index);
      continue;
    }
    if (char === "'") {
      // 'Tab name'!A1
      let name = "";
      let index = 1;
      let closed = false;
      while (index < rest.length) {
        if (rest[index] === "'") {
          if (rest[index + 1] === "'") {
            name += "'";
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        name += rest[index];
        index += 1;
      }
      if (!closed || rest[index] !== "!") throw new FormulaSyntaxError("#ERROR!");
      rest = rest.slice(index + 1);
      if (!readRef(name, at)) throw new FormulaSyntaxError("#REF!");
      continue;
    }
    const number = NUMBER_PATTERN.exec(rest);
    if (number) {
      const parsed = Number(number[0]);
      // 1e999 is not a number a cell can hold.
      if (!Number.isFinite(parsed)) throw new FormulaSyntaxError("#VALUE!");
      tokens.push({ t: "num", v: parsed });
      rest = rest.slice(number[0].length);
      continue;
    }
    const bareTab = BARE_TAB_PATTERN.exec(rest);
    if (bareTab) {
      rest = rest.slice(bareTab[0].length);
      if (!readRef(bareTab[1]!.trim(), at)) throw new FormulaSyntaxError("#REF!");
      continue;
    }
    if (readRef(null, at)) continue;
    const name = NAME_PATTERN.exec(rest);
    if (name) {
      tokens.push({ t: "name", v: name[0].toUpperCase() });
      rest = rest.slice(name[0].length);
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ t: "op", v: two });
      rest = rest.slice(2);
      continue;
    }
    if ("+-*/^&=<>%".includes(char)) {
      tokens.push({ t: "op", v: char });
      rest = rest.slice(1);
      continue;
    }
    if (char === "(" || char === ")" || char === "," || char === ":") {
      tokens.push({ t: char });
      rest = rest.slice(1);
      continue;
    }
    if (char === ";") {
      tokens.push({ t: "," });
      rest = rest.slice(1);
      continue;
    }
    throw new FormulaSyntaxError("#ERROR!");
  }
  return tokens;
}

// ------------------------------------------------------------------ AST

export type FormulaNode =
  | { readonly k: "num"; readonly v: number }
  | { readonly k: "str"; readonly v: string }
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "ref"; readonly tab: string | null; readonly col: number; readonly row: number }
  | {
      readonly k: "range";
      readonly tab: string | null;
      readonly c1: number;
      readonly r1: number;
      readonly c2: number;
      readonly r2: number;
    }
  | { readonly k: "unary"; readonly op: "-" | "+" | "%"; readonly a: FormulaNode }
  | { readonly k: "bin"; readonly op: string; readonly a: FormulaNode; readonly b: FormulaNode }
  | { readonly k: "call"; readonly name: string; readonly args: ReadonlyArray<FormulaNode> }
  /** An argument left out, as in PV(rate, periods, payment, , 1). */
  | { readonly k: "blank" }
  | { readonly k: "err"; readonly code: SheetErrorCode };

class Parser {
  private index = 0;
  private depth = 0;
  private readonly tokens: ReadonlyArray<Token>;
  constructor(tokens: ReadonlyArray<Token>) {
    this.tokens = tokens;
  }

  parse(): FormulaNode {
    const node = this.comparison();
    if (this.index < this.tokens.length) throw new FormulaSyntaxError("#ERROR!");
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isOp(...ops: ReadonlyArray<string>): string | null {
    const token = this.peek();
    return token && token.t === "op" && ops.includes(token.v) ? token.v : null;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > SHEET_LIMITS.formulaDepth) throw new FormulaSyntaxError("#LIMIT!");
  }

  private comparison(): FormulaNode {
    let left = this.concat();
    for (
      let op = this.isOp("=", "<>", "<", ">", "<=", ">=");
      op;
      op = this.isOp("=", "<>", "<", ">", "<=", ">=")
    ) {
      this.index += 1;
      left = { k: "bin", op, a: left, b: this.concat() };
    }
    return left;
  }

  private concat(): FormulaNode {
    let left = this.additive();
    while (this.isOp("&")) {
      this.index += 1;
      left = { k: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }

  private additive(): FormulaNode {
    let left = this.multiplicative();
    for (let op = this.isOp("+", "-"); op; op = this.isOp("+", "-")) {
      this.index += 1;
      left = { k: "bin", op, a: left, b: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): FormulaNode {
    let left = this.power();
    for (let op = this.isOp("*", "/"); op; op = this.isOp("*", "/")) {
      this.index += 1;
      left = { k: "bin", op, a: left, b: this.power() };
    }
    return left;
  }

  private power(): FormulaNode {
    let left = this.unary();
    while (this.isOp("^")) {
      this.index += 1;
      left = { k: "bin", op: "^", a: left, b: this.unary() };
    }
    return left;
  }

  private unary(): FormulaNode {
    const op = this.isOp("-", "+");
    if (op) {
      this.index += 1;
      this.enter();
      const operand = this.unary();
      this.depth -= 1;
      return { k: "unary", op: op as "-" | "+", a: operand };
    }
    return this.postfix();
  }

  private postfix(): FormulaNode {
    let node = this.primary();
    while (this.isOp("%")) {
      this.index += 1;
      node = { k: "unary", op: "%", a: node };
    }
    return node;
  }

  private primary(): FormulaNode {
    const token = this.peek();
    if (!token) throw new FormulaSyntaxError("#ERROR!");
    this.index += 1;
    if (token.t === "num") return { k: "num", v: token.v };
    if (token.t === "str") return { k: "str", v: token.v };
    if (token.t === "err") return { k: "err", code: token.code };
    if (token.t === "(") {
      this.enter();
      const inner = this.comparison();
      this.depth -= 1;
      this.expect(")");
      return inner;
    }
    if (token.t === "ref") {
      const next = this.peek();
      if (next && next.t === ":") {
        this.index += 1;
        const end = this.peek();
        if (!end || end.t !== "ref" || (end.tab !== null && end.tab !== token.tab)) {
          throw new FormulaSyntaxError("#REF!");
        }
        this.index += 1;
        return {
          k: "range",
          tab: token.tab,
          c1: Math.min(token.col, end.col),
          r1: Math.min(token.row, end.row),
          c2: Math.max(token.col, end.col),
          r2: Math.max(token.row, end.row),
        };
      }
      return { k: "ref", tab: token.tab, col: token.col, row: token.row };
    }
    if (token.t === "name") {
      const next = this.peek();
      if (next && next.t === "(") {
        this.index += 1;
        if (!FUNCTION_NAMES.has(token.v)) {
          // Still consume the call so one unknown name does not hide a syntax error.
          this.enter();
          this.argumentList();
          this.depth -= 1;
          return { k: "err", code: "#NAME?" };
        }
        this.enter();
        const args = this.argumentList();
        this.depth -= 1;
        return { k: "call", name: token.v, args };
      }
      if (token.v === "TRUE") return { k: "bool", v: true };
      if (token.v === "FALSE") return { k: "bool", v: false };
      return { k: "err", code: "#NAME?" };
    }
    throw new FormulaSyntaxError("#ERROR!");
  }

  private argumentList(): FormulaNode[] {
    const args: FormulaNode[] = [];
    const first = this.peek();
    if (first && first.t === ")") {
      this.index += 1;
      return args;
    }
    for (;;) {
      const head = this.peek();
      // Nothing between two commas, or before the closing bracket, is an omitted argument.
      args.push(head && (head.t === "," || head.t === ")") ? { k: "blank" } : this.comparison());
      const next = this.peek();
      if (next && next.t === ",") {
        this.index += 1;
        continue;
      }
      this.expect(")");
      return args;
    }
  }

  private expect(kind: ")"): void {
    const token = this.peek();
    if (!token || token.t !== kind) throw new FormulaSyntaxError("#ERROR!");
    this.index += 1;
  }
}

export function parseFormula(source: string): FormulaNode {
  try {
    return new Parser(tokenize(source)).parse();
  } catch (cause) {
    if (cause instanceof FormulaSyntaxError) return { k: "err", code: cause.code };
    return { k: "err", code: "#ERROR!" };
  }
}

/**
 * Returns true when `formula` (with or without leading `=`) parses cleanly
 * within `SHEET_LIMITS.formulaChars` and contains no unsupported function calls
 * or unresolved bare names — even nested inside `IFERROR` or `IFNA`.
 */
export function isFormulaSupported(formula: string): boolean {
  const source = formula.startsWith("=") ? formula.slice(1) : formula;
  if (source.length === 0 || source.length > SHEET_LIMITS.formulaChars) return false;
  let ast: FormulaNode;
  try {
    ast = new Parser(tokenize(source)).parse();
  } catch {
    return false;
  }
  const hasUnsupported = (node: FormulaNode): boolean => {
    switch (node.k) {
      case "err":
        return true;
      case "unary":
        return hasUnsupported(node.a);
      case "bin":
        return hasUnsupported(node.a) || hasUnsupported(node.b);
      case "call":
        return node.args.some(hasUnsupported);
      default:
        return false;
    }
  };
  return !hasUnsupported(ast);
}

/** One cell reference in a formula's source, as written. */
export interface FormulaRefSpan {
  /** Offsets in the source passed in, tab prefix included. */
  readonly start: number;
  readonly end: number;
  readonly tab: string | null;
  readonly col: number;
  readonly row: number;
  readonly colAbsolute: boolean;
  readonly rowAbsolute: boolean;
  /** Set on the first cell of "A1:B2"; the second cell is the next span. */
  readonly rangeStart?: true;
}

/**
 * The cell references in a formula (without its leading "="), by the same
 * tokenizer evaluation uses, or null when the formula does not tokenize.
 */
export function formulaRefSpans(source: string): ReadonlyArray<FormulaRefSpan> | null {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return null;
  }
  const spans: FormulaRefSpan[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.t !== "ref") continue;
    const range = tokens[index + 1]?.t === ":" && tokens[index + 2]?.t === "ref";
    spans.push({
      start: token.start,
      end: token.end,
      tab: token.tab,
      col: token.col,
      row: token.row,
      colAbsolute: token.colAbsolute,
      rowAbsolute: token.rowAbsolute,
      ...(range ? { rangeStart: true as const } : {}),
    });
  }
  return spans;
}
