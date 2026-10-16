import { type RefObject, useCallback, useEffect, useState } from "react";

export interface OutlineHeading {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

const HEADING_SELECTOR = "h1, h2, h3, h4";
/** How far below the top of the page a heading counts as the one being read. */
const ACTIVE_OFFSET = 96;

/**
 * The document's headings, read from what it rendered, and the one being read.
 * Ids are assigned here so the outline can scroll to any of them.
 */
export function useDocumentOutline(
  scrollRef: RefObject<HTMLElement | null>,
  articleRef: RefObject<HTMLElement | null>,
  revision: unknown,
): {
  readonly headings: ReadonlyArray<OutlineHeading>;
  readonly activeId: string | null;
  readonly scrollTo: (id: string) => void;
} {
  const [headings, setHeadings] = useState<ReadonlyArray<OutlineHeading>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const read = () => {
      const next = [...article.querySelectorAll<HTMLElement>(HEADING_SELECTOR)].flatMap(
        (element, index) => {
          const text = element.textContent?.trim() ?? "";
          if (text.length === 0) return [];
          if (!element.id) element.id = `report-heading-${index}`;
          return [{ id: element.id, text, level: Number(element.tagName.slice(1)) }];
        },
      );
      setHeadings((previous) =>
        previous.length === next.length &&
        previous.every((heading, index) => heading.id === next[index]!.id)
          ? previous
          : next,
      );
    };
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    observer.observe(article, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [articleRef, revision]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || headings.length === 0) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top + ACTIVE_OFFSET;
      let current: string | null = headings[0]!.id;
      for (const heading of headings) {
        const element = scroller.ownerDocument.getElementById(heading.id);
        if (element && element.getBoundingClientRect().top <= top) current = heading.id;
      }
      setActiveId(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [headings, scrollRef]);

  const scrollTo = useCallback(
    (id: string) => {
      const element = scrollRef.current?.ownerDocument.getElementById(id);
      element?.scrollIntoView({ block: "start", behavior: "smooth" });
      setActiveId(id);
    },
    [scrollRef],
  );
  return { headings, activeId, scrollTo };
}

const FIND_HIGHLIGHT = "report-find";
const FIND_CURRENT_HIGHLIGHT = "report-find-current";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightRegistry(): {
  readonly registry: HighlightRegistry;
  readonly Highlight: new (...ranges: Range[]) => unknown;
} | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

/** Every case-insensitive match of `query` in the element's text. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase() ?? "";
    for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Find in the document: matches are painted with the CSS Custom Highlight API,
 * so the rendered markdown is never rewritten, and the current one is scrolled
 * into view.
 */
export function useFindInDocument(
  articleRef: RefObject<HTMLElement | null>,
  query: string,
  revision: unknown,
): { readonly count: number; readonly index: number; readonly step: (by: 1 | -1) => void } {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const article = articleRef.current;
    setRanges(article ? findTextRanges(article, query) : []);
    setIndex(0);
  }, [articleRef, query, revision]);

  useEffect(() => {
    const highlights = highlightRegistry();
    if (!highlights) return;
    const current = ranges[index];
    highlights.registry.set(FIND_HIGHLIGHT, new highlights.Highlight(...ranges));
    if (current) {
      highlights.registry.set(FIND_CURRENT_HIGHLIGHT, new highlights.Highlight(current));
      current.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else {
      highlights.registry.delete(FIND_CURRENT_HIGHLIGHT);
    }
    return () => {
      highlights.registry.delete(FIND_HIGHLIGHT);
      highlights.registry.delete(FIND_CURRENT_HIGHLIGHT);
    };
  }, [index, ranges]);

  const step = useCallback(
    (by: 1 | -1) => {
      if (ranges.length === 0) return;
      setIndex((previous) => (previous + by + ranges.length) % ranges.length);
    },
    [ranges.length],
  );
  return { count: ranges.length, index, step };
}

/** A file name for the report: its title, lowercased and hyphenated. */
export function reportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "report"}.md`;
}
