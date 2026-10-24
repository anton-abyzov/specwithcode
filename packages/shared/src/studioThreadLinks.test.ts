import { describe, expect, it } from "vite-plus/test";

import {
  formatStudioThreadHref,
  formatStudioThreadLink,
  parseStudioThreadHref,
  parseStudioThreadTarget,
  threadIdNearMisses,
} from "./studioThreadLinks.ts";

const DELEGATED = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Areview%2520round)2";

describe("studio thread links", () => {
  it("escapes the characters encodeURIComponent leaves, so a link never ends early", () => {
    const href = formatStudioThreadHref(`${DELEGATED}(!*')`);
    expect(href).not.toMatch(/[()!*']/);
    expect(href).toContain("%29");
    expect(parseStudioThreadHref(href)?.[0]).toBe(`${DELEGATED}(!*')`);
  });

  it("builds a Markdown link whose target is the whole encoded ID", () => {
    const link = formatStudioThreadLink(DELEGATED, "Review (round 2)");
    const match = /^\[([^\]]+)\]\((studio:\/\/thread\/[^)\s]+)\)$/.exec(link);
    expect(match?.[1]).toBe("Review (round 2)");
    expect(parseStudioThreadHref(match![2]!)?.[0]).toBe(DELEGATED);
  });

  it("reads a raw ID pasted with its percent escapes after the decoded form", () => {
    expect(parseStudioThreadHref(`studio://thread/${DELEGATED}`)).toEqual([
      "thread:delegated-task:command:mcp:a1:delegate-task:review%20round)2",
      DELEGATED,
    ]);
  });

  it("rejects anything but one safe path segment", () => {
    for (const href of [
      "studio://thread/",
      "studio://thread/a/b",
      "studio://thread/a#latest",
      "studio://thread/a?x=1",
      "studio://thread/..",
      `studio://thread/${"a".repeat(1025)}`,
    ])
      expect(parseStudioThreadHref(href)).toBeNull();
  });
});

describe("links to a thread on another machine", () => {
  it("names the machine's environment before the thread, both encoded", () => {
    const href = formatStudioThreadHref("thread:1)", "env:m1");
    expect(href).toBe("studio://thread/env%3Am1/thread%3A1%29");
    expect(parseStudioThreadTarget(href)).toEqual({
      environmentId: "env:m1",
      candidates: ["thread:1)", "thread%3A1%29"],
    });
    expect(formatStudioThreadLink("b-thread", "Fix [CI]", "env-m1")).toBe(
      "[Fix CI](studio://thread/env-m1/b-thread)",
    );
  });

  it("reads a one-segment link as this machine's and keeps the one-segment parser strict", () => {
    expect(parseStudioThreadTarget("studio://thread/abc")).toEqual({
      environmentId: null,
      candidates: ["abc"],
    });
    expect(parseStudioThreadHref("studio://thread/env-m1/abc")).toBeNull();
  });

  it("rejects extra segments and unsafe machine segments", () => {
    for (const href of [
      "studio://thread/a/b/c",
      "studio://thread//b",
      "studio://thread/../b",
      "studio://thread/a/",
      "studio://thread/%E0%A4%A/b",
      "https://example.com/a/b",
    ])
      expect(parseStudioThreadTarget(href)).toBeNull();
  });
});

describe("thread IDs an agent probably meant", () => {
  const AUDIT =
    "thread:delegated-task:command%3Amcp%3Ad25698a7-ed07-4574-a0b9-f1d8a6122b58%3Adelegate-task%3Aeasychamp-full-handoff-audit-20261022";

  it("restores the thread: prefix read as a label in prose", () => {
    expect(threadIdNearMisses(AUDIT.slice("thread:".length))[0]).toBe(AUDIT);
  });

  it("re-encodes a decoded delegated-task ID, with or without its prefix", () => {
    const decoded = decodeURIComponent(AUDIT);
    expect(threadIdNearMisses(decoded)[0]).toBe(AUDIT);
    expect(threadIdNearMisses(decoded.slice("thread:".length))[0]).toBe(AUDIT);
  });

  it("re-encodes a command ID that itself carries an escape", () => {
    // DELEGATED's command ID holds `%20` encoded once more; fully decoded, it must not decode again.
    expect(threadIdNearMisses(decodeURIComponent(DELEGATED))).toContain(DELEGATED);
  });

  it("drops the sentence's closing punctuation, quoting and inner spaces", () => {
    expect(threadIdNearMisses(`"${AUDIT} ".`)).toContain(AUDIT);
    expect(threadIdNearMisses(`${AUDIT}.`)).toContain(AUDIT);
    expect(threadIdNearMisses(`\`${AUDIT}\``)).toContain(AUDIT);
  });

  it("never offers the ID it was given or touches coordinator IDs", () => {
    expect(threadIdNearMisses(AUDIT)).not.toContain(AUDIT);
    expect(threadIdNearMisses("project-coordinator:p1")).toEqual([]);
  });

  it("cannot rebuild a delegated task's thread from its command ID alone", () => {
    expect(threadIdNearMisses("mcp:d25698a7-ed07-4574-a0b9-f1d8a6122b58")).toEqual([
      "thread:mcp:d25698a7-ed07-4574-a0b9-f1d8a6122b58",
    ]);
  });
});
