/**
 * Native SVG of one frame or a whole page. Frames, rectangles, ellipses, lines,
 * paths, images, notes and text become SVG shapes and text, so the file opens
 * and stays editable in browsers and design tools. It never uses foreignObject,
 * which librsvg, Figma, Illustrator and Inkscape drop. SVG text does not wrap,
 * so line breaks are measured in the same headless Chrome that renders PNGs.
 * HTML and component nodes and paints SVG cannot take (gradients) are drawn by
 * the shared renderer and embedded as 2x PNGs, as in the PPTX export; those
 * parts are not vector. Fonts are named, not embedded, as in the HTML export.
 */
import { DesignError, type DesignDocument, type DesignNode } from "@specweave-studio/contracts";
import {
  designChildren,
  designPageBounds,
  designPathData,
  designTokenValue,
  escapeHtml,
  NOTE_COLORS,
  renderDesignHtml,
  resolveDesignLength,
  resolveDesignPaint,
  safeCssValue,
  type DesignHtmlTarget,
  type DesignRenderContext,
} from "@specweave-studio/shared/designRender";
import * as Effect from "effect/Effect";

import type * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import { MAX_FIXED_CAPTURE_EDGE, type TextLines } from "../../htmlRender/headlessChrome.ts";
import { parseCssColor, type PptxColor } from "./cssColor.ts";
import { rasterJob, type RasterJob } from "./sheets.ts";

const RASTER_SCALE = 2;
const MAX_RASTERS = 400;
const MAX_MEASURED_CHARS = 200_000;
const INK: PptxColor = { hex: "1F1D24", transparency: 0 };
/** The body font of `renderDesignHtml`, which text without a family inherits. */
const BODY_FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif';

/** A text element set line by line once its text is measured; `open` is its start tag. */
export interface SvgText {
  readonly node: string;
  readonly text: string;
  /** Where each line is anchored, and the padding above the first line. */
  readonly x: number;
  readonly top: number;
  readonly size: number;
  readonly lineHeight: number;
  readonly open: string;
}
export type SvgPiece = string | SvgText | { readonly raster: number };

export interface SvgPlan {
  readonly width: number;
  readonly height: number;
  readonly pieces: ReadonlyArray<SvgPiece>;
  readonly rasters: ReadonlyArray<RasterJob>;
  /** The target's text and notes on one page, to measure their lines; null without text. */
  readonly measure: RasterJob | null;
  readonly measuredChars: number;
}

type Paint =
  | { readonly kind: "none" }
  | { readonly kind: "color"; readonly color: PptxColor }
  | { readonly kind: "unsupported" };

const failure = (code: DesignError["code"], detail: string) => new DesignError({ code, detail });
const num = (value: number) => String(Math.round(value * 100) / 100);
/**
 * Character data or an attribute value, without the characters XML 1.0 cannot
 * hold: controls other than tab and line breaks, U+FFFE, U+FFFF and lone
 * surrogates. Emoji and other characters above U+FFFF stay.
 */
const xml = (value: string) =>
  escapeHtml(
    [...value]
      .filter((character) => {
        const code = character.codePointAt(0)!;
        if (code < 0x20) return code === 9 || code === 10 || code === 13;
        return code !== 0xfffe && code !== 0xffff && (code < 0xd800 || code > 0xdfff);
      })
      .join(""),
  );
const paintAttrs = (name: "fill" | "stroke", paint: Paint) =>
  paint.kind !== "color"
    ? `${name}="none"`
    : `${name}="#${paint.color.hex}"${paint.color.transparency > 0 ? ` ${name}-opacity="${num(1 - paint.color.transparency / 100)}"` : ""}`;

/** Lays out the target as SVG markup with text and raster placeholders; pure, for tests. */
export function planSvg(
  document: DesignDocument,
  target: DesignHtmlTarget,
  context: DesignRenderContext,
): SvgPlan {
  const page = document.pages.find((candidate) => candidate.id === target.pageId);
  if (page === undefined) throw new Error(`No page ${target.pageId}.`);
  const children = designChildren(page);
  const pieces: SvgPiece[] = [];
  const rasters: RasterJob[] = [];
  const measured: DesignNode[] = [];
  let clips = 0;

  const paintOf = (value: Parameters<typeof resolveDesignPaint>[0]): Paint => {
    const css = resolveDesignPaint(value, context);
    if (css === undefined) return { kind: "none" };
    const color = parseCssColor(css);
    return color === null ? { kind: "unsupported" } : { kind: "color", color };
  };
  const raster = (node: DesignNode) =>
    pieces.push({ raster: rasters.push(rasterJob(document, page, node, false, context)) - 1 });
  /** A clipPath of a rounded box from 0,0; returns the attribute that applies it. */
  const clip = (width: number, height: number, radius: number) => {
    // Node ids never hold a dot, so these ids cannot collide with a layer's.
    const id = `clip.${++clips}`;
    const rx = Math.min(radius, width / 2, height / 2);
    pieces.push(
      `<clipPath id="${id}"><rect width="${num(width)}" height="${num(height)}"${rx > 0 ? ` rx="${num(rx)}"` : ""}/></clipPath>`,
    );
    return ` clip-path="url(#${id})"`;
  };
  const text = (
    node: Extract<DesignNode, { type: "text" | "note" }>,
    style: { family: string; size: number; weight: string; color: PptxColor; anchor: string },
    x: number,
    top: number,
    lineHeight: number,
  ) => {
    measured.push(node);
    pieces.push({
      node: node.id,
      // The measuring page's HTML parser turns CR LF and CR into LF, so indices match.
      text: node.text.replace(/\r\n?/g, "\n"),
      x,
      top,
      size: style.size,
      lineHeight,
      open: `<text font-family="${xml(style.family)}" font-size="${num(style.size)}"${style.weight} ${paintAttrs("fill", { kind: "color", color: style.color })} text-anchor="${style.anchor}" xml:space="preserve">`,
    });
  };

  const walk = (node: DesignNode) => {
    if (node.hidden === true) return;
    const rotate =
      node.rotation === undefined || node.rotation === 0
        ? ""
        : ` rotate(${num(node.rotation)} ${num(node.width / 2)} ${num(node.height / 2)})`;
    const name = node.name === undefined ? "" : ` data-name="${xml(node.name)}"`;
    const opacity =
      node.opacity === undefined || node.opacity === 1 ? "" : ` opacity="${num(node.opacity)}"`;
    pieces.push(
      `<g id="${node.id}"${name} transform="translate(${num(node.x)} ${num(node.y)})${rotate}"${opacity}>`,
    );
    const { width: w, height: h } = node;
    switch (node.type) {
      case "frame":
      case "rect":
      case "ellipse": {
        const fill = paintOf(node.fill);
        const stroke = paintOf(node.stroke);
        // A CSS border sits inside the box and moves the children in by its width.
        const sw = stroke.kind === "none" ? 0 : (node.strokeWidth ?? 1);
        const radius =
          node.type === "ellipse" ? 0 : (resolveDesignLength(node.radius, context) ?? 0);
        if (fill.kind === "unsupported" || stroke.kind === "unsupported") raster(node);
        else if (fill.kind === "color" || stroke.kind === "color") {
          const paint = `${paintAttrs("fill", fill)}${stroke.kind === "color" ? ` ${paintAttrs("stroke", stroke)} stroke-width="${num(sw)}"` : ""}`;
          if (node.type === "ellipse") {
            pieces.push(
              `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(Math.max(0, (w - sw) / 2))}" ry="${num(Math.max(0, (h - sw) / 2))}" ${paint}/>`,
            );
          } else {
            const rx = Math.max(0, Math.min(radius, w / 2, h / 2) - sw / 2);
            pieces.push(
              `<rect x="${num(sw / 2)}" y="${num(sw / 2)}" width="${num(Math.max(0, w - sw))}" height="${num(Math.max(0, h - sw))}"${rx > 0 ? ` rx="${num(rx)}"` : ""} ${paint}/>`,
            );
          }
        }
        const kids = children.get(node.id) ?? [];
        if (kids.length > 0) {
          const clipped =
            node.type === "frame" && node.clip !== false
              ? clip(Math.max(0, w - 2 * sw), Math.max(0, h - 2 * sw), Math.max(0, radius - sw))
              : "";
          pieces.push(`<g transform="translate(${num(sw)} ${num(sw)})"${clipped}>`);
          for (const kid of kids) walk(kid);
          pieces.push("</g>");
        }
        break;
      }
      case "line":
      case "path": {
        const fill = node.type === "path" ? paintOf(node.fill) : ({ kind: "none" } as const);
        if (fill.kind === "unsupported") {
          raster(node);
          break;
        }
        const color = parseCssColor(resolveDesignPaint(node.stroke, context)) ?? INK;
        pieces.push(
          `<path d="${designPathData(node.points, node.closed === true)}" ${paintAttrs("fill", fill)} ${paintAttrs("stroke", { kind: "color", color })} stroke-width="${num(node.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      }
      case "image": {
        const radius = resolveDesignLength(node.radius, context) ?? 0;
        const clipped = radius > 0 ? clip(w, h, radius) : "";
        const aspect = { cover: "xMidYMid slice", contain: "xMidYMid meet", fill: "none" }[
          node.fit ?? "cover"
        ];
        pieces.push(
          `<image width="${num(w)}" height="${num(h)}" preserveAspectRatio="${aspect}" xlink:href="${xml(context.assetUrl(node.asset))}"${clipped}/>`,
        );
        break;
      }
      case "text": {
        const family =
          node.fontFamily === undefined
            ? undefined
            : typeof node.fontFamily === "string"
              ? safeCssValue(node.fontFamily)
              : (designTokenValue(context.system, node.fontFamily.token, context.mode) ??
                undefined);
        const size = resolveDesignLength(node.fontSize, context) ?? 16;
        const align = node.align ?? "left";
        const spacing =
          node.letterSpacing === undefined ? "" : ` letter-spacing="${num(node.letterSpacing)}"`;
        text(
          node,
          {
            family: family ?? BODY_FONT,
            size,
            weight: `${node.fontWeight === undefined ? "" : ` font-weight="${node.fontWeight}"`}${spacing}`,
            color: parseCssColor(resolveDesignPaint(node.color, context)) ?? INK,
            anchor: align === "center" ? "middle" : align === "right" ? "end" : "start",
          },
          align === "center" ? w / 2 : align === "right" ? w : 0,
          0,
          size * (node.lineHeight ?? 1.4),
        );
        break;
      }
      case "note":
        // The note's drop shadow is left out.
        pieces.push(
          `<rect width="${num(w)}" height="${num(h)}" fill="${NOTE_COLORS[node.color ?? "yellow"]}"/>`,
        );
        text(
          node,
          { family: BODY_FONT, size: 14, weight: "", color: INK, anchor: "start" },
          12,
          12,
          14 * 1.4,
        );
        break;
      case "html":
      case "component":
        raster(node);
        break;
    }
    pieces.push("</g>");
  };

  let width: number;
  let height: number;
  if (target.frameId !== undefined) {
    const frame = page.nodes.find((node) => node.id === target.frameId);
    if (frame === undefined) throw new Error(`No node ${target.frameId}.`);
    width = Math.ceil(frame.width);
    height = Math.ceil(frame.height);
    walk({ ...frame, x: 0, y: 0, rotation: 0 });
  } else {
    const bounds = designPageBounds(page);
    width = Math.ceil(bounds.width);
    height = Math.ceil(bounds.height);
    pieces.push(`<g transform="translate(${num(-bounds.x)} ${num(-bounds.y)})">`);
    for (const root of children.get(null) ?? []) walk(root);
    pieces.push("</g>");
  }

  // Each text node alone at the top left lays out exactly as in the frame.
  const flat = measured.map(
    (node) => ({ ...node, parentId: null, x: 0, y: 0, rotation: 0 }) as DesignNode,
  );
  const measure =
    flat.length === 0
      ? null
      : renderDesignHtml(
          { ...document, pages: [{ ...page, nodes: flat }] },
          { pageId: page.id },
          context,
        );
  return {
    width,
    height,
    pieces,
    rasters,
    measure,
    measuredChars: measured.reduce((sum, node) => sum + ("text" in node ? node.text.length : 0), 0),
  };
}

/** One tspan per line, from the measured line starts or, unmeasured, the hard line breaks. */
function tspans(piece: SvgText, measured: TextLines | undefined): string {
  let at = 0;
  const lines = measured ?? {
    baseline: piece.top + piece.lineHeight / 2 + piece.size * 0.35,
    lineHeight: piece.lineHeight,
    starts: piece.text.split("\n").map((part, line) => {
      const start = [at, line] as const;
      at += part.length + 1;
      return start;
    }),
  };
  return lines.starts
    .map(([from, line], index) => {
      const value = piece.text
        .slice(from, lines.starts[index + 1]?.[0] ?? piece.text.length)
        .trimEnd();
      return value === ""
        ? ""
        : `<tspan x="${num(piece.x)}" y="${num(lines.baseline + line * lines.lineHeight)}">${xml(value)}</tspan>`;
    })
    .join("");
}

/** The SVG file; `rasters` are base64 PNGs in job order. */
export function writeSvg(
  plan: SvgPlan,
  measured: ReadonlyArray<TextLines>,
  rasters: ReadonlyArray<string>,
  title: string,
): string {
  const byNode = new Map(measured.map((lines) => [lines.id, lines]));
  const body = plan.pieces
    .map((piece) => {
      if (typeof piece === "string") return piece;
      if ("raster" in piece) {
        const job = plan.rasters[piece.raster]!;
        return `<image width="${job.width}" height="${job.height}" xlink:href="data:image/png;base64,${rasters[piece.raster] ?? ""}"/>`;
      }
      return `${piece.open}${tspans(piece, byNode.get(piece.node))}</text>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}"><title>${xml(title || "Design")}</title>${body}</svg>\n`;
}

export const exportSvg = Effect.fn("DesignExport.exportSvg")(function* (input: {
  readonly document: DesignDocument;
  readonly target: DesignHtmlTarget;
  readonly context: DesignRenderContext;
  readonly render: HtmlRender.HtmlRender["Service"];
}) {
  const plan = planSvg(input.document, input.target, input.context);
  if (plan.rasters.length > MAX_RASTERS) {
    return yield* failure(
      "too_large",
      `The SVG has ${plan.rasters.length} HTML, component or styled parts that export as images; the limit is ${MAX_RASTERS}.`,
    );
  }
  if (
    plan.rasters.some(
      (job) => Math.max(job.width, job.height) * RASTER_SCALE > MAX_FIXED_CAPTURE_EDGE,
    )
  ) {
    return yield* failure(
      "too_large",
      `An HTML or component node edge can be at most ${MAX_FIXED_CAPTURE_EDGE / RASTER_SCALE} pixels in an SVG.`,
    );
  }
  if (plan.measuredChars > MAX_MEASURED_CHARS) {
    return yield* failure(
      "too_large",
      `The SVG holds ${plan.measuredChars} characters of text; the limit is ${MAX_MEASURED_CHARS}.`,
    );
  }
  const rendered = (error: { readonly message: string }) =>
    failure("operation_failed", error.message);
  // Text nodes sit at explicit positions with explicit widths, so the viewport
  // does not move their line breaks; it is capped like every other capture.
  const lines =
    plan.measure === null
      ? []
      : yield* input.render
          .measureTextLines({
            html: plan.measure.html,
            width: Math.min(plan.measure.width, MAX_FIXED_CAPTURE_EDGE),
            height: Math.min(plan.measure.height, MAX_FIXED_CAPTURE_EDGE),
          })
          .pipe(Effect.mapError(rendered));
  const images = yield* input.render
    .captureImages({ items: plan.rasters, scale: RASTER_SCALE })
    .pipe(Effect.mapError(rendered));
  return {
    text: writeSvg(plan, lines, images, input.document.title),
    width: plan.width,
    height: plan.height,
  };
});
