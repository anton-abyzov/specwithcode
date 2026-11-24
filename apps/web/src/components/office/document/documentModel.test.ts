import type { OfficeDocument } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { contentToDocument, documentToContent, inlineToRuns } from "./documentModel";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const HASH = "a".repeat(64);

const SAMPLE: OfficeDocument = {
  blocks: [
    { type: "heading", level: 1, id: "intro", align: "center", runs: [{ text: "Title" }] },
    {
      type: "paragraph",
      align: "justify",
      runs: [
        { text: "Plain " },
        { text: "bold", bold: true },
        { text: " link", href: "https://example.com", underline: true },
        { text: " red", color: "#C00000" },
        { text: " line\nbreak", italic: true },
      ],
    },
    { type: "paragraph", runs: [] },
    {
      type: "list",
      ordered: false,
      items: [
        { level: 0, runs: [{ text: "one" }] },
        { level: 1, runs: [{ text: "one.a" }] },
        { level: 2, runs: [{ text: "one.a.i" }] },
        { level: 0, runs: [{ text: "two" }] },
        { level: 0, runs: [] },
      ],
    },
    { type: "list", ordered: true, items: [{ level: 0, runs: [{ text: "first", strike: true }] }] },
    { type: "paragraph", style: "quote", runs: [{ text: "q1" }] },
    { type: "paragraph", style: "quote", runs: [{ text: "q2" }] },
    { type: "paragraph", style: "code", runs: [{ text: "let a = 1;" }] },
    { type: "paragraph", style: "code", runs: [] },
    { type: "paragraph", style: "code", runs: [{ text: "a++;" }] },
    {
      type: "table",
      rows: [
        { cells: [{ header: true, paragraphs: [[{ text: "H1" }]] }, { header: true, paragraphs: [[]] }] },
        { cells: [{ paragraphs: [[{ text: "a" }], [{ text: "b", code: true }]] }, { paragraphs: [[]] }] },
      ],
    },
    { type: "image", src: PNG, asset: HASH, alt: "dot", width: 20, height: 10, align: "center" },
    { type: "divider" },
  ],
};

describe("document model <-> editor content", () => {
  it("round-trips the model through the editor", () => {
    expect(contentToDocument(documentToContent(SAMPLE))).toEqual(SAMPLE);
  });

  it("round-trips editor content through the model", () => {
    const content = documentToContent(SAMPLE);
    expect(documentToContent(contentToDocument(content))).toEqual(content);
  });

  it("sends pictures from the file by reference when asked", () => {
    const saved = contentToDocument(documentToContent(SAMPLE), { assetReferences: true });
    expect(saved.blocks.find((block) => block.type === "image")).toMatchObject({ src: `asset:${HASH}` });
  });

  it("keeps a hard break inside the run beside it and splits long runs", () => {
    expect(
      inlineToRuns([
        { type: "text", text: "a", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        { type: "text", text: "b", marks: [{ type: "bold" }] },
      ]),
    ).toEqual([{ text: "a\nb", bold: true }]);
    const long = inlineToRuns([{ type: "text", text: "x".repeat(70_000) }]);
    expect(long.map((run) => run.text.length)).toEqual([32_000, 32_000, 6_000]);
  });

  it("drops pictures that are not data URLs and treats left as no alignment", () => {
    const doc = contentToDocument({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://tracker.example/pixel.png" } },
        { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "x" }] },
      ],
    });
    expect(doc).toEqual({ blocks: [{ type: "paragraph", runs: [{ text: "x" }] }] });
  });

  it("flattens a nested list of another kind into its top list, and clamps level jumps", () => {
    const doc = contentToDocument({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
                {
                  type: "orderedList",
                  content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(doc.blocks).toEqual([
      { type: "list", ordered: false, items: [{ level: 0, runs: [{ text: "a" }] }, { level: 1, runs: [{ text: "b" }] }] },
    ]);
    const jumped = documentToContent({
      blocks: [{ type: "list", ordered: false, items: [{ level: 3, runs: [{ text: "deep" }] }, { level: 5, runs: [{ text: "deeper" }] }] }],
    });
    expect(contentToDocument(jumped).blocks[0]).toMatchObject({ items: [{ level: 0 }, { level: 1 }] });
  });
});
