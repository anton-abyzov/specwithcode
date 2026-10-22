// @effect-diagnostics nodeBuiltinImport:off - Reads pptxgenjs's shipped builds.
import * as NodeFS from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import {
  DESIGN_DOCUMENT_SCHEMA,
  DESIGN_SYSTEM_SCHEMA,
  type DesignDocument,
  type DesignNode,
  type DesignSystem,
  type DesignTokenValue,
} from "@specweave-studio/contracts";
import type { DesignRenderContext } from "@specweave-studio/shared/designRender";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import { exportPptx, imagePixelSize, planPptx, pptxFontFace, writePptx } from "./pptx.ts";
import { readZipText, slideXml, textRuns } from "./pptx.testkit.ts";
import { exportSheets } from "./sheets.ts";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHOTO = Buffer.from(PNG_1X1, "base64");
// Claim 400 x 200 in the header so the cover crop has a shape to work with.
PHOTO.writeUInt32BE(400, 16);
PHOTO.writeUInt32BE(200, 20);

const value = (raw: string): DesignTokenValue => ({
  raw,
  resolved: raw,
  provenance: { source: "agent", location: "deck", extractor: "test" },
});
const system: DesignSystem = {
  schema: DESIGN_SYSTEM_SCHEMA,
  id: "s_deck",
  name: "Deck",
  revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    {
      name: "deck-bg",
      type: "color",
      values: { light: value("#ffffff"), dark: value("oklch(0.208 0.042 265.755)") },
    },
    {
      name: "deck-ink",
      type: "color",
      values: { light: value("#111827"), dark: value("rgb(248 250 252)") },
    },
    { name: "deck-accent", type: "color", values: { light: value("hsl(24 95% 45%)") } },
    { name: "deck-title-size", type: "dimension", values: { light: value("4rem") } },
    { name: "deck-radius", type: "dimension", values: { light: value("24px") } },
    { name: "deck-heading", type: "fontFamily", values: { light: value('"Georgia", serif') } },
  ],
  components: [],
  sources: [],
  copiedFrom: null,
};

const frame = (id: string, fill: unknown = { token: "deck-bg" }) =>
  ({
    id,
    parentId: null,
    type: "frame",
    name: id,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    fill,
    clip: true,
  }) as DesignNode;
const child = (frameId: string, node: Record<string, unknown>) =>
  ({ parentId: frameId, x: 0, y: 0, width: 100, height: 100, ...node }) as DesignNode;

const deck: DesignDocument = {
  schema: DESIGN_DOCUMENT_SCHEMA,
  id: "d_deck",
  kind: "slides",
  title: "Quarterly review",
  revision: 3,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  designSystem: "s_deck",
  comments: [],
  createdBy: { kind: "user" },
  copiedFrom: null,
  pages: [
    {
      id: "p_title",
      name: "Title",
      notes: "Open with the headline number.",
      nodes: [
        frame("n_f1"),
        child("n_f1", {
          id: "n_title",
          name: "Title",
          type: "text",
          text: "Quarterly review",
          x: 120,
          y: 400,
          width: 1680,
          height: 120,
          color: { token: "deck-ink" },
          fontSize: { token: "deck-title-size" },
          fontFamily: { token: "deck-heading" },
          fontWeight: 700,
          letterSpacing: 2,
        }),
        child("n_f1", {
          id: "n_card",
          type: "rect",
          x: 120,
          y: 600,
          width: 400,
          height: 200,
          fill: { token: "deck-accent" },
          radius: { token: "deck-radius" },
          stroke: "#000000",
          strokeWidth: 4,
          opacity: 0.5,
        }),
        child("n_f1", {
          id: "n_dot",
          type: "ellipse",
          x: 1600,
          y: 80,
          width: 80,
          height: 80,
          fill: "#ef4444",
        }),
      ],
    },
    {
      id: "p_body",
      name: "Body",
      nodes: [
        frame("n_f2", "linear-gradient(#000, #fff)"),
        child("n_f2", {
          id: "n_rise",
          type: "line",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          points: [
            [0, 100],
            [200, 0],
          ],
        }),
        child("n_f2", {
          id: "n_tri",
          type: "path",
          x: 400,
          y: 100,
          width: 100,
          height: 100,
          points: [
            [0, 100],
            [50, 0],
            [100, 100],
          ],
          closed: true,
          fill: "#22c55e",
        }),
        child("n_f2", {
          id: "n_chart",
          type: "html",
          x: 600,
          y: 100,
          width: 800,
          height: 450,
          html: "<b>Chart</b>",
        }),
        child("n_f2", {
          id: "n_photo",
          type: "image",
          asset: `${"a".repeat(64)}.png`,
          x: 100,
          y: 600,
          width: 300,
          height: 300,
        }),
        child("n_f2", {
          id: "n_logo",
          type: "image",
          asset: `${"b".repeat(64)}.svg`,
          x: 500,
          y: 600,
          width: 100,
          height: 100,
        }),
        child("n_f2", {
          id: "n_note",
          type: "note",
          text: "Check the source",
          x: 1500,
          y: 800,
          width: 200,
          height: 120,
        }),
        child("n_f2", { id: "n_hidden", type: "text", text: "Hidden", hidden: true }),
        child("n_f2", { id: "n_glow", type: "rect", fill: "radial-gradient(#fff, #000)" }),
      ],
    },
    { id: "p_skip", name: "Skipped", skipped: true, notes: "Never shown", nodes: [frame("n_f3")] },
  ],
};

const context = (mode = "light"): DesignRenderContext => ({
  system,
  mode,
  assetUrl: (asset) =>
    asset.endsWith(".png")
      ? `data:image/png;base64,${PHOTO.toString("base64")}`
      : "data:image/svg+xml;base64,PHN2Zy8+",
});

const fakeRender = (calls: Array<number>) =>
  ({
    captureImages: ({ items }: { items: ReadonlyArray<unknown> }) =>
      Effect.sync(() => {
        calls.push(items.length);
        return items.map(() => PNG_1X1);
      }),
  }) as unknown as HtmlRender.HtmlRender["Service"];

describe("exportSheets", () => {
  it("gives a deck one sheet per slide that is not skipped", () => {
    expect(exportSheets(deck).map((sheet) => sheet.target)).toEqual([
      { pageId: "p_title", frameId: "n_f1" },
      { pageId: "p_body", frameId: "n_f2" },
    ]);
  });

  it("gives a design one sheet per top-level frame, and a frameless page whole", () => {
    const design: DesignDocument = {
      ...deck,
      kind: "design",
      pages: [
        {
          id: "p_a",
          name: "A",
          nodes: [frame("n_a1"), frame("n_a2"), { ...frame("n_a3"), hidden: true } as DesignNode],
        },
        {
          id: "p_b",
          name: "B",
          nodes: [
            { id: "n_free", parentId: null, type: "rect", x: 0, y: 0, width: 10, height: 10 },
          ],
        },
        { id: "p_c", name: "C", nodes: [] },
      ],
    };
    expect(exportSheets(design).map((sheet) => sheet.target)).toEqual([
      { pageId: "p_a", frameId: "n_a1" },
      { pageId: "p_a", frameId: "n_a2" },
      { pageId: "p_b" },
    ]);
  });
});

describe("planPptx", () => {
  const plan = planPptx(deck, exportSheets(deck), context());
  const [title, body] = plan.slides;
  const named = (slide: typeof title, name: string) =>
    slide!.items.find((item) => item.options.objectName === name);

  it("sizes the deck to the slide: 1920 x 1080 is 13.33 x 7.5 in", () => {
    expect(plan.width).toBeCloseTo(13.333, 3);
    expect(plan.height).toBe(7.5);
    expect(plan.slides).toHaveLength(2);
  });

  it("keeps text as text with resolved tokens, and the slide fill as the background", () => {
    expect(title!.background).toEqual({ kind: "color", color: { hex: "FFFFFF", transparency: 0 } });
    const text = named(title, "Title");
    expect(text).toMatchObject({
      kind: "text",
      text: "Quarterly review",
      options: {
        fontFace: "Georgia",
        fontSize: 32,
        color: "111827",
        bold: true,
        charSpacing: 1,
        x: 120 / 144,
        y: 400 / 144,
        isTextBox: true,
      },
    });
    expect(title!.notes).toBe("Open with the headline number.");
  });

  it("keeps rectangles and ellipses as shapes, with radius, stroke inset and opacity", () => {
    expect(named(title, "n_card")).toMatchObject({
      kind: "shape",
      shape: "roundRect",
      options: {
        x: 122 / 144,
        w: 396 / 144,
        rectRadius: 24 / 144,
        fill: { type: "solid", color: "E05D06", transparency: 50 },
        line: { color: "000000", width: 2, transparency: 50 },
      },
    });
    expect(named(title, "n_dot")).toMatchObject({ kind: "shape", shape: "ellipse" });
  });

  it("draws lines and paths as shapes and HTML, SVG and gradients as images", () => {
    expect(body!.background).toEqual({ kind: "raster", job: 0 });
    expect(named(body, "n_rise")).toMatchObject({
      kind: "shape",
      shape: "line",
      options: { flipV: true },
    });
    const triangle = named(body, "n_tri");
    expect(triangle).toMatchObject({
      kind: "shape",
      shape: "custGeom",
      options: { fill: { color: "22C55E" } },
    });
    expect((triangle!.options as { points: unknown[] }).points).toHaveLength(4);
    expect(named(body, "n_chart")).toMatchObject({ kind: "raster" });
    expect(named(body, "n_logo")).toMatchObject({ kind: "raster" });
    expect(named(body, "n_glow")).toMatchObject({ kind: "raster" });
    expect(named(body, "n_photo")).toMatchObject({
      kind: "image",
      options: { sizing: { type: "cover", w: 300 / 144, h: 300 / 144 }, h: (300 / 144) * 0.5 },
    });
    expect(named(body, "n_note")).toMatchObject({ kind: "text", text: "Check the source" });
    expect(named(body, "n_hidden")).toBeUndefined();
    expect(body!.notes).toBeUndefined();
    // The background, the chart, the logo and the gradient rectangle.
    expect(plan.rasters).toHaveLength(4);
    expect(plan.rasters[1]).toMatchObject({ width: 800, height: 450 });
    expect(plan.rasters[1]!.html).toContain("Chart");
  });

  it("resolves tokens in the chosen mode", () => {
    const dark = planPptx(deck, exportSheets(deck), context("dark"));
    expect(dark.slides[0]!.background).toMatchObject({ kind: "color", color: { hex: "0F172B" } });
    expect(dark.slides[0]!.items.find((item) => item.options.objectName === "Title")).toMatchObject(
      {
        options: { color: "F8FAFC" },
      },
    );
  });
});

describe("writePptx", () => {
  it("writes editable text, shapes, pictures and speaker notes", async () => {
    const plan = planPptx(deck, exportSheets(deck), context());
    const bytes = await writePptx(
      plan,
      plan.rasters.map(() => PNG_1X1),
      { title: deck.title },
    );
    const entries = await readZipText(bytes);
    const slides = slideXml(entries);
    expect(slides).toHaveLength(2);
    expect(entries.get("ppt/presentation.xml")).toContain('<p:sldSz cx="12192000" cy="6858000"');
    expect(textRuns(slides[0]!)).toEqual(["Quarterly review"]);
    expect(slides[0]).toContain('prst="roundRect"');
    expect(slides[0]).toContain('prst="ellipse"');
    expect(slides[1]).toContain("<a:custGeom>");
    expect(slides[1]!.match(/<p:pic>/g)).toHaveLength(4);
    expect(slides[1]).toContain("<p:bg><p:bgPr><a:blipFill");
    const notes = [...entries.entries()]
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      // The first run is the notes body; the second is the slide number field.
      .map(([, xml]) => textRuns(xml)[0]);
    expect(notes).toContain("Open with the headline number.");
    expect(notes.join("")).not.toContain("Never shown");
  });
});

describe("exportPptx", () => {
  it("renders every image part in one browser batch", async () => {
    const calls: number[] = [];
    const result = await Effect.runPromise(
      exportPptx({
        document: deck,
        sheets: exportSheets(deck),
        context: context(),
        render: fakeRender(calls),
      }),
    );
    expect(calls).toEqual([4]);
    expect(result).toMatchObject({ width: 1920, height: 1080 });
    expect(Buffer.from(result.bytes).subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("refuses a deck whose slides are all skipped", async () => {
    const skipped = { ...deck, pages: deck.pages.map((page) => ({ ...page, skipped: true })) };
    const failure = await Effect.runPromise(
      Effect.flip(
        exportPptx({
          document: skipped,
          sheets: exportSheets(skipped),
          context: context(),
          render: fakeRender([]),
        }),
      ),
    );
    expect(failure).toMatchObject({ code: "invalid" });
  });
});

describe("helpers", () => {
  it("picks the first named font and maps generic families", () => {
    expect(pptxFontFace('"Inter Var", Inter, system-ui, sans-serif')).toBe("Inter Var");
    expect(pptxFontFace("system-ui, -apple-system, sans-serif")).toBe("Arial");
    expect(pptxFontFace("ui-monospace, monospace")).toBe("Courier New");
    expect(pptxFontFace(undefined)).toBe("Arial");
  });

  it("reads PNG, GIF and JPEG sizes from their headers", () => {
    expect(imagePixelSize(PHOTO)).toEqual({ width: 400, height: 200 });
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    expect(imagePixelSize(gif)).toEqual({ width: 1, height: 1 });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00,
      0x40, 0x03,
    ]);
    expect(imagePixelSize(jpeg)).toEqual({ width: 64, height: 48 });
    expect(imagePixelSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("pptxgenjs dependencies", () => {
  // pnpm-workspace.yaml cuts pptxgenjs's image-size (1.x has GHSA-5p2g-fcmc-qvqq and
  // GHSA-w3rx-r6r6-pgpr) and its empty `https` placeholder. That is safe only while
  // neither build pptxgenjs ships loads them; this fails if an upgrade starts to.
  it("never loads image-size or the https package", () => {
    const entry = createRequire(import.meta.url).resolve("pptxgenjs");
    const dist = NodePath.dirname(entry);
    for (const build of ["pptxgen.es.js", "pptxgen.cjs.js"]) {
      const source = NodeFS.readFileSync(NodePath.join(dist, build), "utf8");
      expect(source, build).not.toMatch(
        /(require\(|import\(|from\s*)\s*["'](image-size|https)["']/,
      );
    }
    expect(() => createRequire(entry).resolve("image-size")).toThrow();
  });
});
