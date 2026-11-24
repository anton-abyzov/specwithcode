import { describe, expect, it } from "vite-plus/test";

import {
  confirmedFileLink,
  confirmedFileLinks,
  isBareFileNameSpan,
  resolveInlineCodeFileLinks,
} from "./markdown-links";

const CWD = "/Users/me/Projects/umbrella";

describe("bare file names", () => {
  it("knows a bare name from a path", () => {
    expect(isBareFileNameSpan("llms.txt")).toBe(true);
    expect(isBareFileNameSpan("app.ts:12")).toBe(true);
    expect(isBareFileNameSpan("docs/llms.txt")).toBe(false);
    expect(isBareFileNameSpan("~/notes.md")).toBe(false);
    expect(isBareFileNameSpan("C:\\notes.md")).toBe(false);
  });

  it("holds a bare name, and a line after it, until the host confirms it", () => {
    const links = resolveInlineCodeFileLinks(["llms.txt", ":12", "docs/page.md"], CWD);
    expect(links.get("llms.txt")?.requiresHost).toBe(true);
    expect(links.get(":12")?.requiresHost).toBe(true);
    expect(links.get("docs/page.md")?.requiresHost).toBeUndefined();
    expect([...confirmedFileLinks(links).keys()]).toEqual(["docs/page.md"]);
  });

  it("keeps only the confirmed files of shorthand", () => {
    const links = resolveInlineCodeFileLinks(["findings-{B,C}.md"], CWD);
    const shorthand = links.get("findings-{B,C}.md")!;
    expect(confirmedFileLink(shorthand)?.expansions).toEqual([]);
  });
});
