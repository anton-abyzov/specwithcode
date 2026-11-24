// @effect-diagnostics nodeBuiltinImport:off - Runs LibreOffice in a private scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

async function partText(bytes: Uint8Array, name: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file(name)?.async("string")) ?? null;
}

describe("docx writer", () => {
  it("round-trips the editor model: model -> docx -> model", async () => {
    const bytes = await buildDocx(SAMPLE, { title: "Quarterly plan" });
    const reopened = await openDocxForEditing(bytes);
    expect(reopened.lossOnSave).toEqual([]);
    expect(reopened.document).toEqual(SAMPLE);
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
    expect((await openDocxForEditing(bytes)).document).toEqual({ blocks: [] });
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

  it("tells what a save would drop", async () => {
    const zip = await JSZip.loadAsync(await buildDocx(SAMPLE));
    const documentXml = (await zip.file("word/document.xml")!.async("string")).replace(
      "<w:body>",
      '<w:body><w:p><w:ins w:id="1" w:author="A"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>Big</w:t></w:r></w:p>',
    );
    zip.file("word/document.xml", documentXml);
    const opened = await openDocxForEditing(await zip.generateAsync({ type: "uint8array" }));
    expect(opened.lossOnSave).toEqual(
      expect.arrayContaining([
        "Track changes",
        "Fields such as a table of contents or page numbers (kept as text)",
        "Font sizes and highlights set on words",
      ]),
    );
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
        const profile = `file://${NodePath.join(scratch, "profile").replace(/\\/g, "/")}`;
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
});
