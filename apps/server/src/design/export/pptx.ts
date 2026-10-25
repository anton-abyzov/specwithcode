/**
 * PowerPoint export of a design or slide deck, written with pptxgenjs (MIT).
 * Text stays editable text and frames, rectangles, ellipses, lines and paths
 * stay shapes, with token values resolved in the export's mode. What
 * PowerPoint cannot express (HTML and component nodes, SVG or rounded images,
 * paints such as gradients, rotated frames with children) is drawn by the
 * shared renderer in headless Chrome and placed as a transparent image. Each
 * slide carries its page's speaker notes.
 *
 * Known differences from the canvas: a frame does not clip children that
 * overflow it, and PowerPoint's own text layout decides line breaks.
 */
import { DesignError, type DesignDocument, type DesignNode } from "@specweave-studio/contracts";
import {
  designChildren,
  designPageBounds,
  designTokenValue,
  NOTE_COLORS,
  resolveDesignLength,
  resolveDesignPaint,
  safeCssValue,
  type DesignRenderContext,
} from "@specweave-studio/shared/designRender";
import * as Effect from "effect/Effect";
import PptxModule from "pptxgenjs";

import type * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import { MAX_FIXED_CAPTURE_EDGE } from "../../htmlRender/headlessChrome.ts";
import { parseCssColor, type PptxColor } from "./cssColor.ts";
import { rasterJob, type DesignSheet, type RasterJob } from "./sheets.ts";

export const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Canvas pixels per slide inch: a 1920 x 1080 slide is PowerPoint's 13.33 x 7.5 in widescreen. */
const PX_PER_INCH = 144;
/** PowerPoint's single line spacing is about 1.2 em; CSS line-height counts whole ems. */
const SINGLE_LINE = 1.2;
const RASTER_SCALE = 2;
const MAX_SLIDES = 500;
const MAX_RASTERS = 400;
const INK: PptxColor = { hex: "1F1D24", transparency: 0 };

// pptxgenjs types its ES module as CommonJS, so under NodeNext its default
// export reads as the module; at run time it is the class itself.
type Pptx = typeof PptxModule.default;
const PptxGenJS = (
  "default" in PptxModule ? (PptxModule as { default: Pptx }).default : PptxModule
) as Pptx;
type ImageProps = import("pptxgenjs").default.ImageProps;
type ShapeProps = import("pptxgenjs").default.ShapeProps;
type TextPropsOptions = import("pptxgenjs").default.TextPropsOptions;
type PptxShapeName = import("pptxgenjs").default.SHAPE_NAME;

const failure = (code: DesignError["code"], detail: string) => new DesignError({ code, detail });

/** A part of a slide drawn by the shared renderer, rendered in one batch. */
export type PptxRasterJob = RasterJob;

type ImagePlacement = Omit<ImageProps, "data" | "path">;

export type PptxItem =
  | {
      readonly kind: "shape";
      readonly shape: "rect" | "roundRect" | "ellipse" | "line" | "custGeom";
      readonly options: ShapeProps;
    }
  | { readonly kind: "text"; readonly text: string; readonly options: TextPropsOptions }
  | { readonly kind: "image"; readonly data: string; readonly options: ImagePlacement }
  | { readonly kind: "raster"; readonly job: number; readonly options: ImagePlacement };

export interface PptxSlidePlan {
  readonly background:
    | { readonly kind: "color"; readonly color: PptxColor }
    | { readonly kind: "raster"; readonly job: number }
    | null;
  readonly items: ReadonlyArray<PptxItem>;
  readonly notes: string | undefined;
}

export interface PptxPlan {
  /** Slide size in inches. */
  readonly width: number;
  readonly height: number;
  readonly slides: ReadonlyArray<PptxSlidePlan>;
  readonly rasters: ReadonlyArray<PptxRasterJob>;
}

const GENERIC_FONTS: Readonly<Record<string, string>> = {
  serif: "Times New Roman",
  "ui-serif": "Times New Roman",
  monospace: "Courier New",
  "ui-monospace": "Courier New",
};

/** The first named family of a CSS font stack; generic families map to fonts Office ships. */
export function pptxFontFace(stack: string | undefined): string {
  const families = (stack ?? "")
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family !== "");
  for (const family of families) {
    const generic = GENERIC_FONTS[family.toLowerCase()];
    if (generic !== undefined) return generic;
    if (
      !/^(system-ui|-apple-system|blinkmacsystemfont|sans-serif|ui-sans-serif|ui-rounded|cursive|fantasy|emoji|math)$/i.test(
        family,
      )
    ) {
      return family;
    }
  }
  return "Arial";
}

/** Pixel size of a PNG, GIF or JPEG from its header, for cover and contain crops. */
export function imagePixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && view.getUint32(0) === 0x47494638) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
}

const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

const decodeDataUrl = (url: string) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match === null ? null : { mimeType: match[1]!.toLowerCase(), base64: match[2]! };
};

/** Lays out every sheet as slide items; pure, so tests can read the plan without a browser. */
export function planPptx(
  document: DesignDocument,
  sheets: ReadonlyArray<DesignSheet>,
  context: DesignRenderContext,
): PptxPlan {
  const sizes = sheets.map((sheet) => sheetSize(sheet));
  const first = sizes[0] ?? { width: 1920, height: 1080 };
  const rasters: PptxRasterJob[] = [];
  const notedPages = new Set<string>();
  const slides = sheets.map((sheet, index) => {
    const notes = notedPages.has(sheet.page.id) ? undefined : sheet.page.notes;
    notedPages.add(sheet.page.id);
    return planSheet(document, sheet, sizes[index]!, first, context, rasters, notes);
  });
  return {
    width: first.width / PX_PER_INCH,
    height: first.height / PX_PER_INCH,
    slides,
    rasters,
  };
}

function sheetSize(sheet: DesignSheet) {
  if (sheet.target.frameId !== undefined) {
    const frame = sheet.page.nodes.find((node) => node.id === sheet.target.frameId);
    if (frame !== undefined) return { width: frame.width, height: frame.height };
  }
  const bounds = designPageBounds(sheet.page);
  return { width: bounds.width, height: bounds.height };
}

function planSheet(
  document: DesignDocument,
  sheet: DesignSheet,
  size: { readonly width: number; readonly height: number },
  slideSize: { readonly width: number; readonly height: number },
  context: DesignRenderContext,
  rasters: PptxRasterJob[],
  notes: string | undefined,
): PptxSlidePlan {
  const { page } = sheet;
  const children = designChildren(page);
  // A sheet of another size is scaled to fit the deck's slide and centered.
  const k = Math.min(slideSize.width / size.width, slideSize.height / size.height);
  const dx = (slideSize.width - size.width * k) / 2;
  const dy = (slideSize.height - size.height * k) / 2;
  const inch = (px: number) => (px * k) / PX_PER_INCH;
  const pt = (px: number) => (px * k * 72) / PX_PER_INCH;
  const items: PptxItem[] = [];
  let background: PptxSlidePlan["background"] = null;

  const fade = (color: PptxColor, alpha: number) =>
    Math.round(100 - (100 - color.transparency) * alpha);
  const place = (node: DesignNode, x: number, y: number) => ({
    x: (dx + x * k) / PX_PER_INCH,
    y: (dy + y * k) / PX_PER_INCH,
    w: inch(node.width),
    h: inch(node.height),
    ...(node.rotation === undefined || node.rotation === 0 ? {} : { rotate: node.rotation }),
    objectName: node.name ?? node.id,
  });

  const raster = (node: DesignNode, withChildren: boolean): number =>
    rasters.push(rasterJob(document, page, node, withChildren, context)) - 1;
  const addRaster = (
    node: DesignNode,
    x: number,
    y: number,
    alpha: number,
    withChildren: boolean,
  ) =>
    items.push({
      kind: "raster",
      job: raster(node, withChildren),
      options: {
        ...place(node, x, y),
        ...(alpha < 1 ? { transparency: Math.round((1 - alpha) * 100) } : {}),
      },
    });

  /** A literal or token paint: absent, a PowerPoint color, or unsupported (drawn as an image). */
  const paint = (value: Parameters<typeof resolveDesignPaint>[0]) => {
    const css = resolveDesignPaint(value, context);
    if (css === undefined) return { kind: "none" } as const;
    const color = parseCssColor(css);
    return color === null
      ? ({ kind: "unsupported" } as const)
      : ({ kind: "color", color } as const);
  };

  const shape = (
    node: Extract<DesignNode, { type: "frame" | "rect" | "ellipse" }>,
    x: number,
    y: number,
    alpha: number,
  ): boolean => {
    const fill = paint(node.fill);
    const stroke = paint(node.stroke);
    if (fill.kind === "unsupported" || stroke.kind === "unsupported") return false;
    if (fill.kind === "none" && stroke.kind === "none") return true;
    // CSS borders sit inside the box; PowerPoint centers a line on the edge.
    const strokeWidth = stroke.kind === "color" ? (node.strokeWidth ?? 1) : 0;
    const inset = {
      ...node,
      width: Math.max(0, node.width - strokeWidth),
      height: Math.max(0, node.height - strokeWidth),
    };
    const box = place(inset, x + strokeWidth / 2, y + strokeWidth / 2);
    const radius = node.type === "ellipse" ? undefined : resolveDesignLength(node.radius, context);
    const rounded = radius !== undefined && radius > 0;
    items.push({
      kind: "shape",
      shape: node.type === "ellipse" ? "ellipse" : rounded ? "roundRect" : "rect",
      options: {
        ...box,
        fill:
          fill.kind === "color"
            ? { type: "solid", color: fill.color.hex, transparency: fade(fill.color, alpha) }
            : { type: "none" },
        line:
          stroke.kind === "color"
            ? {
                color: stroke.color.hex,
                width: pt(strokeWidth),
                transparency: fade(stroke.color, alpha),
              }
            : { type: "none" },
        ...(rounded ? { rectRadius: inch(Math.min(radius, node.width / 2, node.height / 2)) } : {}),
      },
    });
    return true;
  };

  const path = (
    node: Extract<DesignNode, { type: "line" | "path" }>,
    x: number,
    y: number,
    alpha: number,
  ) => {
    const stroke = parseCssColor(resolveDesignPaint(node.stroke, context)) ?? INK;
    const fill = node.type === "path" ? paint(node.fill) : ({ kind: "none" } as const);
    if (fill.kind === "unsupported") return addRaster(node, x, y, alpha, false);
    const line = {
      color: stroke.hex,
      width: pt(node.strokeWidth ?? 2),
      transparency: fade(stroke, alpha),
    };
    const [start, end] = node.points;
    if (node.points.length === 2 && node.closed !== true && fill.kind === "none") {
      const [x0, y0] = start!;
      const [x1, y1] = end!;
      const box = place(
        { ...node, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) },
        x + Math.min(x0, x1),
        y + Math.min(y0, y1),
      );
      // PowerPoint draws a line from the top left to the bottom right of its box.
      const rising = (x1 - x0) * (y1 - y0) < 0;
      items.push({
        kind: "shape",
        shape: "line",
        options: { ...box, line, ...(rising ? { flipV: true } : {}) },
      });
      return;
    }
    items.push({
      kind: "shape",
      shape: "custGeom",
      options: {
        ...place(
          { ...node, width: Math.max(node.width, 1), height: Math.max(node.height, 1) },
          x,
          y,
        ),
        line,
        fill:
          fill.kind === "color"
            ? { type: "solid", color: fill.color.hex, transparency: fade(fill.color, alpha) }
            : { type: "none" },
        points: [
          ...node.points.map(([px, py]) => ({ x: inch(px), y: inch(py) })),
          ...(node.closed === true ? [{ close: true as const }] : []),
        ],
      },
    });
  };

  const text = (
    node: Extract<DesignNode, { type: "text" }>,
    x: number,
    y: number,
    alpha: number,
  ) => {
    const color = parseCssColor(resolveDesignPaint(node.color, context)) ?? INK;
    const family =
      node.fontFamily === undefined
        ? undefined
        : typeof node.fontFamily === "string"
          ? safeCssValue(node.fontFamily)
          : (designTokenValue(context.system, node.fontFamily.token, context.mode) ?? undefined);
    const fontSize = resolveDesignLength(node.fontSize, context) ?? 16;
    items.push({
      kind: "text",
      text: node.text,
      options: {
        ...place(node, x, y),
        isTextBox: true,
        margin: 0,
        valign: "top",
        wrap: true,
        fit: "none",
        fontFace: pptxFontFace(family),
        fontSize: pt(fontSize),
        color: color.hex,
        transparency: fade(color, alpha),
        bold: (node.fontWeight ?? 400) >= 600,
        align: node.align ?? "left",
        lineSpacingMultiple: Math.max(0.5, (node.lineHeight ?? 1.4) / SINGLE_LINE),
        paraSpaceBefore: 0,
        paraSpaceAfter: 0,
        ...(node.letterSpacing === undefined || node.letterSpacing === 0
          ? {}
          : { charSpacing: pt(node.letterSpacing) }),
      },
    });
  };

  const image = (
    node: Extract<DesignNode, { type: "image" }>,
    x: number,
    y: number,
    alpha: number,
  ) => {
    const decoded = decodeDataUrl(context.assetUrl(node.asset));
    const radius = resolveDesignLength(node.radius, context);
    const fit = node.fit ?? "cover";
    const size =
      decoded === null || fit === "fill"
        ? null
        : imagePixelSize(Buffer.from(decoded.base64, "base64"));
    if (
      decoded === null ||
      !NATIVE_IMAGE_TYPES.has(decoded.mimeType) ||
      (radius !== undefined && radius > 0) ||
      (fit !== "fill" && size === null)
    ) {
      return addRaster(node, x, y, alpha, false);
    }
    const box = place(node, x, y);
    const options: ImagePlacement = {
      ...box,
      ...(node.alt === undefined ? {} : { altText: node.alt }),
      ...(alpha < 1 ? { transparency: Math.round((1 - alpha) * 100) } : {}),
      ...(size === null
        ? {}
        : {
            // pptxgenjs reads w and h as the picture's proportions and sizing as its box.
            h: box.w * (size.height / Math.max(1, size.width)),
            sizing: { type: fit === "contain" ? "contain" : "cover", w: box.w, h: box.h },
          }),
    };
    items.push({ kind: "image", data: `${decoded.mimeType};base64,${decoded.base64}`, options });
  };

  const walk = (node: DesignNode, ox: number, oy: number, inherited: number) => {
    if (node.hidden === true) return;
    const alpha = inherited * (node.opacity ?? 1);
    const x = ox + node.x;
    const y = oy + node.y;
    switch (node.type) {
      case "frame": {
        const kids = children.get(node.id) ?? [];
        // PowerPoint cannot rotate a frame together with its children.
        if (node.rotation !== undefined && node.rotation !== 0 && kids.length > 0) {
          return addRaster(node, x, y, alpha, true);
        }
        if (!shape(node, x, y, alpha)) addRaster(node, x, y, alpha, false);
        for (const kid of kids) walk(kid, x, y, alpha);
        return;
      }
      case "rect":
      case "ellipse":
        if (!shape(node, x, y, alpha)) addRaster(node, x, y, alpha, false);
        return;
      case "line":
      case "path":
        return path(node, x, y, alpha);
      case "text":
        return text(node, x, y, alpha);
      case "note":
        items.push({
          kind: "text",
          text: node.text,
          options: {
            ...place(node, x, y),
            isTextBox: true,
            margin: pt(12),
            valign: "top",
            wrap: true,
            fit: "none",
            fontFace: "Arial",
            fontSize: pt(14),
            color: INK.hex,
            fill: {
              type: "solid",
              color: NOTE_COLORS[node.color ?? "yellow"].slice(1).toUpperCase(),
            },
            lineSpacingMultiple: 1.4 / SINGLE_LINE,
          },
        });
        return;
      case "image":
        return image(node, x, y, alpha);
      case "html":
      case "component":
        return addRaster(node, x, y, alpha, false);
    }
  };

  const frame =
    sheet.target.frameId === undefined
      ? undefined
      : page.nodes.find((node) => node.id === sheet.target.frameId);
  if (frame !== undefined && frame.type === "frame") {
    // The slide frame is the slide: its fill is the background, its children the content.
    const fill = paint(frame.fill);
    const alpha = frame.opacity ?? 1;
    if (fill.kind === "color") {
      background = {
        kind: "color",
        color: { hex: fill.color.hex, transparency: fade(fill.color, alpha) },
      };
    } else if (fill.kind === "unsupported") {
      background = { kind: "raster", job: raster({ ...frame, x: 0, y: 0 }, false) };
    }
    const stroke = paint(frame.stroke);
    if (stroke.kind !== "none") {
      const { fill: _fill, ...outline } = frame;
      shape({ ...outline, x: 0, y: 0 }, 0, 0, alpha);
    }
    for (const kid of children.get(frame.id) ?? []) walk(kid, 0, 0, alpha);
  } else if (frame !== undefined) {
    walk({ ...frame, x: 0, y: 0, rotation: 0 }, 0, 0, 1);
  } else {
    const bounds = designPageBounds(page);
    for (const root of children.get(null) ?? []) walk(root, -bounds.x, -bounds.y, 1);
  }
  return { background, items, notes: notes?.trim() === "" ? undefined : notes };
}

/** Writes a planned deck; `rasters` are base64 PNGs in job order. */
export async function writePptx(
  plan: PptxPlan,
  rasters: ReadonlyArray<string>,
  meta: { readonly title: string },
): Promise<Uint8Array> {
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "DESIGN", width: plan.width, height: plan.height });
  pres.layout = "DESIGN";
  pres.title = meta.title;
  pres.author = "SpecWithCode";
  pres.company = "SpecWithCode";
  const shapes = {
    rect: pres.ShapeType.rect,
    roundRect: pres.ShapeType.roundRect,
    ellipse: pres.ShapeType.ellipse,
    line: pres.ShapeType.line,
    // Custom geometry is missing from the ShapeType typings, not from the writer.
    custGeom: "custGeom" as PptxShapeName,
  } as const;
  const rasterData = (job: number) => `image/png;base64,${rasters[job] ?? ""}`;
  for (const planned of plan.slides) {
    const slide = pres.addSlide();
    if (planned.background?.kind === "color") {
      slide.background = {
        color: planned.background.color.hex,
        transparency: planned.background.color.transparency,
      };
    } else if (planned.background?.kind === "raster") {
      slide.background = { data: rasterData(planned.background.job) };
    }
    for (const item of planned.items) {
      switch (item.kind) {
        case "shape":
          slide.addShape(shapes[item.shape], { ...item.options });
          break;
        case "text":
          slide.addText(item.text, { ...item.options });
          break;
        case "image":
          slide.addImage({ ...item.options, data: item.data });
          break;
        case "raster":
          slide.addImage({ ...item.options, data: rasterData(item.job) });
          break;
      }
    }
    if (planned.notes !== undefined) slide.addNotes(planned.notes);
  }
  const written = await pres.write({ outputType: "uint8array", compression: true });
  return written as Uint8Array;
}

export const exportPptx = Effect.fn("DesignExport.exportPptx")(function* (input: {
  readonly document: DesignDocument;
  readonly sheets: ReadonlyArray<DesignSheet>;
  readonly context: DesignRenderContext;
  readonly render: HtmlRender.HtmlRender["Service"];
}) {
  if (input.sheets.length === 0) return yield* failure("invalid", "There is nothing to export.");
  if (input.sheets.length > MAX_SLIDES) {
    return yield* failure("too_large", `A PPTX holds at most ${MAX_SLIDES} slides.`);
  }
  const plan = planPptx(input.document, input.sheets, input.context);
  if (plan.rasters.length > MAX_RASTERS) {
    return yield* failure(
      "too_large",
      `The deck has ${plan.rasters.length} HTML, component or styled parts that export as images; the limit is ${MAX_RASTERS}.`,
    );
  }
  if (
    plan.rasters.some(
      (job) => Math.max(job.width, job.height) * RASTER_SCALE > MAX_FIXED_CAPTURE_EDGE,
    )
  ) {
    return yield* failure(
      "too_large",
      `An HTML or component node edge can be at most ${MAX_FIXED_CAPTURE_EDGE / RASTER_SCALE} pixels in a PPTX.`,
    );
  }
  const images = yield* input.render
    .captureImages({ items: plan.rasters, scale: RASTER_SCALE })
    .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
  const bytes = yield* Effect.tryPromise({
    try: () => writePptx(plan, images, { title: input.document.title }),
    catch: () => failure("operation_failed", "The PPTX file could not be written."),
  });
  return {
    bytes,
    width: Math.round(plan.width * PX_PER_INCH),
    height: Math.round(plan.height * PX_PER_INCH),
  };
});
