import { noteReaderScroll, noteReaderScrollAround } from "../../lib/readerScroll";

export const FIND_SCOPE_ATTRIBUTE = "data-conversation-find-scope";
export const FIND_IGNORE_ATTRIBUTE = "data-conversation-find-ignore";
/**
 * Text under this attribute is one run, though `<wbr>` or word boxes split it into several
 * text nodes: `report-final` matches a wrapped value split after `report-`.
 */
export const FIND_JOINED_TEXT_ATTRIBUTE = "data-path-wrap";
export const FIND_HIGHLIGHT = "studio-find";
export const FIND_CURRENT_HIGHLIGHT = "studio-find-current";
/** Past this many hits the count stops growing; nobody steps through more. */
export const MAX_FIND_MATCHES = 1000;

function foldCase(value: string): string {
  return value.toLocaleLowerCase();
}

/** Start offsets of every case-insensitive, non-overlapping occurrence of `query` in `text`. */
export function findTextOffsets(text: string, query: string, limit = MAX_FIND_MATCHES): number[] {
  if (query.length === 0 || text.length < query.length) return [];
  const haystack = foldCase(text);
  const needle = foldCase(query);
  // Case folding can change length (e.g. "İ"); offsets would then point at the wrong text.
  if (haystack.length !== text.length || needle.length !== query.length) return [];
  const offsets: number[] = [];
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1 && offsets.length < limit) {
    offsets.push(cursor);
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return offsets;
}

export function textMatchesQuery(text: string, query: string): boolean {
  const needle = query.trim();
  return needle.length > 0 && foldCase(text).includes(foldCase(needle));
}

/** Steps through `count` matches, wrapping at either end; -1 when there is nothing to step to. */
export function stepMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

export function findCountLabel(current: number, count: number, capped: boolean): string {
  if (count === 0) return "No results";
  const total = capped ? `${count}+` : String(count);
  return `${current >= 0 ? current + 1 : 0} of ${total}`;
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "SVG"]);

function isElementSearchable(element: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let searchable = true;
  if (
    SKIPPED_TAGS.has(element.tagName.toUpperCase()) ||
    element.hasAttribute(FIND_IGNORE_ATTRIBUTE)
  ) {
    searchable = false;
  } else if (element.parentElement && !element.hasAttribute(FIND_SCOPE_ATTRIBUTE)) {
    searchable = isElementSearchable(element.parentElement, cache);
  }
  cache.set(element, searchable);
  return searchable;
}

function isRendered(element: Element): boolean {
  const check = (element as HTMLElement).checkVisibility;
  if (typeof check !== "function") return true;
  return check.call(element, { visibilityProperty: true });
}

/** The outermost joined-text element holding `element`, below `root`. */
function joinedTextOwner(
  element: Element,
  root: Element,
  cache: Map<Element, Element | null>,
): Element | null {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const above =
    element === root || !element.parentElement
      ? null
      : joinedTextOwner(element.parentElement, root, cache);
  const owner = above ?? (element.hasAttribute(FIND_JOINED_TEXT_ATTRIBUTE) ? element : null);
  cache.set(element, owner);
  return owner;
}

interface TextRun {
  readonly nodes: ReadonlyArray<Text>;
  /** Where each node starts in `text`. */
  readonly starts: ReadonlyArray<number>;
  readonly text: string;
}

/** The node and offset at `position` in the run; an end position stays in the node it ends. */
function runPosition(run: TextRun, position: number, isEnd: boolean): [Text, number] {
  let index = run.nodes.length - 1;
  for (let candidate = 0; candidate < run.nodes.length; candidate += 1) {
    const end = run.starts[candidate]! + run.nodes[candidate]!.length;
    if (isEnd ? position <= end : position < end) {
      index = candidate;
      break;
    }
  }
  return [run.nodes[index]!, position - run.starts[index]!];
}

/** Ranges for every visible occurrence of `query` under `root`, in reading (top-to-bottom) order. */
export function collectFindRanges(
  root: Element,
  query: string,
  limit = MAX_FIND_MATCHES,
): { ranges: Range[]; capped: boolean } {
  const needle = query.trim();
  if (needle.length === 0) return { ranges: [], capped: false };
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const searchable = new Map<Element, boolean>();
  const visible = new Map<Element, boolean>();
  const owners = new Map<Element, Element | null>();
  const joined = new Set<Element>();
  const ranges: Range[] = [];
  let capped = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent) continue;
    const owner = joinedTextOwner(parent, root, owners);
    if (owner !== null && joined.has(owner)) continue;
    let run: TextRun;
    if (owner === null) {
      run = { nodes: [node as Text], starts: [0], text: node.nodeValue ?? "" };
    } else {
      joined.add(owner);
      const nodes: Text[] = [];
      const starts: number[] = [];
      let text = "";
      const inner = doc.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
      for (let part = inner.nextNode(); part; part = inner.nextNode()) {
        if (!part.parentElement || !isElementSearchable(part.parentElement, searchable)) continue;
        nodes.push(part as Text);
        starts.push(text.length);
        text += part.nodeValue ?? "";
      }
      if (nodes.length === 0) continue;
      run = { nodes, starts, text };
    }
    if (run.text.length < needle.length) continue;
    const scopeElement = owner ?? parent;
    if (!isElementSearchable(scopeElement, searchable)) continue;
    const offsets = findTextOffsets(run.text, needle, limit - ranges.length + 1);
    if (offsets.length === 0) continue;
    let shown = visible.get(scopeElement);
    if (shown === undefined) {
      shown = isRendered(scopeElement);
      visible.set(scopeElement, shown);
    }
    if (!shown) continue;
    for (const offset of offsets) {
      if (ranges.length >= limit) {
        capped = true;
        break;
      }
      const range = doc.createRange();
      range.setStart(...runPosition(run, offset, false));
      range.setEnd(...runPosition(run, offset + needle.length, true));
      ranges.push(range);
    }
    if (capped) break;
  }
  return { ranges: sortRangesByPosition(ranges), capped };
}

/**
 * Virtualized lists recycle row containers, so DOM order can differ from what the reader sees.
 * Sorting by on-screen position keeps "next" going down the page.
 */
function sortRangesByPosition(ranges: Range[]): Range[] {
  if (ranges.length < 2 || typeof ranges[0]?.getBoundingClientRect !== "function") return ranges;
  const keyed = ranges.map((range, index) => {
    const rect = range.getBoundingClientRect();
    return { range, top: rect.top, left: rect.left, index };
  });
  keyed.sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index);
  return keyed.map((entry) => entry.range);
}

function isScrollable(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight
  );
}

export function scrollContainerOf(element: Element): Element | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (isScrollable(node)) return node;
  }
  return null;
}

/** Centers a match in its scroll container when it sits outside the visible band. */
export function scrollRangeIntoView(range: Range): void {
  const anchor = range.startContainer.parentElement;
  if (!anchor) return;
  const container = scrollContainerOf(anchor);
  if (!container) {
    noteReaderScrollAround(anchor);
    anchor.scrollIntoView({ block: "center" });
    return;
  }
  const rect = range.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  const margin = Math.min(80, bounds.height / 4);
  if (rect.top >= bounds.top + margin && rect.bottom <= bounds.bottom - margin) return;
  noteReaderScroll(container);
  container.scrollTop += rect.top - (bounds.top + bounds.height / 2 - rect.height / 2);
}

function visibleArea(element: Element): number {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const width = Math.max(
    0,
    Math.min(rect.right, view?.innerWidth ?? rect.right) - Math.max(rect.left, 0),
  );
  const height = Math.max(
    0,
    Math.min(rect.bottom, view?.innerHeight ?? rect.bottom) - Math.max(rect.top, 0),
  );
  return width * height;
}

/**
 * The conversation Cmd+F should search: the one the reader last clicked or focused in,
 * otherwise the largest one on screen.
 */
export function pickFindScope(doc: Document, lastInteraction: Node | null): HTMLElement | null {
  const scopes = Array.from(doc.querySelectorAll<HTMLElement>(`[${FIND_SCOPE_ATTRIBUTE}]`)).filter(
    (scope) => scope.getClientRects().length > 0,
  );
  if (scopes.length === 0) return null;
  for (const target of [lastInteraction, doc.activeElement]) {
    if (!target) continue;
    const owner = scopes.find((scope) => scope.contains(target));
    if (owner) return owner;
  }
  return scopes.reduce((best, scope) => (visibleArea(scope) > visibleArea(best) ? scope : best));
}
