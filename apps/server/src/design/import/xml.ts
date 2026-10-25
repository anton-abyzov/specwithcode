/**
 * A small, strict XML reader for Office Open XML parts. It builds an element
 * tree and refuses any DOCTYPE or ENTITY declaration, so a deck cannot expand
 * entities or reach external files. Only the five predefined entities and
 * numeric character references are decoded.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** Text directly inside the element, in order. */
  text: string;
}

/** A part the reader will not read: unsafe markup, or over one of `XML_LIMITS`. */
export class XmlRefused extends Error {
  readonly tooLarge: boolean;
  constructor(message: string, tooLarge = false) {
    super(message);
    this.tooLarge = tooLarge;
  }
}

/** Bounds of one XML part, so a hostile part cannot hold the CPU or fill the heap. */
export const XML_LIMITS = {
  /** Characters of one part (16 MB). */
  partChars: 16 * 1024 * 1024,
  /** Characters of one tag, its name and attributes; real Office tags are far shorter. */
  tagChars: 1024 * 1024,
  elements: 500_000,
  depth: 256,
} as const;

/** Elements allowed across every part read for one file; `used` grows as parts parse. */
export interface XmlBudget {
  readonly elements: number;
  used: number;
}

const count = (value: number) => value.toLocaleString("en-US");

const NAMED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const decode = (value: string) =>
  value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return safeCodePoint(Number.parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10), whole);
    const named = Object.hasOwn(NAMED, body) ? NAMED[body] : undefined;
    if (named === undefined) throw new XmlRefused("An XML part uses an undeclared entity.");
    return named;
  });

const safeCodePoint = (code: number, whole: string) =>
  Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;

const isNameStart = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isNameChar = (code: number) =>
  isNameStart(code) ||
  (code >= 48 && code <= 57) ||
  code === 58 || // :
  code === 46 || // .
  code === 45; // -
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;

/** The end of the name starting at `start`, or `start` when none starts there. */
function nameEnd(source: string, start: number): number {
  if (start >= source.length || !isNameStart(source.charCodeAt(start))) return start;
  let index = start + 1;
  while (index < source.length && isNameChar(source.charCodeAt(index))) index += 1;
  return index;
}

/**
 * Reads `name="value"` pairs from `inner`, starting after the tag name. One
 * forward pass: every character is looked at once, so a long run that is not
 * an attribute fails in linear time.
 */
function readAttributes(inner: string, start: number): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let index = start;
  const skipSpace = () => {
    while (index < inner.length && isSpace(inner.charCodeAt(index))) index += 1;
  };
  for (;;) {
    skipSpace();
    if (index >= inner.length) return attrs;
    const end = nameEnd(inner, index);
    if (end === index) throw new Error("Broken attribute.");
    const name = inner.slice(index, end);
    index = end;
    skipSpace();
    if (inner[index] !== "=") throw new Error("Broken attribute.");
    index += 1;
    skipSpace();
    const quote = inner[index];
    if (quote !== '"' && quote !== "'") throw new Error("Broken attribute.");
    const close = inner.indexOf(quote, index + 1);
    if (close === -1) throw new Error("Broken attribute.");
    attrs[name] = decode(inner.slice(index + 1, close));
    index = close + 1;
  }
}

/**
 * Parses one XML part; throws `XmlRefused` for a DTD, an entity or a part over
 * `XML_LIMITS` (or over the shared `budget`), `Error` for broken markup.
 */
export function parseXml(source: string, budget?: XmlBudget): XmlElement {
  if (source.length > XML_LIMITS.partChars) {
    throw new XmlRefused("An XML part is larger than 16 MB, the import limit.", true);
  }
  if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) {
    throw new XmlRefused("An XML part declares a DOCTYPE or ENTITY, which is not allowed.");
  }
  const root: XmlElement = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const allowed = Math.min(
    XML_LIMITS.elements,
    budget === undefined ? Infinity : budget.elements - budget.used,
  );
  let elements = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    const textEnd = open === -1 ? source.length : open;
    if (textEnd > index) stack.at(-1)!.text += decode(source.slice(index, textEnd));
    if (open === -1) break;
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open);
      if (end === -1) throw new Error("Unclosed processing instruction.");
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      if (end === -1) throw new Error("Unclosed comment.");
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      if (end === -1) throw new Error("Unclosed CDATA section.");
      stack.at(-1)!.text += source.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", open)) throw new XmlRefused("An XML part has a declaration.");
    const close = findTagEnd(source, open);
    const body = source.slice(open + 1, close);
    index = close + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (top === undefined || top.name !== name || stack.length === 0) {
        throw new Error(`Unexpected closing tag ${name}.`);
      }
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameLength = nameEnd(inner, 0);
    if (nameLength === 0) throw new Error("Broken tag.");
    elements += 1;
    if (elements > allowed) {
      throw new XmlRefused(
        elements > XML_LIMITS.elements
          ? `An XML part has more than ${count(XML_LIMITS.elements)} elements, the import limit.`
          : `The file's XML parts hold more than ${count(budget!.elements)} elements in all, the import limit.`,
        true,
      );
    }
    // The stack holds the root holder, so its length is the new element's depth.
    if (stack.length > XML_LIMITS.depth) {
      throw new XmlRefused(
        `An XML part nests elements more than ${XML_LIMITS.depth} deep, the import limit.`,
        true,
      );
    }
    const element: XmlElement = {
      name: inner.slice(0, nameLength),
      attrs: readAttributes(inner, nameLength),
      children: [],
      text: "",
    };
    stack.at(-1)!.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error("Unclosed element.");
  const top = root.children[0];
  if (top === undefined) throw new Error("Empty XML part.");
  if (budget !== undefined) budget.used += elements;
  return top;
}

/**
 * The index of the `>` that ends the tag starting at `open`, skipping quoted
 * values. Refuses a tag longer than `XML_LIMITS.tagChars` without reading on.
 */
function findTagEnd(source: string, open: number): number {
  let quote: string | null = null;
  const last = Math.min(source.length, open + 2 + XML_LIMITS.tagChars);
  for (let index = open + 1; index < last; index += 1) {
    const char = source[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  if (last < source.length) {
    throw new XmlRefused("An XML part has a tag longer than 1 MB, which is not allowed.");
  }
  throw new Error("Unclosed tag.");
}

/** Local name without the namespace prefix. */
export const localName = (element: XmlElement) => element.name.slice(element.name.indexOf(":") + 1);

/** The first child with this qualified name. */
export const child = (element: XmlElement | undefined, name: string) =>
  element?.children.find((candidate) => candidate.name === name);

/** All children with this qualified name. */
export const childrenNamed = (element: XmlElement | undefined, name: string) =>
  element?.children.filter((candidate) => candidate.name === name) ?? [];

/** Follows a path of qualified names through first children. */
export const path = (element: XmlElement | undefined, ...names: ReadonlyArray<string>) => {
  let current = element;
  for (const name of names) current = child(current, name);
  return current;
};

/** Every descendant with this qualified name, in document order. */
export const descendants = (element: XmlElement, name: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const kid of node.children) {
      if (kid.name === name) out.push(kid);
      visit(kid);
    }
  };
  visit(element);
  return out;
};
