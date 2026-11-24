import type { OfficeDocument } from "@specweave-studio/contracts";
import { DOCUMENT_LIMITS } from "@specweave-studio/contracts";
import JSZip from "jszip";
import { describe, expect, it } from "@effect/vitest";

import { openDocxForEditing } from "./docxEdit.ts";
import { buildDocx } from "./docxExport.ts";

const STYLE_LOSS = "Paragraph styles from the file's template (become plain paragraphs)";
const FOOTER =
  '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer text</w:t></w:r></w:p></w:ftr>';
const FOOTER_REL =
  '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';

async function edit(
  parts: (zip: JSZip) => Promise<void>,
  blocks: OfficeDocument["blocks"] = [],
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await buildDocx({ blocks }));
  await parts(zip);
  return zip.generateAsync({ type: "uint8array" });
}

const replacePart = async (zip: JSZip, name: string, from: string, to: string) => {
  const text = await zip.file(name)!.async("string");
  expect(text).toContain(from);
  zip.file(name, text.replace(from, to));
};

/** A file whose one paragraph uses a style defined by `styles`. */
const styled = (styles: string, styleId = "BodyText") =>
  edit(async (zip) => {
    await replacePart(zip, "word/styles.xml", "</w:styles>", `${styles}</w:styles>`);
    await replacePart(
      zip,
      "word/document.xml",
      "<w:body>",
      `<w:body><w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>Styled</w:t></w:r></w:p>`,
    );
  });

describe("what a save would drop: template styles", () => {
  it.each([
    ["a size", '<w:rPr><w:sz w:val="36"/></w:rPr>', ""],
    ["a font", '<w:rPr><w:rFonts w:ascii="Georgia"/></w:rPr>', ""],
    [
      "bold from the style it is based on",
      '<w:basedOn w:val="Strong"/>',
      '<w:style w:type="paragraph" w:styleId="Strong"><w:name w:val="Strong Body"/><w:rPr><w:b/></w:rPr></w:style>',
    ],
    ["an indent", '<w:pPr><w:ind w:left="720"/></w:pPr>', ""],
  ])("names a body style that sets %s", async (_label, look, extra) => {
    const bytes = await styled(
      `${extra}<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/>${look}</w:style>`,
    );
    expect((await openDocxForEditing(bytes)).lossOnSave).toContain(STYLE_LOSS);
  });

  it("lets a body style with only spacing go quietly, through its chain to the default style", async () => {
    const bytes = await styled(
      '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:lang w:val="en-GB"/></w:rPr></w:style>',
    );
    expect((await openDocxForEditing(bytes)).lossOnSave).not.toContain(STYLE_LOSS);
  });
});

describe("relationships the writer keeps", () => {
  it("keeps every relationship when a comment follows the closing tag", async () => {
    const base = await edit(async (zip) => {
      zip.file("word/footer1.xml", FOOTER);
      await replacePart(
        zip,
        "word/_rels/document.xml.rels",
        "</Relationships>",
        `${FOOTER_REL}</Relationships><!-- written by another tool -->`,
      );
    });
    const saved = await buildDocx(
      { blocks: [{ type: "paragraph", runs: [{ text: "x", href: "https://example.com" }] }] },
      { base },
    );
    const rels = await (await JSZip.loadAsync(saved)).file("word/_rels/document.xml.rels")!.async("string");
    expect(rels).toContain('Id="rIdFooter"');
    expect(rels).toContain("https://example.com");
    expect(rels.indexOf("https://example.com")).toBeLessThan(rels.lastIndexOf("</Relationships>"));
  });

  it("refuses to save over a relationships part it cannot read, rather than rebuild it", async () => {
    const base = await edit(async (zip) => {
      zip.file("word/footer1.xml", FOOTER);
      zip.file(
        "word/_rels/document.xml.rels",
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${FOOTER_REL}`,
      );
    });
    await expect(
      buildDocx({ blocks: [{ type: "paragraph", runs: [{ text: "x" }] }] }, { base }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("block limits on reopen", () => {
  it("refuses a document whose table spacers would push it past the limit", async () => {
    const table = { type: "table" as const, rows: [{ cells: [{ paragraphs: [[{ text: "c" }]] }] }] };
    const blocks: OfficeDocument["blocks"] = [
      ...Array.from({ length: DOCUMENT_LIMITS.blocks - 2 }, () => ({
        type: "paragraph" as const,
        runs: [{ text: "p" }],
      })),
      table,
      table,
    ];
    await expect(buildDocx({ blocks })).rejects.toMatchObject({ code: "too_large" });
  });

  it("never opens more blocks than the limit when a list ends at it, and says the rest was cut", async () => {
    const paragraph = "<w:p><w:r><w:t>p</w:t></w:r></w:p>";
    const listItem =
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>';
    const base = await buildDocx({
      blocks: [{ type: "list", ordered: false, items: [{ level: 0, runs: [{ text: "seed" }] }] }],
    });
    const numId = /<w:numId w:val="(\d+)"/.exec(
      await (await JSZip.loadAsync(base)).file("word/document.xml")!.async("string"),
    )![1]!;
    const bytes = await (async () => {
      const zip = await JSZip.loadAsync(base);
      const xml = await zip.file("word/document.xml")!.async("string");
      const body =
        paragraph.repeat(DOCUMENT_LIMITS.blocks - 1) + listItem.replace('w:val="1"/>', `w:val="${numId}"/>`) + paragraph;
      zip.file("word/document.xml", xml.replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`));
      return zip.generateAsync({ type: "uint8array" });
    })();
    const opened = await openDocxForEditing(bytes);
    expect(opened.document.blocks.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.blocks);
    expect(opened.lossOnSave).toContain("Content past the editor's size limit");
  });
});

describe("numbered lists", () => {
  it("names a list that starts past 1", async () => {
    const base = await buildDocx({
      blocks: [{ type: "list", ordered: true, items: [{ level: 0, runs: [{ text: "seventh" }] }] }],
    });
    const zip = await JSZip.loadAsync(base);
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    expect(numbering).toContain('<w:startOverride w:val="1"/>');
    zip.file("word/numbering.xml", numbering.replaceAll('<w:startOverride w:val="1"/>', '<w:startOverride w:val="7"/>'));
    const opened = await openDocxForEditing(await zip.generateAsync({ type: "uint8array" }));
    expect(opened.lossOnSave).toContain("Numbered lists that start past 1 (they start at 1)");
    expect((await openDocxForEditing(base)).lossOnSave).toEqual([]);
  });
});
