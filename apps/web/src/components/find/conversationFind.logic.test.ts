// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  FIND_IGNORE_ATTRIBUTE,
  FIND_SCOPE_ATTRIBUTE,
  collectFindRanges,
  findCountLabel,
  findTextOffsets,
  pickFindScope,
  stepMatchIndex,
  textMatchesQuery,
} from "./conversationFind.logic";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTextOffsets", () => {
  it("finds case-insensitive, non-overlapping hits", () => {
    expect(findTextOffsets("Merge main, then MAIN again", "main")).toEqual([6, 17]);
    expect(findTextOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  it("returns nothing for an empty query or one longer than the text", () => {
    expect(findTextOffsets("text", "")).toEqual([]);
    expect(findTextOffsets("ab", "abc")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(findTextOffsets("x x x x", "x", 2)).toEqual([0, 2]);
  });
});

describe("textMatchesQuery", () => {
  it("ignores case and surrounding spaces, and never matches an empty query", () => {
    expect(textMatchesQuery("Release macOS app", "  MACOS ")).toBe(true);
    expect(textMatchesQuery("Release macOS app", "linux")).toBe(false);
    expect(textMatchesQuery("anything", "   ")).toBe(false);
  });
});

describe("stepMatchIndex", () => {
  it("wraps in both directions", () => {
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(1, 3, 1)).toBe(2);
  });

  it("starts from the matching end when nothing is selected", () => {
    expect(stepMatchIndex(-1, 4, 1)).toBe(0);
    expect(stepMatchIndex(-1, 4, -1)).toBe(3);
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
  });
});

describe("findCountLabel", () => {
  it("reads like a browser find bar", () => {
    expect(findCountLabel(-1, 0, false)).toBe("No results");
    expect(findCountLabel(0, 12, false)).toBe("1 of 12");
    expect(findCountLabel(4, 1000, true)).toBe("5 of 1000+");
  });
});

describe("collectFindRanges", () => {
  it("finds hits across elements and skips ignored, hidden and form text", () => {
    document.body.innerHTML = `
      <div ${FIND_SCOPE_ATTRIBUTE}>
        <p>The banner <strong>overlap</strong> is fixed.</p>
        <p>Overlap twice: overlap.</p>
        <div ${FIND_IGNORE_ATTRIBUTE}>overlap in a toolbar</div>
        <textarea>overlap draft</textarea>
        <style>.overlap {}</style>
      </div>`;
    const scope = document.querySelector(`[${FIND_SCOPE_ATTRIBUTE}]`)!;
    const { ranges, capped } = collectFindRanges(scope, "OVERLAP");
    expect(capped).toBe(false);
    expect(ranges.map((range) => range.toString())).toEqual(["overlap", "Overlap", "overlap"]);
  });

  it("caps the number of ranges", () => {
    document.body.innerHTML = `<div ${FIND_SCOPE_ATTRIBUTE}><p>a a a a a</p></div>`;
    const scope = document.querySelector(`[${FIND_SCOPE_ATTRIBUTE}]`)!;
    const result = collectFindRanges(scope, "a", 3);
    expect(result.ranges).toHaveLength(3);
    expect(result.capped).toBe(true);
  });

  it("returns nothing for a blank query", () => {
    document.body.innerHTML = `<div ${FIND_SCOPE_ATTRIBUTE}><p>text</p></div>`;
    const scope = document.querySelector(`[${FIND_SCOPE_ATTRIBUTE}]`)!;
    expect(collectFindRanges(scope, "  ").ranges).toEqual([]);
  });
});

describe("pickFindScope", () => {
  it("prefers the conversation the reader last interacted with", () => {
    document.body.innerHTML = `
      <div id="coordinator" ${FIND_SCOPE_ATTRIBUTE}><p id="a">coordinator</p></div>
      <div id="thread" ${FIND_SCOPE_ATTRIBUTE}><p id="b">thread</p></div>`;
    for (const element of document.querySelectorAll(`[${FIND_SCOPE_ATTRIBUTE}]`)) {
      element.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    }
    expect(pickFindScope(document, document.getElementById("b"))?.id).toBe("thread");
    expect(pickFindScope(document, document.getElementById("a"))?.id).toBe("coordinator");
  });

  it("returns null when no conversation is on screen", () => {
    document.body.innerHTML = `<main><p>pull requests</p></main>`;
    expect(pickFindScope(document, null)).toBeNull();
  });
});
