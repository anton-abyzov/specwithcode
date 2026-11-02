import { describe, expect, it } from "vite-plus/test";

import {
  canonicalSides,
  commonAncestors,
  hasClashMarkers,
  mergeThreeWay,
} from "./linkedMemoryThreeWay.ts";

const merge = (base: string | null, left: string, right: string) =>
  mergeThreeWay(base, { label: "m4", content: left }, { label: "ministorm", content: right });

describe("mergeThreeWay", () => {
  it("merges edits on different lines", () => {
    expect(merge("a\nb\nc\nd\n", "A\nb\nc\nd\n", "a\nb\nc\nD\n")).toBe("A\nb\nc\nD\n");
  });

  it("merges a change on the line next to the other side's change", () => {
    expect(merge("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n")).toBe("A\nB\nc\n");
  });

  it("keeps both lines when each side appends to an index", () => {
    expect(merge("- one\n", "- one\n- two\n", "- one\n- three\n")).toBe("- one\n- two\n- three\n");
  });

  it("keeps a line once when both sides made the same edit", () => {
    expect(merge("a\nb\n", "a\nX\n", "a\nX\n")).toBe("a\nX\n");
  });

  it("takes a deletion against an untouched region", () => {
    expect(merge("a\nb\nc\n", "a\nc\n", "a\nb\nC\n")).toBe("a\nC\n");
  });

  it("marks a real clash inside the one file, leaving the merged parts clean", () => {
    const merged = merge("a\nb\nmid\nc\nz\n", "A\nb\nleft\nc\nz\n", "a\nb\nright\nc\nZ\n");
    expect(merged).toBe("A\nb\n<<<<<<< m4\nleft\n=======\nright\n>>>>>>> ministorm\nc\nZ\n");
    expect(hasClashMarkers(merged)).toBe(true);
  });

  it("makes one clash of two versions with no shared base", () => {
    const merged = merge(null, "left", "right");
    expect(merged).toBe("<<<<<<< m4\nleft\n=======\nright\n>>>>>>> ministorm\n");
    expect(hasClashMarkers(merged)).toBe(true);
  });

  it("sees a clash in a file with Windows line endings", () => {
    expect(hasClashMarkers("<<<<<<< m4\r\nleft\r\n=======\r\nright\r\n>>>>>>> storm\r\n")).toBe(
      true,
    );
  });

  it("keeps two lines apart when an edit ends without a newline", () => {
    expect(merge("a\nb\n", "a\nb\nc\n", "a\nq")).toBe("a\nq\nc\n");
  });

  it("merges two additions to an empty file", () => {
    expect(merge("", "left\n", "right\n")).toBe("left\nright\n");
  });

  it("does not take ordinary text for a clash", () => {
    expect(hasClashMarkers("a\n=======\nb\n")).toBe(false);
  });

  it("writes the same bytes from either machine", () => {
    const m4 = { environmentId: "a", label: "m4", content: "x\nfrom m4\n" };
    const storm = { environmentId: "b", label: "ministorm", content: "x\nfrom storm\n" };
    const [first, second] = canonicalSides(m4, storm);
    const [third, fourth] = canonicalSides(storm, m4);
    expect(mergeThreeWay("x\n", first, second)).toBe(mergeThreeWay("x\n", third, fourth));
  });
});

describe("commonAncestors", () => {
  it("is the newest version both sides have had", () => {
    expect(commonAncestors(["a", "b", "m"], ["a", "b", "t"])).toEqual(["b", "a"]);
    expect(commonAncestors(["m"], ["t"])).toEqual([]);
  });

  it("names one base from either machine once the pair's sides are ordered", () => {
    const m4 = { environmentId: "a", history: ["x", "y"] };
    const storm = { environmentId: "b", history: ["y", "x"] };
    const base = (one: typeof m4, other: typeof m4) => {
      const [first, second] = canonicalSides(one, other);
      return commonAncestors(first.history, second.history);
    };
    expect(base(m4, storm)).toEqual(base(storm, m4));
  });
});
