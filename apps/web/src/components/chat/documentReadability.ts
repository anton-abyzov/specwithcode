/**
 * Markdown files agents write often put one statement per line with no blank
 * line between them, and leave digests and paths bare in the prose. CommonMark
 * joins those lines into one paragraph, so the document reader showed a wall
 * of serif text. These steps change only how a document is laid out: every
 * character of the file stays as written, in order, and stays visible.
 *
 * Applied in the document reader only; chat replies keep their own rules.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** A line that ends with closing punctuation. */
const CLOSING_PUNCTUATION = /[.!?:;]["')\]*_`]*$/u;
/** A last word that is a path or a URL, which ends a `Report: /path` line. */
const PATH_OR_URL = /^(?:~\/|\/|[a-z][a-z+.-]*:\/\/)\S/u;
/** A `Label: value` line, as in a block of facts. */
const LABEL_LINE = /^[\p{Lu}*_][^:]{0,40}:\s+\S/u;
/**
 * Two lines that both end a sentence are as likely a wrap that fell on a
 * sentence end, so statement mode needs at least this many.
 */
const MIN_STATEMENT_LINES = 3;
/** A line that starts a statement: a capital, a digit or inline markup. */
const STATEMENT_START = /^[\p{Lu}\p{N}*_`[(/~#]/u;
/** Lines this short read as a label block (`Owner: office`), kept tight with line breaks. */
const SHORT_LINE = 80;

/**
 * Home and scratch folders only, so prose such as `Synced/Healthy`, `and/or`
 * or an API route is never set as a path.
 */
const BARE_PATH =
  /(?<![\w/.~-])(?:~|\/(?:Users|home|tmp|private|var\/folders|Volumes|opt))\/[^\s<>()[\]{}"'`|]+/gu;
/** A path is only certain when it ends in a file name with an extension. */
const FILE_EXTENSION = /\/[^/]*[^/.]\.[A-Za-z0-9]{1,10}$/u;
/** What may follow a whole path: the end, a space or closing punctuation, never `(` or `'`. */
const PATH_FOLLOWER = /^(?:$|[\s.,;:!?)\]…])/u;
/** Full commit hashes and sha256 digests that stand alone, never inside a longer word. */
const BARE_DIGEST =
  /(?<![\p{L}\p{N}])(?:sha256:[0-9a-f]{64}|[0-9a-f]{64}|[0-9a-f]{40})(?![\p{L}\p{N}])/gu;
const TRAILING_PUNCTUATION = /[.,;:!?…]+$/u;

function lineStatements(paragraph: MdNode): string[] | null {
  // Inline HTML can open on one line and close on the next; splitting would break it.
  if ((paragraph.children ?? []).some((child) => child.type === "html")) return null;
  const lines: string[] = [];
  let current = "";
  for (const child of paragraph.children ?? []) {
    if (child.type === "text") {
      const [first = "", ...rest] = (child.value ?? "").split("\n");
      current += first;
      for (const part of rest) {
        lines.push(current);
        current = part;
      }
    } else if (child.type === "break") {
      return null;
    } else {
      const text = plainText(child);
      // A soft break inside emphasis or a link is not one this rule can split.
      if (text.includes("\n")) return null;
      current += child.type === "inlineCode" ? `\`${text}\`` : text;
    }
  }
  lines.push(current);
  return lines.length > 1 ? lines.map((line) => line.trim()) : null;
}

/**
 * True when every line of the paragraph is its own statement. A hard-wrapped
 * paragraph has at least one line that stops mid-sentence, so it stays joined.
 */
function isStatementPerLine(lines: readonly string[]): boolean {
  if (lines.some((line) => line.length === 0)) return false;
  // A block of facts: every line is `Label: value`, after an optional `Intro:` line.
  const facts = lines[0]?.endsWith(":") ? lines.slice(1) : lines;
  if (facts.length > 1 && facts.every((line) => LABEL_LINE.test(line))) return true;
  return (
    lines.length >= MIN_STATEMENT_LINES &&
    lines.every(
      (line, index) =>
        (index === lines.length - 1 || endsStatement(line)) &&
        (index === 0 || STATEMENT_START.test(line)),
    )
  );
}

function endsStatement(line: string): boolean {
  if (CLOSING_PUNCTUATION.test(line)) return true;
  // The last word, found without a backtracking pattern: a line can be a 50 KB blob.
  const lastWord = line.slice(line.lastIndexOf(" ") + 1);
  return PATH_OR_URL.test(lastWord);
}

/** Splits the paragraph's children at its soft breaks, one run per line. */
function splitAtSoftBreaks(paragraph: MdNode): MdNode[][] {
  const runs: MdNode[][] = [[]];
  for (const child of paragraph.children ?? []) {
    if (child.type !== "text" || !(child.value ?? "").includes("\n")) {
      runs[runs.length - 1]!.push(child);
      continue;
    }
    const parts = (child.value ?? "").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) runs.push([]);
      const value = index === 0 ? part.trimEnd() : part.trimStart();
      if (value) runs[runs.length - 1]!.push({ type: "text", value });
    });
  }
  return runs;
}

function plainText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

function statementBlocks(paragraph: MdNode): MdNode[] {
  const lines = lineStatements(paragraph);
  if (!lines || !isStatementPerLine(lines)) return [paragraph];
  const runs = splitAtSoftBreaks(paragraph);
  if (lines.every((line) => line.length <= SHORT_LINE)) {
    const children = runs.flatMap((run, index) =>
      index === 0 ? run : [{ type: "break" } satisfies MdNode, ...run],
    );
    return [{ ...paragraph, children }];
  }
  return runs.map((children) => ({ type: "paragraph", children }));
}

/**
 * Bare home paths and standalone digests read as code, shown in full. They are
 * not made into file chips: a chip shows only the file name, and a document
 * must show every character it holds.
 */
function tokenNodes(value: string): MdNode[] | null {
  const matches: Array<{ start: number; end: number; node: MdNode }> = [];
  for (const match of value.matchAll(BARE_PATH)) {
    const path = match[0].replace(TRAILING_PUNCTUATION, "");
    const start = match.index ?? 0;
    const end = start + path.length;
    // `/Users/me/My Documents/a.md` or `report(1).md`: unsure where it ends, so leave it.
    if (!FILE_EXTENSION.test(path) || !PATH_FOLLOWER.test(value.slice(end))) continue;
    matches.push({ start, end, node: { type: "inlineCode", value: path } });
  }
  for (const match of value.matchAll(BARE_DIGEST)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (matches.some((other) => start < other.end && end > other.start)) continue;
    matches.push({ start, end, node: { type: "inlineCode", value: match[0] } });
  }
  if (matches.length === 0) return null;
  matches.sort((left, right) => left.start - right.start);
  const nodes: MdNode[] = [];
  let cursor = 0;
  for (const { start, end, node } of matches) {
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    nodes.push(node);
    cursor = end;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

const SKIP_TOKENS = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

function markTokens(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return tokenNodes(child.value ?? "") ?? [child];
    if (!SKIP_TOKENS.has(child.type)) markTokens(child);
    return [child];
  });
}

function splitStatements(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "paragraph") return statementBlocks(child);
    // List items keep their lines: a split would loosen a tight list.
    if (child.type === "blockquote") splitStatements(child);
    return [child];
  });
}

/** Remark plugin for Markdown files opened in the document reader. */
export function remarkDocumentReadability() {
  return (tree: MdNode) => {
    splitStatements(tree);
    markTokens(tree);
  };
}
