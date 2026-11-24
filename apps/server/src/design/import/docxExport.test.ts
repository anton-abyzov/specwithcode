// @effect-diagnostics nodeBuiltinImport:off - Runs LibreOffice in a private scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { OfficeDocument } from "@specweave-studio/contracts";
import JSZip from "jszip";
import { describe, expect, it } from "@effect/vitest";

import { openDocxForEditing } from "./docxEdit.ts";
import { bodySectionXml, buildDocx, DocxWriteError } from "./docxExport.ts";

// A 2x1 red PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGGEMAD3uA/+qpKUMAAAAAElFTkSuQmCC";

const SAMPLE: OfficeDocument = {
  blocks: [
    { type: "heading", level: 1, id: "intro", runs: [{ text: "Quarterly plan" }] },
    {
      type: "paragraph",
      runs: [
        { text: "Plain, " },
        { text: "bold", bold: true },
        { text: ", " },
        { text: "italic", italic: true },
        { text: ", " },
        { text: "underlined", underline: true },
        { text: ", " },
        { text: "struck", strike: true },
        { text: " and " },
        { text: "code", code: true },
        { text: ". See " },
        { text: "the site", href: "https://example.com/a?b=1&c=2" },
        { text: " or " },
        { text: "the intro", href: "#intro" },
        { text: "." },
      ],
    },
    { type: "heading", level: 2, align: "center", runs: [{ text: "Goals & risks" }] },
    { type: "paragraph", align: "right", runs: [{ text: "Right <aligned>" }] },
    { type: "paragraph", align: "justify", runs: [{ text: "Justified text" }] },
    {
      type: "list",
      ordered: false,
      items: [
        { level: 0, runs: [{ text: "First bullet" }] },
        { level: 1, runs: [{ text: "Nested bullet" }] },
        { level: 0, runs: [{ text: "Second bullet" }] },
      ],
    },
    {
      type: "list",
      ordered: true,
      items: [
        { level: 0, runs: [{ text: "Step one" }] },
        { level: 0, runs: [{ text: "Step two" }] },
      ],
    },
    { type: "paragraph", style: "quote", runs: [{ text: "A quoted line" }] },
    { type: "paragraph", style: "code", runs: [{ text: "const x = 1;" }] },
    {
      type: "table",
      rows: [
        {
          cells: [
            { header: true, paragraphs: [[{ text: "Name" }]] },
            { header: true, paragraphs: [[{ text: "Value" }]] },
          ],
        },
        {
          cells: [
            { paragraphs: [[{ text: "Revenue" }]] },
            { paragraphs: [[{ text: "120", bold: true }], [{ text: "second line" }]] },
          ],
        },
      ],
    },
    { type: "image", src: PNG, alt: "Red dot", width: 40, height: 20 },
    { type: "divider" },
    { type: "paragraph", runs: [{ text: "Tab\there and a\nbreak" }] },
  ],
};

/** The model without the picture hashes a read adds. */
function withoutAssets(document: OfficeDocument): OfficeDocument {
  return {
    blocks: document.blocks.map((block) => {
      if (block.type !== "image" || block.asset === undefined) return block;
      const { asset: _asset, ...rest } = block;
      return rest;
    }),
  };
}

async function partText(bytes: Uint8Array, name: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file(name)?.async("string")) ?? null;
}

describe("docx writer", () => {
  it("round-trips the editor model: model -> docx -> model", async () => {
    const bytes = await buildDocx(SAMPLE, { title: "Quarterly plan" });
    const reopened = await openDocxForEditing(bytes);
    expect(reopened.lossOnSave).toEqual([]);
    expect(withoutAssets(reopened.document)).toEqual(SAMPLE);
  });

  it("round-trips docx -> model -> docx -> model without change", async () => {
    const first = await openDocxForEditing(await buildDocx(SAMPLE));
    const second = await openDocxForEditing(await buildDocx(first.document));
    expect(second.document).toEqual(first.document);
  });

  it("writes valid package parts", async () => {
    const bytes = await buildDocx(SAMPLE);
    const types = await partText(bytes, "[Content_Types].xml");
    expect(types).toContain('Extension="png"');
    expect(types).toContain("/word/numbering.xml");
    expect(types).toContain("/word/styles.xml");
    const rels = await partText(bytes, "word/_rels/document.xml.rels");
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"');
    const document = await partText(bytes, "word/document.xml");
    expect(document).toContain("Right &lt;aligned&gt;");
    expect(document).toContain('<w:jc w:val="both"/>');
    expect(document).toContain('<w:hyperlink w:anchor="intro"');
    expect(bodySectionXml(document!)).toContain("<w:pgSz");
    const numbering = await partText(bytes, "word/numbering.xml");
    expect(numbering).toContain("<w:startOverride");
  });

  it("writes an empty document Word can open", async () => {
    const bytes = await buildDocx({ blocks: [] });
    const document = await partText(bytes, "word/document.xml");
    expect(document).toMatch(/<w:body><w:p\/><w:sectPr>/);
    expect((await openDocxForEditing(bytes)).document).toEqual({
      blocks: [{ type: "paragraph", runs: [] }],
    });
  });

  it("keeps the parts of the file it replaces", async () => {
    const original = await buildDocx(SAMPLE);
    const zip = await JSZip.loadAsync(original);
    // Give the file a header, a custom page size and an extra namespace, as Word does.
    zip.file(
      "word/header1.xml",
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>',
    );
    const types = (await zip.file("[Content_Types].xml")!.async("string")).replace(
      "</Types>",
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    );
    zip.file("[Content_Types].xml", types);
    const rels = (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace(
      "</Relationships>",
      '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
    );
    zip.file("word/_rels/document.xml.rels", rels);
    const documentXml = (await zip.file("word/document.xml")!.async("string"))
      .replace("<w:document ", '<w:document xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ')
      .replace(
        /<w:sectPr>[\s\S]*<\/w:sectPr>/,
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
      );
    zip.file("word/document.xml", documentXml);
    const base = await zip.generateAsync({ type: "uint8array" });

    const opened = await openDocxForEditing(base);
    expect(opened.keptNotShown).toContain("Headers and footers");
    expect(opened.keptNotShown).toContain("Page size and margins");
    const edited: OfficeDocument = {
      blocks: [...opened.document.blocks, { type: "paragraph", runs: [{ text: "Added later" }] }],
    };
    const saved = await buildDocx(edited, { base });
    expect(await partText(saved, "word/header1.xml")).toContain("Header text");
    const savedDocument = await partText(saved, "word/document.xml");
    expect(savedDocument).toContain('<w:headerReference w:type="default" r:id="rIdHeader"/>');
    expect(savedDocument).toContain('w:w="11906"');
    expect(savedDocument).toContain("xmlns:w14=");
    expect(await partText(saved, "word/_rels/document.xml.rels")).toContain("header1.xml");
    // The picture is written once, under one name, and the old one is gone.
    const media = Object.keys((await JSZip.loadAsync(saved)).files).filter((name) =>
      name.startsWith("word/media/"),
    );
    expect(media).toHaveLength(1);
    const reopened = await openDocxForEditing(saved);
    expect(reopened.document).toEqual(edited);
  });

  it("keeps empty paragraphs and list items, and reuses a picture by its hash", async () => {
    const opened = await openDocxForEditing(await buildDocx(SAMPLE));
    const image = opened.document.blocks.find((block) => block.type === "image");
    expect(image?.type === "image" && image.asset).toMatch(/^[a-f0-9]{64}$/);
    const base = await buildDocx(SAMPLE);
    const edited: OfficeDocument = {
      blocks: [
        { type: "paragraph", runs: [] },
        { type: "list", ordered: false, items: [{ level: 0, runs: [] }, { level: 0, runs: [{ text: "x" }] }] },
        { type: "image", src: `asset:${image?.type === "image" ? image.asset : ""}`, alt: "Kept" },
        { type: "paragraph", runs: [{ text: "end" }] },
      ],
    };
    const reopened = await openDocxForEditing(await buildDocx(edited, { base }));
    expect(reopened.document.blocks[0]).toEqual({ type: "paragraph", runs: [] });
    expect(reopened.document.blocks[1]).toMatchObject({ items: [{ runs: [] }, { runs: [{ text: "x" }] }] });
    expect(reopened.document.blocks[2]).toMatchObject({ type: "image", src: PNG, alt: "Kept" });
    await expect(buildDocx(edited)).rejects.toBeInstanceOf(DocxWriteError);
  });

  it("uses the file's own style ids, matched by name, and adds no second default style", async () => {
    const zip = await JSZip.loadAsync(await buildDocx({ blocks: [] }));
    zip.file(
      "word/styles.xml",
      '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/></w:style>' +
        "</w:styles>",
    );
    const base = await zip.generateAsync({ type: "uint8array" });
    const saved = await buildDocx(
      {
        blocks: [
          { type: "heading", level: 1, runs: [{ text: "Titel" }] },
          { type: "heading", level: 2, runs: [{ text: "Unter" }] },
        ],
      },
      { base },
    );
    const document = await partText(saved, "word/document.xml");
    expect(document).toContain('<w:pStyle w:val="1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
    const styles = (await partText(saved, "word/styles.xml"))!;
    expect(styles.match(/w:default="1"/g)).toHaveLength(1);
    expect(styles).not.toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="Heading2"');
    const reopened = await openDocxForEditing(saved);
    expect(reopened.document.blocks.map((block) => block.type === "heading" && block.level)).toEqual([1, 2]);
  });

  it("tells what a save would drop", async () => {
    const zip = await JSZip.loadAsync(await buildDocx(SAMPLE));
    const documentXml = (await zip.file("word/document.xml")!.async("string")).replace(
      "<w:body>",
      '<w:body><w:p><w:ins w:id="1" w:author="A"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>Big</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r></w:p>',
    );
    zip.file("word/document.xml", documentXml);
    const opened = await openDocxForEditing(await zip.generateAsync({ type: "uint8array" }));
    expect(opened.lossOnSave).toEqual(
      expect.arrayContaining([
        "Track changes",
        "Fields such as a table of contents or page numbers (kept as text)",
        "Font sizes and highlights set on words",
        "Page breaks (kept as line breaks)",
        "Superscript and subscript",
      ]),
    );
  });

  it("keeps every character of a run longer than one run may hold", async () => {
    const long = `${"a".repeat(40_000)}\u{1F600}${"b".repeat(30_000)}`;
    const zip = await JSZip.loadAsync(await buildDocx({ blocks: [] }));
    const documentXml = (await zip.file("word/document.xml")!.async("string")).replace(
      "<w:body>",
      `<w:body><w:p><w:r><w:t>${long}</w:t></w:r></w:p>`,
    );
    zip.file("word/document.xml", documentXml);
    const opened = await openDocxForEditing(await zip.generateAsync({ type: "uint8array" }));
    const block = opened.document.blocks[0];
    expect(block?.type === "paragraph" && block.runs.map((run) => run.text).join("")).toBe(long);
    expect(opened.lossOnSave).toEqual([]);
  });

  it("names content controls and a template's own paragraph styles as losses", async () => {
    const zip = await JSZip.loadAsync(await buildDocx({ blocks: [] }));
    const styles = (await zip.file("word/styles.xml")!.async("string")).replace(
      "</w:styles>",
      '<w:style w:type="paragraph" w:styleId="ContractClause"><w:name w:val="Contract Clause"/></w:style></w:styles>',
    );
    zip.file("word/styles.xml", styles);
    const documentXml = (await zip.file("word/document.xml")!.async("string")).replace(
      "<w:body>",
      '<w:body><w:p><w:pPr><w:pStyle w:val="ContractClause"/></w:pPr><w:r><w:t>Clause</w:t></w:r></w:p>' +
        '<w:sdt><w:sdtPr><w:tag w:val="name"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:sdtContent></w:sdt>',
    );
    zip.file("word/document.xml", documentXml);
    const opened = await openDocxForEditing(await zip.generateAsync({ type: "uint8array" }));
    expect(opened.lossOnSave).toEqual(
      expect.arrayContaining([
        "Content controls such as form fields (their text is kept)",
        "Paragraph styles from the file's template (become plain paragraphs)",
      ]),
    );
    // The writer's own styles are not a loss.
    expect((await openDocxForEditing(await buildDocx(SAMPLE))).lossOnSave).toEqual([]);
  });

  it("keeps a footer whose relationship uses single quotes", async () => {
    const zip = await JSZip.loadAsync(await buildDocx({ blocks: [] }));
    zip.file(
      "word/footer1.xml",
      '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer text</w:t></w:r></w:p></w:ftr>',
    );
    const rels = (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace(
      "</Relationships>",
      "<Relationship Id='rIdFooter' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer' Target='footer1.xml'/></Relationships>",
    );
    zip.file("word/_rels/document.xml.rels", rels);
    const base = await zip.generateAsync({ type: "uint8array" });
    const saved = await buildDocx({ blocks: [{ type: "paragraph", runs: [{ text: "x" }] }] }, { base });
    expect(await partText(saved, "word/_rels/document.xml.rels")).toContain("footer1.xml");
    expect(await partText(saved, "word/footer1.xml")).toContain("Footer text");
  });

  it("refuses to write a document its reader would not open again", async () => {
    const paragraph = { type: "paragraph" as const, runs: [{ text: "x".repeat(32_000) }] };
    await expect(
      buildDocx({ blocks: Array.from({ length: 550 }, () => paragraph) }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("keeps unsafe links as text and refuses a picture that is not one", async () => {
    const bytes = await buildDocx({
      blocks: [{ type: "paragraph", runs: [{ text: "x", href: "javascript:alert(1)" }] }],
    });
    expect(await partText(bytes, "word/document.xml")).not.toContain("hyperlink");
    await expect(
      buildDocx({ blocks: [{ type: "image", src: "data:image/png;base64,!!!" }] }),
    ).rejects.toBeInstanceOf(DocxWriteError);
  });
});

/** LibreOffice when installed (CI runners usually have none). */
function findSoffice(): string | null {
  const candidates = [
    process.env.SOFFICE_PATH,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  ];
  return candidates.find((path) => path !== undefined && NodeFS.existsSync(path)) ?? null;
}

const soffice = findSoffice();

describe.skipIf(soffice === null)("docx writer in LibreOffice", () => {
  it(
    "converts our output to PDF and text with the same content",
    async () => {
      const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-docx-lo-"));
      try {
        const input = NodePath.join(scratch, "sample.docx");
        NodeFS.writeFileSync(input, await buildDocx(SAMPLE));
        // A private profile, so the run never touches a person's LibreOffice settings.
        const profile = NodeURL.pathToFileURL(NodePath.join(scratch, "profile")).href;
        for (const format of ["pdf", "txt:Text"]) {
          NodeChildProcess.execFileSync(
            soffice!,
            [
              `-env:UserInstallation=${profile}`,
              "--headless",
              "--convert-to",
              format,
              "--outdir",
              scratch,
              input,
            ],
            { stdio: "ignore", timeout: 120_000 },
          );
        }
        const pdf = NodeFS.readFileSync(NodePath.join(scratch, "sample.pdf"));
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        expect(pdf.byteLength).toBeGreaterThan(2_000);
        const text = NodeFS.readFileSync(NodePath.join(scratch, "sample.txt"), "utf8");
        for (const expected of [
          "Quarterly plan",
          "Plain, bold, italic, underlined, struck and code. See the site or the intro.",
          "Goals & risks",
          "Right <aligned>",
          "First bullet",
          "Nested bullet",
          "1. Step one",
          "2. Step two",
          "A quoted line",
          "const x = 1;",
          "Revenue",
          "second line",
        ]) {
          expect(text).toContain(expected);
        }
      } finally {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "opens a file LibreOffice wrote, saves an edit over it, and LibreOffice reads the edit",
    async () => {
      const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-docx-lo-base-"));
      try {
        const profile = NodeURL.pathToFileURL(NodePath.join(scratch, "profile")).href;
        const convert = (input: string, format: string, outdir: string) =>
          NodeChildProcess.execFileSync(
            soffice!,
            [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", format, "--outdir", outdir, input],
            { stdio: "ignore", timeout: 120_000 },
          );
        const source = NodePath.join(scratch, "source.docx");
        NodeFS.writeFileSync(source, await buildDocx(SAMPLE));
        const authored = NodePath.join(scratch, "authored");
        NodeFS.mkdirSync(authored);
        // LibreOffice writes its own package: its own style ids, settings and parts.
        convert(source, "docx:MS Word 2007 XML", authored);
        const base = new Uint8Array(NodeFS.readFileSync(NodePath.join(authored, "source.docx")));
        const opened = await openDocxForEditing(base);
        expect(opened.document.blocks.some((block) => block.type === "heading")).toBe(true);
        const edited: OfficeDocument = {
          blocks: [
            ...opened.document.blocks,
            { type: "heading", level: 2, runs: [{ text: "Added in SpecWithCode" }] },
            { type: "list", ordered: true, items: [{ level: 0, runs: [{ text: "New step" }] }] },
          ],
        };
        const savedPath = NodePath.join(scratch, "saved.docx");
        NodeFS.writeFileSync(savedPath, await buildDocx(edited, { base }));
        convert(savedPath, "txt:Text", scratch);
        const text = NodeFS.readFileSync(NodePath.join(scratch, "saved.txt"), "utf8");
        for (const expected of ["Quarterly plan", "First bullet", "Revenue", "Added in SpecWithCode", "New step"]) {
          expect(text).toContain(expected);
        }
        const reopened = await openDocxForEditing(new Uint8Array(NodeFS.readFileSync(savedPath)));
        expect(reopened.document.blocks.at(-2)).toEqual({
          type: "heading",
          level: 2,
          runs: [{ text: "Added in SpecWithCode" }],
        });
      } finally {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
