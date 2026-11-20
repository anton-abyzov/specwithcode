/**
 * The Sheet formula interpreter. It is pure: no I/O, no clock, no `eval`, and a
 * closed list of functions. Cells are evaluated in dependency order without
 * recursion, under a step budget, so evaluation always ends whatever the file
 * holds.
 */
import {
  type CellAddress,
  type SheetCellInput,
  type SheetDocument,
  SHEET_LIMITS,
  cellName,
  columnIndex,
  isFormulaInput,
} from "./model.ts";

export type SheetErrorCode =
  | "#DIV/0!"
  | "#N/A"
  | "#NAME?"
  | "#REF!"
  | "#VALUE!"
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

function err(error: SheetErrorCode): SheetError {
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
] as const;

const FUNCTION_NAMES: ReadonlySet<string> = new Set(SHEET_FUNCTIONS);

// ---------------------------------------------------------------- tokens

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "ref"; readonly tab: string | null; readonly col: number; readonly row: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "(" | ")" | "," | ":" };

class FormulaSyntaxError extends Error {
  readonly code: SheetErrorCode;
  constructor(code: SheetErrorCode) {
    super(code);
    this.code = code;
  }
}

const REF_PATTERN = /^\$?([A-Za-z]{1,2})\$?([1-9][0-9]{0,5})(?![A-Za-z0-9_])/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*/;
const NUMBER_PATTERN = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const BARE_TAB_PATTERN = /^([A-Za-z_][A-Za-z0-9_. ]*?)!/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let rest = source;
  const readRef = (tab: string | null): boolean => {
    const match = REF_PATTERN.exec(rest);
    if (!match) return false;
    const col = columnIndex(match[1]!);
    const row = Number(match[2]) - 1;
    if (col >= SHEET_LIMITS.columns || row >= SHEET_LIMITS.rows) {
      throw new FormulaSyntaxError("#REF!");
    }
    tokens.push({ t: "ref", tab, col, row });
    rest = rest.slice(match[0].length);
    return true;
  };
  while (rest.length > 0) {
    const char = rest[0]!;
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
      if (!readRef(name)) throw new FormulaSyntaxError("#REF!");
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
      if (!readRef(bareTab[1]!.trim())) throw new FormulaSyntaxError("#REF!");
      continue;
    }
    if (readRef(null)) continue;
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

type Node =
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
  | { readonly k: "unary"; readonly op: "-" | "+" | "%"; readonly a: Node }
  | { readonly k: "bin"; readonly op: string; readonly a: Node; readonly b: Node }
  | { readonly k: "call"; readonly name: string; readonly args: ReadonlyArray<Node> }
  | { readonly k: "err"; readonly code: SheetErrorCode };

class Parser {
  private index = 0;
  private depth = 0;
  private readonly tokens: ReadonlyArray<Token>;
  constructor(tokens: ReadonlyArray<Token>) {
    this.tokens = tokens;
  }

  parse(): Node {
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

  private comparison(): Node {
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

  private concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.index += 1;
      left = { k: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (let op = this.isOp("+", "-"); op; op = this.isOp("+", "-")) {
      this.index += 1;
      left = { k: "bin", op, a: left, b: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.power();
    for (let op = this.isOp("*", "/"); op; op = this.isOp("*", "/")) {
      this.index += 1;
      left = { k: "bin", op, a: left, b: this.power() };
    }
    return left;
  }

  private power(): Node {
    let left = this.unary();
    while (this.isOp("^")) {
      this.index += 1;
      left = { k: "bin", op: "^", a: left, b: this.unary() };
    }
    return left;
  }

  private unary(): Node {
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

  private postfix(): Node {
    let node = this.primary();
    while (this.isOp("%")) {
      this.index += 1;
      node = { k: "unary", op: "%", a: node };
    }
    return node;
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new FormulaSyntaxError("#ERROR!");
    this.index += 1;
    if (token.t === "num") return { k: "num", v: token.v };
    if (token.t === "str") return { k: "str", v: token.v };
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

  private argumentList(): Node[] {
    const args: Node[] = [];
    const first = this.peek();
    if (first && first.t === ")") {
      this.index += 1;
      return args;
    }
    for (;;) {
      args.push(this.comparison());
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

function parseFormula(source: string): Node {
  try {
    return new Parser(tokenize(source)).parse();
  } catch (cause) {
    if (cause instanceof FormulaSyntaxError) return { k: "err", code: cause.code };
    return { k: "err", code: "#ERROR!" };
  }
}

// ------------------------------------------------------------ evaluation

export interface SheetEvaluation {
  /** Computed value of a cell by tab index and address. Empty cells are null. */
  readonly valueAt: (tab: number, address: CellAddress) => SheetValue;
  /** Cells that ended in an error, as "Tab!A1". */
  readonly errors: ReadonlyArray<{ readonly cell: string; readonly error: SheetErrorCode }>;
  readonly formulaCount: number;
  /** True when the step budget ran out; the remaining formulas show #LIMIT!. */
  readonly limitReached: boolean;
}

const COLUMN_SPAN = SHEET_LIMITS.columns + 1;

function cellKey(col: number, row: number): number {
  return row * COLUMN_SPAN + col;
}

interface TabState {
  readonly name: string;
  readonly inputs: Map<number, SheetCellInput>;
  readonly values: Map<number, SheetValue>;
  /** Occupied cell keys, for walking a range larger than the tab. */
  readonly occupied: ReadonlyArray<number>;
}

interface FormulaCell {
  readonly tab: number;
  readonly key: number;
  readonly node: Node;
  /** Formula cells this one reads. */
  readonly deps: number[];
  pending: number;
  readonly dependents: number[];
}

function literalValue(input: SheetCellInput): SheetValue {
  return input;
}

function toNumber(value: SheetValue): number | SheetError {
  if (isSheetError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : err("#VALUE!");
}

function toText(value: SheetValue): string | SheetError {
  if (isSheetError(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function toBoolean(value: SheetValue): boolean | SheetError {
  if (isSheetError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return err("#VALUE!");
}

function finite(value: number): SheetValue {
  return Number.isFinite(value) ? value : err("#VALUE!");
}

function compareValues(a: SheetValue, b: SheetValue): number {
  const left = a === null ? (typeof b === "string" ? "" : 0) : a;
  const right = b === null ? (typeof a === "string" ? "" : 0) : b;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left === "string" && typeof right === "string") {
    const x = left.toLowerCase();
    const y = right.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // Mixed kinds order as number < text < boolean, like a spreadsheet.
  const rank = (value: SheetValue): number =>
    typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2;
  return rank(left) - rank(right);
}

type Criterion = (value: SheetValue) => boolean;

function criterionOf(raw: SheetValue): Criterion {
  if (typeof raw === "string") {
    const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(raw)!;
    const op = match[1] ?? "=";
    const operandText = match[2] ?? "";
    const asNumber = operandText.trim().length > 0 ? Number(operandText) : Number.NaN;
    const operand: SheetValue = Number.isFinite(asNumber) ? asNumber : operandText;
    return (value) => {
      if (isSheetError(value)) return false;
      if (typeof operand === "number") {
        if (typeof value !== "number") return op === "<>";
      } else if (value === null) {
        return op === "=" ? operand === "" : op === "<>" ? operand !== "" : false;
      } else if (typeof value !== "string") {
        return op === "<>";
      }
      const order = compareValues(value, operand);
      switch (op) {
        case "=":
          return order === 0;
        case "<>":
          return order !== 0;
        case "<":
          return order < 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        default:
          return order >= 0;
      }
    };
  }
  return (value) => !isSheetError(value) && value !== null && compareValues(value, raw) === 0;
}

/**
 * Evaluate every formula of a validated workbook. The result never throws and
 * never runs longer than the step budget allows.
 */
function conditionalTargetBounds(
  criteriaArg: Node,
  targetArg: Node,
): {
  readonly testStartCol: number;
  readonly testStartRow: number;
  readonly startCol: number;
  readonly startRow: number;
  readonly endCol: number;
  readonly endRow: number;
} | null {
  if (
    (criteriaArg.k !== "range" && criteriaArg.k !== "ref") ||
    (targetArg.k !== "range" && targetArg.k !== "ref")
  ) {
    return null;
  }
  const t =
    criteriaArg.k === "range"
      ? criteriaArg
      : { c1: criteriaArg.col, r1: criteriaArg.row, c2: criteriaArg.col, r2: criteriaArg.row };
  const startCol = targetArg.k === "range" ? targetArg.c1 : targetArg.col;
  const startRow = targetArg.k === "range" ? targetArg.r1 : targetArg.row;
  const endCol = Math.min(SHEET_LIMITS.columns - 1, startCol + (t.c2 - t.c1));
  const endRow = Math.min(SHEET_LIMITS.rows - 1, startRow + (t.r2 - t.r1));
  return { testStartCol: t.c1, testStartRow: t.r1, startCol, startRow, endCol, endRow };
}

export function evaluateSheet(document: SheetDocument): SheetEvaluation {
  const tabs: TabState[] = document.tabs.map((tab) => {
    const inputs = new Map<number, SheetCellInput>();
    for (const [name, input] of Object.entries(tab.cells)) {
      const match = /^([A-Z]{1,2})([0-9]+)$/.exec(name);
      if (!match) continue;
      inputs.set(cellKey(columnIndex(match[1]!), Number(match[2]) - 1), input);
    }
    return { name: tab.name, inputs, values: new Map(), occupied: [...inputs.keys()] };
  });
  const tabIndexByName = new Map(tabs.map((tab, index) => [tab.name.toLowerCase(), index]));

  let steps = 0;
  let limitReached = false;
  const spend = (count: number): boolean => {
    steps += count;
    if (steps > SHEET_LIMITS.steps) limitReached = true;
    return !limitReached;
  };

  const resolveTab = (name: string | null, current: number): number | null =>
    name === null ? current : (tabIndexByName.get(name.toLowerCase()) ?? null);

  /** Visit each occupied cell of a range; false when the budget ran out. */
  const walkRange = (
    tab: TabState,
    c1: number,
    r1: number,
    c2: number,
    r2: number,
    visit: (key: number) => void,
  ): boolean => {
    const area = (c2 - c1 + 1) * (r2 - r1 + 1);
    if (area <= tab.occupied.length) {
      if (!spend(area)) return false;
      for (let row = r1; row <= r2; row += 1) {
        for (let col = c1; col <= c2; col += 1) {
          const key = cellKey(col, row);
          if (tab.inputs.has(key)) visit(key);
        }
      }
      return true;
    }
    if (!spend(tab.occupied.length)) return false;
    for (const key of tab.occupied) {
      const col = key % COLUMN_SPAN;
      const row = (key - col) / COLUMN_SPAN;
      if (col >= c1 && col <= c2 && row >= r1 && row <= r2) visit(key);
    }
    return true;
  };

  // 1. Literals, and a parsed formula for every formula cell.
  const formulas: FormulaCell[] = [];
  const formulaIndex: Array<Map<number, number>> = tabs.map(() => new Map());
  tabs.forEach((tab, tabIndex) => {
    for (const [key, input] of tab.inputs) {
      if (isFormulaInput(input)) {
        formulaIndex[tabIndex]!.set(key, formulas.length);
        formulas.push({
          tab: tabIndex,
          key,
          node: parseFormula(input.slice(1)),
          deps: [],
          pending: 0,
          dependents: [],
        });
      } else {
        tab.values.set(key, literalValue(input));
      }
    }
  });

  // 2. Dependencies between formula cells (iterative walk of each AST).
  for (let index = 0; index < formulas.length && !limitReached; index += 1) {
    const cell = formulas[index]!;
    const seen = new Set<number>();
    const stack: Node[] = [cell.node];
    const addDep = (tabIndex: number, key: number): void => {
      const dep = formulaIndex[tabIndex]!.get(key);
      if (dep === undefined || seen.has(dep)) return;
      seen.add(dep);
      cell.deps.push(dep);
    };
    while (stack.length > 0 && !limitReached) {
      const node = stack.pop()!;
      spend(1);
      switch (node.k) {
        case "ref": {
          const tabIndex = resolveTab(node.tab, cell.tab);
          if (tabIndex !== null) addDep(tabIndex, cellKey(node.col, node.row));
          break;
        }
        case "range": {
          const tabIndex = resolveTab(node.tab, cell.tab);
          if (tabIndex !== null) {
            walkRange(tabs[tabIndex]!, node.c1, node.r1, node.c2, node.r2, (key) =>
              addDep(tabIndex, key),
            );
          }
          break;
        }
        case "unary":
          stack.push(node.a);
          break;
        case "bin":
          stack.push(node.a, node.b);
          break;
        case "call": {
          const fn = node.name.toUpperCase();
          if ((fn === "SUMIF" || fn === "AVERAGEIF") && node.args.length === 3) {
            const criteriaArg = node.args[0]!;
            const targetArg = node.args[2]!;
            const bounds = conditionalTargetBounds(criteriaArg, targetArg);
            if (
              bounds !== null &&
              (criteriaArg.k === "ref" || criteriaArg.k === "range") &&
              (targetArg.k === "ref" || targetArg.k === "range")
            ) {
              const criteriaTabIndex = resolveTab(criteriaArg.tab, cell.tab);
              const targetTabIndex = resolveTab(targetArg.tab, cell.tab);
              if (targetTabIndex !== null) {
                walkRange(
                  tabs[targetTabIndex]!,
                  bounds.startCol,
                  bounds.startRow,
                  bounds.endCol,
                  bounds.endRow,
                  (key) => {
                    addDep(targetTabIndex, key);
                    if (criteriaTabIndex !== null) {
                      const col = key % COLUMN_SPAN;
                      const row = (key - col) / COLUMN_SPAN;
                      const testCol = bounds.testStartCol + (col - bounds.startCol);
                      const testRow = bounds.testStartRow + (row - bounds.startRow);
                      addDep(criteriaTabIndex, cellKey(testCol, testRow));
                    }
                  },
                );
              }
              // Push predicate only; occupied target cells and their paired criteria cells were walked above.
              stack.push(node.args[1]!);
              break;
            }
          }
          for (const arg of node.args) stack.push(arg);
          break;
        }
        default:
          break;
      }
    }
  }

  // 3. Evaluate in dependency order (Kahn). What is left over is a cycle.
  const valueOf = (tabIndex: number, key: number): SheetValue =>
    tabs[tabIndex]!.values.get(key) ?? null;

  const evaluateNode = (node: Node, current: number): SheetValue => {
    if (!spend(1)) return err("#LIMIT!");
    switch (node.k) {
      case "num":
        return node.v;
      case "str":
        return node.v;
      case "bool":
        return node.v;
      case "err":
        return err(node.code);
      case "ref": {
        const tabIndex = resolveTab(node.tab, current);
        return tabIndex === null ? err("#REF!") : valueOf(tabIndex, cellKey(node.col, node.row));
      }
      case "range": {
        // A bare range used as a single value: its top-left cell.
        const tabIndex = resolveTab(node.tab, current);
        return tabIndex === null ? err("#REF!") : valueOf(tabIndex, cellKey(node.c1, node.r1));
      }
      case "unary": {
        const operand = toNumber(evaluateNode(node.a, current));
        if (isSheetError(operand)) return operand;
        return node.op === "-" ? -operand : node.op === "%" ? operand / 100 : operand;
      }
      case "bin":
        return evaluateBinary(node.op, node.a, node.b, current);
      case "call":
        return evaluateCall(node.name, node.args, current);
    }
  };

  const evaluateBinary = (op: string, a: Node, b: Node, current: number): SheetValue => {
    const left = evaluateNode(a, current);
    if (isSheetError(left)) return left;
    const right = evaluateNode(b, current);
    if (isSheetError(right)) return right;
    if (op === "&") {
      const x = toText(left);
      const y = toText(right);
      if (isSheetError(x)) return x;
      if (isSheetError(y)) return y;
      const joined = x + y;
      return joined.length > SHEET_LIMITS.textChars ? err("#LIMIT!") : joined;
    }
    if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      const order = compareValues(left, right);
      switch (op) {
        case "=":
          return order === 0;
        case "<>":
          return order !== 0;
        case "<":
          return order < 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        default:
          return order >= 0;
      }
    }
    const x = toNumber(left);
    if (isSheetError(x)) return x;
    const y = toNumber(right);
    if (isSheetError(y)) return y;
    switch (op) {
      case "+":
        return finite(x + y);
      case "-":
        return finite(x - y);
      case "*":
        return finite(x * y);
      case "/":
        return y === 0 ? err("#DIV/0!") : finite(x / y);
      default:
        return finite(x ** y);
    }
  };

  /** Every value an argument stands for: a range's cells, or the one value. */
  const collect = (
    node: Node,
    current: number,
    visit: (value: SheetValue, fromRange: boolean) => void,
  ): SheetError | null => {
    if (node.k === "range") {
      const tabIndex = resolveTab(node.tab, current);
      if (tabIndex === null) return err("#REF!");
      const tab = tabs[tabIndex]!;
      const done = walkRange(tab, node.c1, node.r1, node.c2, node.r2, (key) =>
        visit(tab.values.get(key) ?? null, true),
      );
      return done ? null : err("#LIMIT!");
    }
    visit(evaluateNode(node, current), node.k === "ref");
    return null;
  };

  const numbersOf = (
    args: ReadonlyArray<Node>,
    current: number,
  ): { readonly numbers: number[] } | SheetError => {
    const numbers: number[] = [];
    let failure: SheetError | null = null;
    for (const arg of args) {
      const problem = collect(arg, current, (value, fromRange) => {
        if (failure) return;
        if (isSheetError(value)) {
          failure = value;
        } else if (typeof value === "number") {
          numbers.push(value);
        } else if (!fromRange && value !== null) {
          // A typed argument such as SUM("3", TRUE) is coerced; cell text is skipped.
          const coerced = toNumber(value);
          if (isSheetError(coerced)) failure = coerced;
          else numbers.push(coerced);
        }
      });
      if (problem) return problem;
      if (failure) return failure;
    }
    return { numbers };
  };

  const evaluateCall = (name: string, args: ReadonlyArray<Node>, current: number): SheetValue => {
    switch (name) {
      case "SUM":
      case "AVERAGE":
      case "MIN":
      case "MAX": {
        const result = numbersOf(args, current);
        if (isSheetError(result)) return result;
        const { numbers } = result;
        if (name === "SUM") return finite(numbers.reduce((total, n) => total + n, 0));
        if (numbers.length === 0) return name === "AVERAGE" ? err("#DIV/0!") : 0;
        if (name === "AVERAGE") {
          return finite(numbers.reduce((total, n) => total + n, 0) / numbers.length);
        }
        let best = numbers[0]!;
        for (const n of numbers) best = name === "MIN" ? Math.min(best, n) : Math.max(best, n);
        return best;
      }
      case "COUNT":
      case "COUNTA": {
        let count = 0;
        for (const arg of args) {
          const problem = collect(arg, current, (value) => {
            if (name === "COUNT" ? typeof value === "number" : value !== null && value !== "") {
              count += 1;
            }
          });
          if (problem) return problem;
        }
        return count;
      }
      case "COUNTIF": {
        if (args.length !== 2) return err("#VALUE!");
        const criterionValue = evaluateNode(args[1]!, current);
        if (isSheetError(criterionValue)) return criterionValue;
        const matches = criterionOf(criterionValue);
        let count = 0;
        let visited = 0;
        const problem = collect(args[0]!, current, (value) => {
          visited += 1;
          if (matches(value)) count += 1;
        });
        if (problem) return problem;
        // A range visits only filled cells; the empty ones count when the criterion fits them.
        const target = args[0]!;
        if (target.k === "range" && matches(null)) {
          count += (target.c2 - target.c1 + 1) * (target.r2 - target.r1 + 1) - visited;
        }
        return count;
      }
      case "SUMIF": {
        if (args.length !== 2 && args.length !== 3) return err("#VALUE!");
        const criterionValue = evaluateNode(args[1]!, current);
        if (isSheetError(criterionValue)) return criterionValue;
        const matches = criterionOf(criterionValue);
        const test = args[0]!;
        const sumNode = args[2] ?? test;
        if (test.k !== "range" && test.k !== "ref") return err("#VALUE!");
        if (sumNode.k !== "range" && sumNode.k !== "ref") return err("#VALUE!");
        const testTab = resolveTab(test.tab, current);
        const sumTab = resolveTab(sumNode.tab, current);
        if (testTab === null || sumTab === null) return err("#REF!");
        const bounds = conditionalTargetBounds(test, sumNode);
        if (!bounds) return err("#VALUE!");
        let total = 0;
        let failure: SheetError | null = null;
        // Walk the cells that can add to the total and test the cell beside each,
        // so an empty test cell still counts when the criterion fits it.
        const done = walkRange(
          tabs[sumTab]!,
          bounds.startCol,
          bounds.startRow,
          bounds.endCol,
          bounds.endRow,
          (key) => {
            if (failure) return;
            const col = key % COLUMN_SPAN;
            const row = (key - col) / COLUMN_SPAN;
            const tested = valueOf(
              testTab,
              cellKey(
                bounds.testStartCol + (col - bounds.startCol),
                bounds.testStartRow + (row - bounds.startRow),
              ),
            );
            if (isSheetError(tested) || !matches(tested)) return;
            const value = valueOf(sumTab, key);
            if (isSheetError(value)) failure = value;
            else if (typeof value === "number") total += value;
          },
        );
        if (!done) return err("#LIMIT!");
        return failure ?? finite(total);
      }
      case "IF": {
        if (args.length < 2 || args.length > 3) return err("#VALUE!");
        const condition = toBoolean(evaluateNode(args[0]!, current));
        if (isSheetError(condition)) return condition;
        if (condition) return evaluateNode(args[1]!, current);
        return args[2] ? evaluateNode(args[2], current) : false;
      }
      case "AND":
      case "OR": {
        if (args.length === 0) return err("#VALUE!");
        let result = name === "AND";
        let failure: SheetError | null = null;
        let logical = 0;
        for (const arg of args) {
          const problem = collect(arg, current, (value, fromRange) => {
            if (failure || (fromRange && (value === null || typeof value === "string"))) return;
            const flag = toBoolean(value);
            if (isSheetError(flag)) failure = flag;
            else {
              logical += 1;
              result = name === "AND" ? result && flag : result || flag;
            }
          });
          if (problem) return problem;
          if (failure) return failure;
        }
        // Nothing to test, as in a range of text and blanks, is an error, not an answer.
        return logical === 0 ? err("#VALUE!") : result;
      }
      case "NOT": {
        if (args.length !== 1) return err("#VALUE!");
        const flag = toBoolean(evaluateNode(args[0]!, current));
        return isSheetError(flag) ? flag : !flag;
      }
      case "ROUND": {
        if (args.length < 1 || args.length > 2) return err("#VALUE!");
        const value = toNumber(evaluateNode(args[0]!, current));
        if (isSheetError(value)) return value;
        const digits = args[1] ? toNumber(evaluateNode(args[1], current)) : 0;
        if (isSheetError(digits)) return digits;
        const places = Math.max(-15, Math.min(15, Math.trunc(digits)));
        const factor = 10 ** places;
        // Round half away from zero, as a spreadsheet does.
        const scaled = Math.abs(value) * factor;
        const rounded = Math.round(scaled + 1e-9 * Math.max(1, scaled)) / factor;
        return finite(value < 0 ? -rounded : rounded);
      }
      case "ABS": {
        if (args.length !== 1) return err("#VALUE!");
        const value = toNumber(evaluateNode(args[0]!, current));
        return isSheetError(value) ? value : Math.abs(value);
      }
      case "IFERROR": {
        if (args.length !== 2) return err("#VALUE!");
        const value = evaluateNode(args[0]!, current);
        // A budget stop is not an error a formula may hide.
        if (isSheetError(value) && value.error !== "#LIMIT!")
          return evaluateNode(args[1]!, current);
        return value;
      }
      case "IFNA": {
        if (args.length !== 2) return err("#VALUE!");
        const value = evaluateNode(args[0]!, current);
        if (isSheetError(value) && value.error === "#N/A") {
          return evaluateNode(args[1]!, current);
        }
        return value;
      }
      case "MEDIAN": {
        const result = numbersOf(args, current);
        if (isSheetError(result)) return result;
        const { numbers } = result;
        if (numbers.length === 0) return err("#VALUE!");
        const sorted = [...numbers].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1
          ? sorted[mid]!
          : finite((sorted[mid - 1]! + sorted[mid]!) / 2);
      }
      case "AVERAGEIF": {
        if (args.length !== 2 && args.length !== 3) return err("#VALUE!");
        const criterionValue = evaluateNode(args[1]!, current);
        if (isSheetError(criterionValue)) return criterionValue;
        const matches = criterionOf(criterionValue);
        const test = args[0]!;
        const avgNode = args[2] ?? test;
        if (test.k !== "range" && test.k !== "ref") return err("#VALUE!");
        if (avgNode.k !== "range" && avgNode.k !== "ref") return err("#VALUE!");
        const testTab = resolveTab(test.tab, current);
        const avgTab = resolveTab(avgNode.tab, current);
        if (testTab === null || avgTab === null) return err("#REF!");
        const bounds = conditionalTargetBounds(test, avgNode);
        if (!bounds) return err("#VALUE!");
        let total = 0;
        let matched = 0;
        let failure: SheetError | null = null;
        const done = walkRange(
          tabs[avgTab]!,
          bounds.startCol,
          bounds.startRow,
          bounds.endCol,
          bounds.endRow,
          (key) => {
            if (failure) return;
            const col = key % COLUMN_SPAN;
            const row = (key - col) / COLUMN_SPAN;
            const tested = valueOf(
              testTab,
              cellKey(
                bounds.testStartCol + (col - bounds.startCol),
                bounds.testStartRow + (row - bounds.startRow),
              ),
            );
            if (isSheetError(tested) || !matches(tested)) return;
            const value = valueOf(avgTab, key);
            if (isSheetError(value)) failure = value;
            else if (typeof value === "number") {
              total += value;
              matched += 1;
            }
          },
        );
        if (!done) return err("#LIMIT!");
        if (failure) return failure;
        return matched === 0 ? err("#DIV/0!") : finite(total / matched);
      }
      case "SUMIFS":
      case "COUNTIFS": {
        const isSum = name === "SUMIFS";
        const minArgs = isSum ? 3 : 2;
        if (args.length < minArgs || (isSum ? (args.length - 1) % 2 !== 0 : args.length % 2 !== 0)) {
          return err("#VALUE!");
        }
        const pairStart = isSum ? 1 : 0;
        const toRect = (node: Node) => {
          if (node.k !== "range" && node.k !== "ref") return null;
          const tabIndex = resolveTab(node.tab, current);
          if (tabIndex === null) return err("#REF!");
          return node.k === "range"
            ? { tab: tabIndex, c1: node.c1, r1: node.r1, c2: node.c2, r2: node.r2 }
            : { tab: tabIndex, c1: node.col, r1: node.row, c2: node.col, r2: node.row };
        };
        const baseRect = toRect(args[0]!);
        if (baseRect === null) return err("#VALUE!");
        if (isSheetError(baseRect)) return baseRect;
        const width = baseRect.c2 - baseRect.c1;
        const height = baseRect.r2 - baseRect.r1;
        const pairs: Array<{
          readonly rect: { tab: number; c1: number; r1: number; c2: number; r2: number };
          readonly match: (value: SheetValue) => boolean;
        }> = [];
        for (let i = pairStart; i < args.length; i += 2) {
          const rect = toRect(args[i]!);
          if (rect === null) return err("#VALUE!");
          if (isSheetError(rect)) return rect;
          if (rect.c2 - rect.c1 !== width || rect.r2 - rect.r1 !== height) return err("#VALUE!");
          const crit = evaluateNode(args[i + 1]!, current);
          if (isSheetError(crit)) return crit;
          pairs.push({ rect, match: criterionOf(crit) });
        }
        if (isSum) {
          let total = 0;
          let failure: SheetError | null = null;
          const done = walkRange(
            tabs[baseRect.tab]!,
            baseRect.c1,
            baseRect.r1,
            baseRect.c2,
            baseRect.r2,
            (key) => {
              if (failure) return;
              const col = key % COLUMN_SPAN;
              const row = (key - col) / COLUMN_SPAN;
              const dc = col - baseRect.c1;
              const dr = row - baseRect.r1;
              for (const pair of pairs) {
                const tested = valueOf(pair.rect.tab, cellKey(pair.rect.c1 + dc, pair.rect.r1 + dr));
                if (isSheetError(tested) || !pair.match(tested)) return;
              }
              const val = valueOf(baseRect.tab, key);
              if (isSheetError(val)) failure = val;
              else if (typeof val === "number") total += val;
            },
          );
          if (!done) return err("#LIMIT!");
          return failure ?? finite(total);
        }
        // COUNTIFS: inspect every coordinate in the shape when any criterion can match blank,
        // otherwise walk filled cells of the first range.
        const first = pairs[0]!;
        let count = 0;
        if (first.match(null)) {
          for (let dr = 0; dr <= height; dr += 1) {
            for (let dc = 0; dc <= width; dc += 1) {
              if (!spend(1)) return err("#LIMIT!");
              let ok = true;
              for (const pair of pairs) {
                const tested = valueOf(pair.rect.tab, cellKey(pair.rect.c1 + dc, pair.rect.r1 + dr));
                if (isSheetError(tested) || !pair.match(tested)) {
                  ok = false;
                  break;
                }
              }
              if (ok) count += 1;
            }
          }
          return count;
        }
        const done = walkRange(
          tabs[first.rect.tab]!,
          first.rect.c1,
          first.rect.r1,
          first.rect.c2,
          first.rect.r2,
          (key) => {
            const col = key % COLUMN_SPAN;
            const row = (key - col) / COLUMN_SPAN;
            const dc = col - first.rect.c1;
            const dr = row - first.rect.r1;
            for (const pair of pairs) {
              const tested = valueOf(pair.rect.tab, cellKey(pair.rect.c1 + dc, pair.rect.r1 + dr));
              if (isSheetError(tested) || !pair.match(tested)) return;
            }
            count += 1;
          },
        );
        return done ? count : err("#LIMIT!");
      }
      case "ROUNDUP":
      case "ROUNDDOWN": {
        if (args.length < 1 || args.length > 2) return err("#VALUE!");
        const value = toNumber(evaluateNode(args[0]!, current));
        if (isSheetError(value)) return value;
        const digits = args[1] ? toNumber(evaluateNode(args[1], current)) : 0;
        if (isSheetError(digits)) return digits;
        const places = Math.max(-15, Math.min(15, Math.trunc(digits)));
        const factor = 10 ** places;
        const scaled = Math.abs(value) * factor;
        const eps = 1e-12 * Math.max(1, scaled);
        const rounded =
          name === "ROUNDUP"
            ? Math.ceil(scaled - eps) / factor
            : Math.floor(scaled + eps) / factor;
        return finite(value < 0 ? -rounded : rounded);
      }
      case "POWER": {
        if (args.length !== 2) return err("#VALUE!");
        const base = toNumber(evaluateNode(args[0]!, current));
        if (isSheetError(base)) return base;
        const exp = toNumber(evaluateNode(args[1]!, current));
        if (isSheetError(exp)) return exp;
        return finite(base ** exp);
      }
      case "MOD": {
        if (args.length !== 2) return err("#VALUE!");
        const dividend = toNumber(evaluateNode(args[0]!, current));
        if (isSheetError(dividend)) return dividend;
        const divisor = toNumber(evaluateNode(args[1]!, current));
        if (isSheetError(divisor)) return divisor;
        if (divisor === 0) return err("#DIV/0!");
        // Spreadsheet MOD keeps the sign of the divisor.
        return finite(dividend - divisor * Math.floor(dividend / divisor));
      }
      case "CONCAT": {
        if (args.length === 0) return err("#VALUE!");
        let out = "";
        let failure: SheetError | null = null;
        for (const arg of args) {
          const problem = collect(arg, current, (value) => {
            if (failure) return;
            const part = toText(value);
            if (isSheetError(part)) {
              failure = part;
              return;
            }
            if (out.length + part.length > SHEET_LIMITS.textChars) {
              failure = err("#LIMIT!");
              return;
            }
            out += part;
          });
          if (problem) return problem;
          if (failure) return failure;
        }
        return out;
      }
      case "LEFT":
      case "RIGHT": {
        if (args.length < 1 || args.length > 2) return err("#VALUE!");
        const text = toText(evaluateNode(args[0]!, current));
        if (isSheetError(text)) return text;
        const count = args[1] ? toNumber(evaluateNode(args[1], current)) : 1;
        if (isSheetError(count)) return count;
        if (count < 0) return err("#VALUE!");
        const n = Math.trunc(count);
        return name === "LEFT" ? text.slice(0, n) : n === 0 ? "" : text.slice(-n);
      }
      case "LEN":
      case "LOWER":
      case "UPPER":
      case "TRIM": {
        if (args.length !== 1) return err("#VALUE!");
        const text = toText(evaluateNode(args[0]!, current));
        if (isSheetError(text)) return text;
        if (name === "LEN") return text.length;
        if (name === "LOWER") return text.toLowerCase();
        if (name === "UPPER") return text.toUpperCase();
        return text.trim().replace(/\s+/g, " ");
      }
      case "INDEX": {
        if (args.length < 2 || args.length > 3) return err("#VALUE!");
        const target = args[0]!;
        if (target.k !== "range" && target.k !== "ref") return err("#VALUE!");
        const tabIndex = resolveTab(target.tab, current);
        if (tabIndex === null) return err("#REF!");
        const rect =
          target.k === "range"
            ? target
            : { c1: target.col, r1: target.row, c2: target.col, r2: target.row };
        const rowNum = toNumber(evaluateNode(args[1]!, current));
        if (isSheetError(rowNum)) return rowNum;
        const colNum = args[2] ? toNumber(evaluateNode(args[2], current)) : 1;
        if (isSheetError(colNum)) return colNum;
        const r = Math.trunc(rowNum);
        const c = Math.trunc(colNum);
        if (r < 1 || c < 1) return err("#VALUE!");
        const rows = rect.r2 - rect.r1 + 1;
        const cols = rect.c2 - rect.c1 + 1;
        // 1-D horizontal vector shorthand INDEX(A1:E1, 3) indexes along columns when colNum is omitted.
        if (args.length === 2 && rows === 1 && cols > 1) {
          if (r > cols) return err("#REF!");
          return valueOf(tabIndex, cellKey(rect.c1 + r - 1, rect.r1));
        }
        if (r > rows || c > cols) return err("#REF!");
        return valueOf(tabIndex, cellKey(rect.c1 + c - 1, rect.r1 + r - 1));
      }
      case "MATCH": {
        if (args.length < 2 || args.length > 3) return err("#VALUE!");
        const lookup = evaluateNode(args[0]!, current);
        if (isSheetError(lookup)) return lookup;
        const target = args[1]!;
        if (target.k !== "range" && target.k !== "ref") return err("#VALUE!");
        const tabIndex = resolveTab(target.tab, current);
        if (tabIndex === null) return err("#REF!");
        const rect =
          target.k === "range"
            ? target
            : { c1: target.col, r1: target.row, c2: target.col, r2: target.row };
        const rows = rect.r2 - rect.r1 + 1;
        const cols = rect.c2 - rect.c1 + 1;
        if (rows > 1 && cols > 1) return err("#N/A");
        const matchTypeVal = args[2] ? toNumber(evaluateNode(args[2], current)) : 1;
        if (isSheetError(matchTypeVal)) return matchTypeVal;
        const matchType = Math.trunc(matchTypeVal);
        const len = Math.max(rows, cols);
        const entryAt = (idx: number): SheetValue =>
          valueOf(
            tabIndex,
            rows >= cols ? cellKey(rect.c1, rect.r1 + idx) : cellKey(rect.c1 + idx, rect.r1),
          );
        const same = (a: SheetValue, b: SheetValue): boolean => {
          if (typeof a === "string" && typeof b === "string") {
            return a.toLowerCase() === b.toLowerCase();
          }
          return a === b;
        };
        if (matchType === 0) {
          for (let i = 0; i < len; i += 1) {
            if (!spend(1)) return err("#LIMIT!");
            const candidate = entryAt(i);
            if (!isSheetError(candidate) && same(candidate, lookup)) return i + 1;
          }
          return err("#N/A");
        }
        // Approximate match (1 = ascending largest <= lookup, -1 = descending smallest >= lookup).
        let best = -1;
        for (let i = 0; i < len; i += 1) {
          if (!spend(1)) return err("#LIMIT!");
          const candidate = entryAt(i);
          if (isSheetError(candidate) || candidate === null) continue;
          if (typeof lookup === "number" && typeof candidate === "number") {
            if (matchType > 0 ? candidate <= lookup : candidate >= lookup) best = i;
            else break;
          } else if (typeof lookup === "string" && typeof candidate === "string") {
            const cmp = candidate.toLowerCase().localeCompare(lookup.toLowerCase());
            if (matchType > 0 ? cmp <= 0 : cmp >= 0) best = i;
            else break;
          }
        }
        return best >= 0 ? best + 1 : err("#N/A");
      }
      case "VLOOKUP": {
        if (args.length < 3 || args.length > 4) return err("#VALUE!");
        const lookup = evaluateNode(args[0]!, current);
        if (isSheetError(lookup)) return lookup;
        const table = args[1]!;
        if (table.k !== "range" && table.k !== "ref") return err("#VALUE!");
        const tabIndex = resolveTab(table.tab, current);
        if (tabIndex === null) return err("#REF!");
        const rect =
          table.k === "range"
            ? table
            : { c1: table.col, r1: table.row, c2: table.col, r2: table.row };
        const colIdxNum = toNumber(evaluateNode(args[2]!, current));
        if (isSheetError(colIdxNum)) return colIdxNum;
        const colIdx = Math.trunc(colIdxNum);
        if (colIdx < 1) return err("#VALUE!");
        if (colIdx > rect.c2 - rect.c1 + 1) return err("#REF!");
        const approx = args[3] ? toBoolean(evaluateNode(args[3], current)) : true;
        if (isSheetError(approx)) return approx;
        const rows = rect.r2 - rect.r1 + 1;
        const same = (a: SheetValue, b: SheetValue): boolean =>
          typeof a === "string" && typeof b === "string"
            ? a.toLowerCase() === b.toLowerCase()
            : a === b;
        if (!approx) {
          for (let r = 0; r < rows; r += 1) {
            if (!spend(1)) return err("#LIMIT!");
            const candidate = valueOf(tabIndex, cellKey(rect.c1, rect.r1 + r));
            if (!isSheetError(candidate) && same(candidate, lookup)) {
              return valueOf(tabIndex, cellKey(rect.c1 + colIdx - 1, rect.r1 + r));
            }
          }
          return err("#N/A");
        }
        let bestRow = -1;
        for (let r = 0; r < rows; r += 1) {
          if (!spend(1)) return err("#LIMIT!");
          const candidate = valueOf(tabIndex, cellKey(rect.c1, rect.r1 + r));
          if (isSheetError(candidate) || candidate === null) continue;
          if (typeof lookup === "number" && typeof candidate === "number") {
            if (candidate <= lookup) bestRow = r;
            else break;
          } else if (typeof lookup === "string" && typeof candidate === "string") {
            if (candidate.toLowerCase().localeCompare(lookup.toLowerCase()) <= 0) bestRow = r;
            else break;
          }
        }
        return bestRow >= 0
          ? valueOf(tabIndex, cellKey(rect.c1 + colIdx - 1, rect.r1 + bestRow))
          : err("#N/A");
      }
      default:
        return err("#NAME?");
    }
  };

  for (const cell of formulas) cell.pending = cell.deps.length;
  formulas.forEach((cell, index) => {
    for (const dep of cell.deps) formulas[dep]!.dependents.push(index);
  });
  const ready: number[] = [];
  formulas.forEach((cell, index) => {
    if (cell.pending === 0) ready.push(index);
  });
  let evaluated = 0;
  while (ready.length > 0) {
    const index = ready.pop()!;
    const cell = formulas[index]!;
    const value = limitReached ? err("#LIMIT!") : evaluateNode(cell.node, cell.tab);
    tabs[cell.tab]!.values.set(
      cell.key,
      limitReached && !isSheetError(value) ? err("#LIMIT!") : value,
    );
    evaluated += 1;
    for (const dependent of cell.dependents) {
      const next = formulas[dependent]!;
      next.pending -= 1;
      if (next.pending === 0) ready.push(dependent);
    }
  }
  if (evaluated < formulas.length) {
    for (const cell of formulas) {
      if (cell.pending > 0) {
        tabs[cell.tab]!.values.set(cell.key, err(limitReached ? "#LIMIT!" : "#CYCLE!"));
      }
    }
  }

  const errors: Array<{ cell: string; error: SheetErrorCode }> = [];
  for (const cell of formulas) {
    const value = tabs[cell.tab]!.values.get(cell.key);
    if (isSheetError(value) && errors.length < 200) {
      const col = cell.key % COLUMN_SPAN;
      const row = (cell.key - col) / COLUMN_SPAN;
      errors.push({
        cell: `${tabs[cell.tab]!.name}!${cellName({ col, row })}`,
        error: value.error,
      });
    }
  }

  return {
    valueAt: (tab, address) => tabs[tab]?.values.get(cellKey(address.col, address.row)) ?? null,
    errors,
    formulaCount: formulas.length,
    limitReached,
  };
}
