import { markdownDocument } from "@specweave-studio/shared/reportDocument";
import { describe, expect, it } from "vite-plus/test";

import { artifactTintIndex } from "./artifactPreview";
import { markdownPage } from "./artifactPreviewMarkdown";

describe("markdownPage", () => {
  it("lays a file out as the viewer does: title, facts, body and tables", () => {
    const page = markdownPage(
      [
        "---",
        "date: 2026-10-30",
        "---",
        "# Review",
        "",
        "The **shelf** ships.",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(page.title).toBe("Review");
    expect(page.html).toContain("<h1>Review</h1>");
    expect(page.html).toContain("<dt>");
    expect(page.html).toContain("<strong>shelf</strong>");
    expect(page.html).toContain("<table>");
  });

  it("takes the title from a file with no frontmatter, only from its opening", () => {
    expect(markdownPage("# Plan\n\nText").title).toBe("Plan");
    expect(markdownPage("\n\n# Plan").title).toBe("Plan");
    expect(markdownPage("Text first\n\n# Later").title).toBeNull();
    expect(markdownPage("```bash\n# install deps\n```").title).toBeNull();
    expect(markdownPage("    # indented code").title).toBeNull();
    expect(markdownPage("Intro\r\n\r\n```sh\r\n# a comment").title).toBeNull();
  });

  it("finds the title after a byte order mark", () => {
    expect(markdownPage("\uFEFF# Marked\n\nText").title).toBe("Marked");
  });

  it("keeps a heading as written", () => {
    expect(markdownPage("# add_user_api design").title).toBe("add_user_api design");
    expect(markdownPage("# Learn C#").title).toBe("Learn C#");
  });

  it("stays fast on a heading of spaces", () => {
    const started = performance.now();
    markdownPage(`# a${" ".repeat(20_000)}b`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stays fast on hostile headings under frontmatter", () => {
    for (const line of [`# a${" ".repeat(100_000)}b`, `# ${"**a ".repeat(25_000)}`]) {
      const started = performance.now();
      markdownPage(`---\nid: x\n---\n${line}`);
      expect(performance.now() - started).toBeLessThan(500);
    }
    for (const title of ["[".repeat(100_000), "**a ".repeat(25_000)]) {
      const started = performance.now();
      markdownPage(`---\ntitle: ${title}\n---\nBody`);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("keeps the whole of a long title in the document", () => {
    const title = `${"word ".repeat(100)}END`;
    expect(markdownDocument(`---\ntitle: ${title}\n---\nBody`).title).toBe(title);
  });

  it("keeps the title past a long frontmatter, and drops raw HTML", () => {
    const fields = Array.from({ length: 300 }, (_, n) => `key${n}: value ${n}`).join("\n");
    const long = markdownPage(`---\n${fields}\n---\n# Real title\n\nBody`);
    expect(long.title).toBe("Real title");
    expect(markdownPage("<!-- generated -->\n\nText").html).not.toContain("generated");
  });

  it("holds nothing that loads, links or runs", () => {
    const { html } = markdownPage(
      "![x](https://example.com/a.png)\n\n[link](https://example.com)\n\n<script>alert(1)</script>",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href");
    expect(html).not.toContain("<script");
    expect(html).toContain("link");
  });

  it("reads only the start of a long file", () => {
    const { html } = markdownPage(`# Long\n\n${"word ".repeat(50_000)}`);
    expect(html.length).toBeLessThan(8000);
  });
});

describe("artifactTintIndex", () => {
  it("keeps one tint per file and spreads files across them", () => {
    expect(artifactTintIndex("file:a.md")).toBe(artifactTintIndex("file:a.md"));
    const tints = new Set(Array.from({ length: 40 }, (_, n) => artifactTintIndex(`file:${n}.md`)));
    expect(tints.size).toBeGreaterThan(2);
    for (const tint of tints) expect(tint).toBeGreaterThanOrEqual(0);
  });
});
