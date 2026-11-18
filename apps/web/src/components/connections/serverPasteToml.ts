/**
 * The small part of TOML a tool's setup page uses for one MCP server: tables,
 * strings, arrays of strings, inline tables, booleans and numbers. Anything
 * else returns null, so the paste box refuses it instead of guessing.
 */
export type TomlValue =
  | string
  | number
  | boolean
  | ReadonlyArray<TomlValue>
  | { readonly [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

const BARE_KEY = /^[A-Za-z0-9_-]+/;

class Reader {
  position = 0;
  constructor(readonly text: string) {}
  get done() {
    return this.position >= this.text.length;
  }
  peek() {
    return this.text[this.position] ?? "";
  }
  /** Spaces and tabs, plus line breaks and comments when a value may span lines. */
  skip(lines: boolean) {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t") this.position += 1;
      else if (lines && (char === "\n" || char === "\r")) this.position += 1;
      else if (lines && char === "#") this.restOfLine();
      else return;
    }
  }
  restOfLine() {
    const end = this.text.indexOf("\n", this.position);
    const line = this.text.slice(this.position, end === -1 ? this.text.length : end);
    this.position = end === -1 ? this.text.length : end + 1;
    return line;
  }
  take(char: string) {
    if (this.peek() !== char) return false;
    this.position += 1;
    return true;
  }
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

function readString(reader: Reader): string | null {
  const quote = reader.peek();
  if (quote !== '"' && quote !== "'") return null;
  // Multi-line strings are outside the subset.
  if (reader.text.startsWith(quote.repeat(3), reader.position)) return null;
  reader.position += 1;
  let value = "";
  for (;;) {
    if (reader.done) return null;
    const char = reader.text[reader.position]!;
    reader.position += 1;
    if (char === "\n") return null;
    if (char === quote) return value;
    if (char === "\\" && quote === '"') {
      const next = reader.text[reader.position] ?? "";
      reader.position += 1;
      if (next === "u" || next === "U") {
        const length = next === "u" ? 4 : 8;
        const code = reader.text.slice(reader.position, reader.position + length);
        if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(code)) return null;
        reader.position += length;
        value += String.fromCodePoint(Number.parseInt(code, 16));
      } else if (Object.hasOwn(ESCAPES, next)) value += ESCAPES[next];
      else return null;
    } else value += char;
  }
}

function readKey(reader: Reader): string | null {
  const quoted = readString(reader);
  if (quoted !== null) return quoted;
  const bare = BARE_KEY.exec(reader.text.slice(reader.position));
  if (!bare) return null;
  reader.position += bare[0].length;
  return bare[0];
}

/** `a.b."c d"`, as a table header or the left side of an assignment writes it. */
function readPath(reader: Reader): string[] | null {
  const path: string[] = [];
  for (;;) {
    reader.skip(false);
    const key = readKey(reader);
    if (key === null) return null;
    path.push(key);
    reader.skip(false);
    if (!reader.take(".")) return path;
  }
}

function readValue(reader: Reader): TomlValue | null {
  const char = reader.peek();
  if (char === '"' || char === "'") return readString(reader);
  if (char === "[") {
    reader.position += 1;
    const items: TomlValue[] = [];
    for (;;) {
      reader.skip(true);
      if (reader.take("]")) return items;
      const item = readValue(reader);
      if (item === null) return null;
      items.push(item);
      reader.skip(true);
      if (reader.take(",")) continue;
      if (reader.take("]")) return items;
      return null;
    }
  }
  if (char === "{") {
    reader.position += 1;
    const table: TomlTable = {};
    reader.skip(false);
    if (reader.take("}")) return table;
    for (;;) {
      const path = readPath(reader);
      if (path === null || !reader.take("=")) return null;
      reader.skip(false);
      const value = readValue(reader);
      if (value === null || !assign(table, path, value)) return null;
      reader.skip(false);
      if (reader.take(",")) continue;
      if (reader.take("}")) return table;
      return null;
    }
  }
  const word = /^[A-Za-z0-9_+.:-]+/.exec(reader.text.slice(reader.position));
  if (!word) return null;
  reader.position += word[0].length;
  if (word[0] === "true") return true;
  if (word[0] === "false") return false;
  const number = Number(word[0].replaceAll("_", ""));
  return Number.isFinite(number) ? number : null;
}

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function tableAt(root: TomlTable, path: ReadonlyArray<string>): TomlTable | null {
  let table = root;
  for (const key of path) {
    const next = table[key];
    if (next === undefined) {
      const created: TomlTable = {};
      table[key] = created;
      table = created;
    } else if (isTable(next)) table = next;
    else return null;
  }
  return table;
}

function assign(root: TomlTable, path: ReadonlyArray<string>, value: TomlValue): boolean {
  const table = tableAt(root, path.slice(0, -1));
  const key = path.at(-1)!;
  if (table === null || Object.hasOwn(table, key)) return false;
  table[key] = value;
  return true;
}

/** The document as nested tables, or null when it uses TOML outside the subset. */
export function parseTomlSubset(text: string): TomlTable | null {
  const reader = new Reader(text.replaceAll("\r\n", "\n"));
  const root: TomlTable = {};
  let current = root;
  for (;;) {
    reader.skip(true);
    if (reader.done) return root;
    if (reader.peek() === "[") {
      reader.position += 1;
      // Arrays of tables are outside the subset.
      if (reader.peek() === "[") return null;
      const path = readPath(reader);
      if (path === null || !reader.take("]")) return null;
      const table = tableAt(root, path);
      if (table === null) return null;
      current = table;
    } else {
      const path = readPath(reader);
      if (path === null || !reader.take("=")) return null;
      reader.skip(false);
      const value = readValue(reader);
      if (value === null || !assign(current, path, value)) return null;
    }
    reader.skip(false);
    if (reader.done) return root;
    if (reader.peek() === "#") reader.restOfLine();
    else if (!reader.take("\n")) return null;
  }
}
