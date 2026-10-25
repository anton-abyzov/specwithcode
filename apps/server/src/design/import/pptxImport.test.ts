// @effect-diagnostics nodeBuiltinImport:off - Reads the fixture deck with Node APIs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DESIGN_DECK_IMPORT_MAX_BYTES,
  DESIGN_DOCUMENT_SCHEMA,
  DESIGN_MAX_PAGES,
  DesignImportSkipped,
  DesignPage,
  type DesignDocument,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { MAX_ASSET_BYTES } from "../DesignStore.ts";
import { planPptx, writePptx } from "../export/pptx.ts";
import { EVIDENCE_DIR_ENV, PYTHON_PPTX_ENV, pptxReadBack } from "../export/pptx.testkit.ts";
import { exportSheets } from "../export/sheets.ts";
import { importedPages } from "./DesignImport.ts";
import {
  PPTX_IMPORT_LIMITS,
  PptxImportError,
  readPptxDeck,
  type ImportedDeck,
} from "./pptxImport.ts";
import { exportedDeck, minimalDeck, storedZip } from "./pptxImport.testkit.ts";
import { parseXml, XmlRefused } from "./xml.ts";

let counter = 0;
const nodeId = () => `n_test${(counter += 1)}`;

const CONTENT_TYPES = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${main}"/></Types>`;
const PPTX_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const PRESENTATION = `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst/></p:presentation>`;

const refusal = async (bytes: Uint8Array) => {
  try {
    await readPptxDeck(bytes, nodeId);
  } catch (error) {
    expect(error).toBeInstanceOf(PptxImportError);
    return (error as PptxImportError).message;
  }
  throw new Error("The import did not refuse the file.");
};

const texts = (imported: ImportedDeck) =>
  imported.slides.map((slide) =>
    slide.nodes.flatMap((item) => (item.node.type === "text" ? [item.node.text] : [])),
  );

describe("readPptxDeck (1051 AC-03)", () => {
  it("round-trips a deck from our exporter: slide count, text, notes, shapes and the picture", async () => {
    const imported = await readPptxDeck(await exportedDeck(), nodeId);
    expect(imported.slides).toHaveLength(3);
    expect(texts(imported)).toEqual([["Matchday launch"], ["First line\nSecond line"], ["Thanks"]]);
    expect(imported.slides.map((slide) => slide.notes)).toEqual([
      "Open with the date.",
      "Two lines and a picture.",
      "Thank the team.",
    ]);
    expect(imported.slides[0]!.background).toBe("#0F172B");
    const title = imported.slides[0]!.nodes.find((item) => item.node.type === "text")!.node;
    expect(title).toMatchObject({ x: 120, y: 400, width: 1680, height: 140, fontWeight: 700 });
    expect(title).toMatchObject({ fontSize: 96, color: "#FFFFFF" });
    const card = imported.slides[0]!.nodes.find((item) => item.node.name === "Card")!.node;
    expect(card).toMatchObject({ type: "rect", fill: "#EA580C", x: 120, y: 700, width: 400 });
    const second = imported.slides[1]!.nodes.map((item) => item.node.type);
    expect(second).toEqual(["text", "ellipse", "image"]);
    const photo = imported.slides[1]!.nodes.find((item) => item.kind === "image");
    expect(photo?.kind === "image" ? imported.media.get(photo.media)?.mimeType : null).toBe(
      "image/png",
    );
    expect(photo?.node).toMatchObject({ x: 1000, y: 400, width: 640, height: 360 });
    expect(imported.slides.every((slide) => slide.notImported.length === 0)).toBe(true);
    for (const slide of imported.slides) {
      expect(slide.nodes.every((item) => item.node.parentId === slide.frameId)).toBe(true);
    }
  });

  it("reads a third-party python-pptx deck: placeholders, bullets, columns, picture, shapes and a table", async () => {
    const bytes = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "fixtures", "third-party-6-slides.pptx"),
    );
    const imported = await readPptxDeck(bytes, nodeId);
    expect(imported.slides).toHaveLength(6);
    expect(imported.slides.map((slide) => slide.notes)).toEqual([
      "Notes 1: open with the launch date.",
      "Notes 2: three bullets, the first bold.",
      "Notes 3: two columns.",
      "Notes 4: a picture.",
      "Notes 5: shapes, the star is not imported.",
      "Notes 6: a table, listed as not imported.",
    ]);
    const all = texts(imported);
    expect(all[0]).toEqual(["Matchday launch", "Third-party deck for the import check"]);
    expect(all[1]).toEqual(["What ships", "• Live scores\n• Team pages\n• Fixtures calendar"]);
    expect(all[2]).toEqual(["Before and after", "• Before: spreadsheets", "• After: one schedule"]);
    expect(imported.slides[3]!.nodes.some((item) => item.kind === "image")).toBe(true);
    expect(imported.media.size).toBe(1);
    const shapes = imported.slides[4]!.nodes.map((item) => item.node.type);
    expect(shapes).toEqual(["text", "rect", "text", "ellipse"]);
    expect(imported.slides[4]!.nodes[1]!.node).toMatchObject({
      fill: "#EA580C",
      stroke: "#111827",
    });
    expect(imported.slides[4]!.notImported).toEqual([expect.stringContaining("star5")]);
    expect(imported.slides[5]!.notImported).toEqual([expect.stringContaining("Table")]);
    // Every placed node sits on the 1920 x 1080 slide.
    for (const slide of imported.slides) {
      for (const { node } of slide.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width).toBeLessThanOrEqual(1921);
        expect(node.y + node.height).toBeLessThanOrEqual(1081);
      }
    }
  });

  it("exports an imported third-party deck again with the same slides, text and notes (AC-02)", async () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "fixtures", "third-party-6-slides.pptx"),
    );
    const imported = await readPptxDeck(source, nodeId);
    const names = new Map(
      [...imported.media.keys()].map((media, index) => [media, `${String(index).repeat(64)}.png`]),
    );
    const bytesOf = new Map(
      [...imported.media].map(([media, image]) => [names.get(media)!, image.bytes]),
    );
    const { pages } = importedPages(imported, names);
    const document: DesignDocument = {
      schema: DESIGN_DOCUMENT_SCHEMA,
      id: "d_imported",
      kind: "slides",
      title: "Third party",
      revision: 1,
      createdAt: "2026-10-24T12:00:00.000Z",
      updatedAt: "2026-10-24T12:00:00.000Z",
      designSystem: null,
      comments: [],
      createdBy: { kind: "user" },
      copiedFrom: null,
      pages,
    };
    const plan = planPptx(document, exportSheets(document), {
      system: null,
      mode: "light",
      assetUrl: (asset) =>
        `data:image/png;base64,${Buffer.from(bytesOf.get(asset) ?? new Uint8Array()).toString("base64")}`,
    });
    expect(plan.rasters).toHaveLength(0);
    const exported = await writePptx(plan, [], { title: document.title });
    const again = await readPptxDeck(exported, nodeId);
    expect(again.slides).toHaveLength(6);
    expect(texts(again)).toEqual(texts(imported));
    expect(again.slides.map((slide) => slide.notes)).toEqual(
      imported.slides.map((slide) => slide.notes),
    );
    expect(again.media.size).toBe(1);

    const evidence = process.env[EVIDENCE_DIR_ENV];
    const python = process.env[PYTHON_PPTX_ENV];
    if (evidence === undefined && python === undefined) return;
    const directory =
      evidence ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pptx-import-"));
    NodeFS.mkdirSync(directory, { recursive: true });
    const file = NodePath.join(directory, "third-party-6-slides.reexported.pptx");
    NodeFS.writeFileSync(file, exported);
    if (python === undefined) return;
    const read = pptxReadBack(python, file);
    expect(read.slides).toHaveLength(6);
    expect(read.slides.map((slide) => slide.notes)).toEqual(
      imported.slides.map((slide) => slide.notes ?? ""),
    );
    expect(read.slides.map((slide) => slide.texts.join("\n"))).toEqual(
      texts(imported).map((slide) => slide.join("\n")),
    );
  });

  it("refuses a file that is not a zip", async () => {
    expect(await refusal(Buffer.from("not a deck at all"))).toBe(
      "The file is not a PowerPoint deck (.pptx).",
    );
  });

  it("refuses a macro-enabled deck (.pptm)", async () => {
    const pptm = storedZip([
      [
        "[Content_Types].xml",
        CONTENT_TYPES("application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"),
      ],
      ["ppt/presentation.xml", PRESENTATION],
    ]);
    expect(await refusal(pptm)).toMatch(/macros/);
  });

  it("refuses an unknown main content type", async () => {
    const docx = storedZip([
      [
        "[Content_Types].xml",
        CONTENT_TYPES(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
      ],
      ["ppt/presentation.xml", PRESENTATION],
    ]);
    expect(await refusal(docx)).toMatch(/not a PowerPoint presentation/);
  });

  it("refuses a zip path that leaves the archive", async () => {
    const escape = storedZip([
      ["[Content_Types].xml", CONTENT_TYPES(PPTX_MAIN)],
      ["../evil.xml", "<x/>"],
    ]);
    expect(await refusal(escape)).toBe("The deck has a file path that leaves the archive.");
  });

  it("refuses more than 2,000 zip entries", async () => {
    const files = Array.from(
      { length: 2_001 },
      (_, index) => [`ppt/x${index}.xml`, "<x/>"] as const,
    );
    expect(await refusal(storedZip(files))).toBe(
      "The deck has 2001 files inside; the limit is 2000.",
    );
  });

  it("refuses a DOCTYPE or ENTITY in any XML part", async () => {
    const doctype = storedZip([
      ["[Content_Types].xml", CONTENT_TYPES(PPTX_MAIN)],
      [
        "ppt/presentation.xml",
        `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY boom "boom">]><p:presentation xmlns:p="p">&boom;</p:presentation>`,
      ],
    ]);
    expect(await refusal(doctype)).toMatch(/DOCTYPE or ENTITY/);
    expect(() => parseXml("<a>&undeclared;</a>")).toThrow(XmlRefused);
  });

  it("takes its file, slide and picture limits from what the app enforces", () => {
    expect(PPTX_IMPORT_LIMITS.fileBytes).toBe(DESIGN_DECK_IMPORT_MAX_BYTES);
    expect(PPTX_IMPORT_LIMITS.slides).toBe(DESIGN_MAX_PAGES);
    expect(PPTX_IMPORT_LIMITS.imageBytes).toBe(MAX_ASSET_BYTES);
  });

  it("refuses more slides than a slides document holds and more than 200 MB unpacked", async () => {
    expect(await refusal(minimalDeck({ slides: ["<p:sp/>"], listed: 201 }))).toBe(
      "The deck has 201 slides; the import limit is 200.",
    );
    const atLimit = await readPptxDeck(minimalDeck({ slides: ["<p:sp/>"], listed: 200 }), nodeId);
    expect(atLimit.slides).toHaveLength(200);
    const claimed = new Map([["ppt/media/huge.bin", 201 * 1024 * 1024]]);
    expect(
      await refusal(
        minimalDeck({ slides: ["<p:sp/>"], files: [["ppt/media/huge.bin", "x"]], claimed }),
      ),
    ).toBe("The deck unpacks to more than 200 MB, the import limit.");
  });

  it("refuses an XML part over 16 MB without reading it, and a deck over 1,000,000 elements", async () => {
    const claimed = new Map([["ppt/slides/slide1.xml", 16 * 1024 * 1024 + 1]]);
    expect(await refusal(minimalDeck({ slides: ["<p:sp/>"], claimed }))).toBe(
      "The deck part ppt/slides/slide1.xml is larger than 16 MB, the import limit.",
    );
    // Each slide is under the per-part cap; together they are over the deck's.
    const slide = `<p:grpSp>${"<a/>".repeat(400_000)}</p:grpSp>`;
    let message = "";
    try {
      await readPptxDeck(minimalDeck({ slides: [slide, slide, slide] }), nodeId);
    } catch (error) {
      expect(error).toMatchObject({ code: "too_large" });
      message = (error as Error).message;
    }
    expect(message).toBe(
      "The file's XML parts hold more than 1,000,000 elements in all, the import limit.",
    );
  });

  it("keeps long preset names, extensions and shape names within the result's limits", async () => {
    const shape = (name: string, geometry: string, fill = "") =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm><a:prstGeom prst="${geometry}"/>${fill}</p:spPr></p:sp>`;
    const longName = "N".repeat(400);
    const filled = `<a:solidFill><a:srgbClr val="EA580C"/></a:solidFill>`;
    const labelled = shape(longName, "rect", filled).replace(
      "</p:sp>",
      `<p:txBody><a:bodyPr/><a:p><a:r><a:t>Inside</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Odd"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdOdd"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm></p:spPr></p:pic>`;
    const many = Array.from({ length: 60 }, (_, index) => shape("", `g${index}`)).join("");
    const deck = minimalDeck({
      slides: [shape(longName, "x".repeat(10_000)) + labelled + picture + many],
      slideRels: `<Relationship Id="rIdOdd" Type="x/image" Target="../media/odd.${"q".repeat(5_000)}"/>`,
    });
    const imported = await readPptxDeck(deck, nodeId);
    const items = imported.slides[0]!.notImported;
    expect(items[0]).toBe(`Shape (${"x".repeat(39)}…) "${"N".repeat(180)}"`);
    expect(items[1]).toBe(`Picture (.${"q".repeat(39)}…) "Odd"`);
    const { pages, notImported } = importedPages(imported, new Map());
    expect(notImported[0]!.items).toHaveLength(50);
    expect(() =>
      Schema.decodeUnknownSync(Schema.Array(DesignImportSkipped))(notImported),
    ).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Schema.Array(DesignPage))(pages)).not.toThrow();
    const clamped = importedPages(
      { slides: [{ ...imported.slides[0]!, notImported: ["y".repeat(1_000)] }], media: new Map() },
      new Map(),
    ).notImported[0]!.items[0]!;
    expect(clamped).toBe(`${"y".repeat(299)}…`);
  });

  it("refuses a slide size PowerPoint would not allow instead of scaling it up", async () => {
    for (const slideSize of [
      'cx="1" cy="1"',
      'cx="12192000" cy="1"',
      'cx="51206401" cy="6858000"',
    ]) {
      expect(await refusal(minimalDeck({ slides: ["<p:sp/>"], slideSize }))).toBe(
        "The deck's slide size is outside what PowerPoint allows (1 to 56 inches a side).",
      );
    }
    const square = await readPptxDeck(
      minimalDeck({ slides: ["<p:sp/>"], slideSize: 'cx="914400" cy="914400"' }),
      nodeId,
    );
    expect(square.slides).toHaveLength(1);
  });

  it("keeps hostile offsets, group scales, line widths and font sizes within the contract's bounds", async () => {
    const box = (x: string, cx: string) =>
      `<a:xfrm><a:off x="${x}" y="${x}"/><a:ext cx="${cx}" cy="${cx}"/></a:xfrm>`;
    const filled = `<a:solidFill><a:srgbClr val="EA580C"/></a:solidFill>`;
    const rect = (x: string, cx: string, width: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Far"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${box(x, cx)}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 99999999999"/></a:avLst></a:prstGeom>${filled}<a:ln w="${width}">${filled}</a:ln></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="999999999999"/><a:t>Far away</a:t></a:r></a:p></p:txBody></p:sp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Blown up"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9000000000000" cy="9000000000000"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></p:grpSpPr>${rect("5", "5", "1")}</p:grpSp>`;
    const deck = minimalDeck({
      slides: [
        rect("99999999999999999", "1e308", "1e308") + rect("-1e308", "635000", "-5") + group,
      ],
    });
    const imported = await readPptxDeck(deck, nodeId);
    const { pages } = importedPages(imported, new Map());
    expect(() => Schema.decodeUnknownSync(Schema.Array(DesignPage))(pages)).not.toThrow();
    // The widest line is drawn inside the box, so the shape moves in by half of it.
    const [far, farText] = imported.slides[0]!.nodes.map((item) => item.node);
    expect(far).toMatchObject({ x: 500_000, width: 1_000_000, strokeWidth: 1_000_000 });
    expect(farText).toMatchObject({ x: 1_000_000, width: 1_000_000, fontSize: 1_000_000 });
    expect(imported.slides[0]!.nodes.map((item) => item.node.type)).toEqual([
      "rect",
      "text",
      "rect",
      "text",
      "rect",
      "text",
    ]);
  });

  it("looks placeholders up in a large layout in linear time", async () => {
    const placed = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="635000"/><a:ext cx="6350000" cy="635000"/></a:xfrm></p:spPr></p:sp>`;
    const layout = `<?xml version="1.0"?><p:sldLayout xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${"<p:sp/>".repeat(50_000)}${placed}</p:spTree></p:cSld></p:sldLayout>`;
    const placeholder = (idx: number) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="${idx}"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Line ${idx}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const deck = minimalDeck({
      slides: [Array.from({ length: 4_000 }, (_, index) => placeholder(index + 1)).join("")],
      slideRels: `<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
      files: [["ppt/slideLayouts/slideLayout1.xml", layout]],
    });
    const start = performance.now();
    const imported = await readPptxDeck(deck, nodeId);
    expect(performance.now() - start).toBeLessThan(1_500);
    const nodes = imported.slides[0]!.nodes.map((item) => item.node);
    expect(nodes).toHaveLength(4_000);
    // idx 1 has its own layout position; the others take the first body placeholder's.
    expect(nodes[0]).toMatchObject({ text: "Line 1", x: 100, y: 100, width: 1000, height: 100 });
    expect(nodes[3_999]).toMatchObject({ text: "Line 4000", x: 100, y: 100 });
  });

  it("lists a picture over 10 MB as not imported, without reading it, and keeps the rest of the slide", async () => {
    const picture = (name: string, rel: string) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="2" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350000" cy="3175000"/></a:xfrm></p:spPr></p:pic>`;
    const deck = minimalDeck({
      slides: [
        picture("Huge", "rIdHuge") +
          picture("Small", "rIdSmall") +
          `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Caption"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>Kept &amp; caption</a:t></a:r></a:p></p:txBody></p:sp>`,
      ],
      slideRels: `<Relationship Id="rIdHuge" Type="x/image" Target="../media/huge.png"/><Relationship Id="rIdSmall" Type="x/image" Target="../media/small.png"/>`,
      files: [
        ["ppt/media/huge.png", Buffer.from("tiny")],
        ["ppt/media/small.png", Buffer.from("tiny")],
      ],
      // Only the archive's directory claims the size; the entry is never read.
      claimed: new Map([["ppt/media/huge.png", 10 * 1024 * 1024 + 1]]),
    });
    const imported = await readPptxDeck(deck, nodeId);
    expect(imported.slides[0]!.notImported).toEqual(['Picture larger than 10 MB "Huge"']);
    expect(imported.slides[0]!.nodes.map((item) => item.node.type)).toEqual(["image", "text"]);
    expect(imported.slides[0]!.nodes[0]!.node).toMatchObject({ width: 1000, height: 500 });
    expect(imported.slides[0]!.nodes[1]!.node).toMatchObject({
      text: "Kept & caption",
      fontSize: 48,
      fontWeight: 700,
    });
    expect([...imported.media.keys()]).toEqual(["ppt/media/small.png"]);
  });

  it("refuses a file over 50 MB before unpacking it", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 1);
    big.write("PK", 0);
    expect(await refusal(big)).toBe("The file is larger than 50 MB, the import limit.");
  });
});
