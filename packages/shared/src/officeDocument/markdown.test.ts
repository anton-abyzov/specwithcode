import type { OfficeDocument } from "@specweave-studio/contracts";
import { describe, expect, it } from "vitest";

import { documentPlainText, documentToMarkdown, markdownToDocument, parseInlineMarkdown } from "./markdown.ts";

describe("office document markdown", () => {
  it("reads inline marks and links", () => {
    expect(
      parseInlineMarkdown("a **b** *c* ~~d~~ `e` <u>f</u> [g](https://x.io) [h](javascript:x) snake_case"),
    ).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", strike: true },
      { text: " " },
      { text: "e", code: true },
      { text: " " },
      { text: "f", underline: true },
      { text: " " },
      { text: "g", href: "https://x.io" },
      { text: " h snake_case" },
    ]);
  });

  it("reads blocks", () => {
    const doc = markdownToDocument(
      [
        "# Title",
        "",
        "Some text",
        "on two lines.",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```",
        "code line",
        "```",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2<br>3 |",
        "",
        "---",
        "![dot](data:image/png;base64,AAAA)",
        "<script>alert(1)</script>",
      ].join("\n"),
    );
    expect(doc.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "paragraph",
      "paragraph",
      "table",
      "divider",
      "image",
      "paragraph",
    ]);
    expect(doc.blocks[1]).toEqual({ type: "paragraph", runs: [{ text: "Some text on two lines." }] });
    expect(doc.blocks[2]).toMatchObject({ ordered: false, items: [{ level: 0 }, { level: 1 }, { level: 0 }] });
    expect(doc.blocks[4]).toMatchObject({ style: "quote" });
    expect(doc.blocks[5]).toMatchObject({ style: "code", runs: [{ text: "code line" }] });
    expect(doc.blocks[6]).toMatchObject({
      rows: [{ cells: [{ header: true }, { header: true }] }, { cells: [{}, { paragraphs: [[{ text: "2" }], [{ text: "3" }]] }] }],
    });
    // HTML stays text.
    expect(documentPlainText(doc)).toContain("<script>alert(1)</script>");
  });

  it("writes Markdown that reads back the same", () => {
    const doc: OfficeDocument = {
      blocks: [
        { type: "heading", level: 2, runs: [{ text: "Plan" }] },
        {
          type: "paragraph",
          runs: [
            { text: "Mix " },
            { text: "bold", bold: true },
            { text: " and " },
            { text: "a*star", italic: true },
            { text: " and " },
            { text: "link", href: "https://example.com" },
          ],
        },
        { type: "list", ordered: true, items: [{ level: 0, runs: [{ text: "a" }] }, { level: 1, runs: [{ text: "b" }] }] },
        { type: "paragraph", style: "code", runs: [{ text: "x = 1" }] },
        { type: "paragraph", style: "quote", runs: [{ text: "said" }] },
        {
          type: "table",
          rows: [
            { cells: [{ header: true, paragraphs: [[{ text: "H" }]] }] },
            { cells: [{ paragraphs: [[{ text: "v|w" }]] }] },
          ],
        },
        { type: "divider" },
      ],
    };
    expect(markdownToDocument(documentToMarkdown(doc))).toEqual(doc);
  });
});
