/**
 * Exports a design as standalone HTML, a PNG of one frame or page, or a PDF
 * or PPTX with one sheet per slide (or per frame of a design) of every page
 * that is not skipped. Every format starts from `renderDesignHtml`, so
 * exports match the canvas, and images are inlined so the file stands alone.
 * PNG, PDF and the PPTX's rendered parts go through the same headless Chrome
 * as `html_render`.
 */
import {
  DesignError,
  type DesignDocument,
  type DesignExportInput,
  type DesignExportResult,
  type DesignPage,
  type DesignSystem,
} from "@specweave-studio/contracts";
import { renderDesignHtml, type DesignRenderContext } from "@specweave-studio/shared/designRender";
import * as Effect from "effect/Effect";

import type * as HtmlRender from "../htmlRender/HtmlRender.ts";
import { MAX_FIXED_CAPTURE_EDGE } from "../htmlRender/headlessChrome.ts";
import { exportPptx, PPTX_MIME_TYPE } from "./export/pptx.ts";
import { exportSheets, type DesignSheet } from "./export/sheets.ts";

/** A transparent pixel stands in for an image file that is missing. */
const MISSING_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const MAX_PDF_SHEETS = 500;

export interface DesignExportSource {
  readonly document: DesignDocument;
  readonly system: DesignSystem | null;
  readonly input: DesignExportInput;
  readonly readAsset: (
    asset: string,
  ) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | null>;
  readonly render: HtmlRender.HtmlRender["Service"];
}

const failure = (code: DesignError["code"], detail: string) => new DesignError({ code, detail });

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "design";

const bodyOf = (html: string) =>
  html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));

const loadAssets = (source: DesignExportSource, pages: readonly DesignPage[]) =>
  Effect.tryPromise({
    try: async () => {
      const urls = new Map<string, string>();
      for (const page of pages) {
        for (const node of page.nodes) {
          if (node.type !== "image" || urls.has(node.asset)) continue;
          const read = await source.readAsset(node.asset);
          urls.set(
            node.asset,
            read === null
              ? MISSING_IMAGE
              : `data:${read.mimeType};base64,${Buffer.from(read.bytes).toString("base64")}`,
          );
        }
      }
      return urls;
    },
    catch: () => failure("operation_failed", "The design's images could not be read."),
  });

const renderFailure = (error: { readonly message: string }) =>
  failure("operation_failed", error.message);

export const exportDesign = Effect.fn("DesignExport.exportDesign")(function* (
  source: DesignExportSource,
) {
  const { document, input } = source;
  const page = document.pages.find((candidate) => candidate.id === input.pageId);
  if (page === undefined) return yield* failure("not_found", `No page ${input.pageId}.`);
  const whole = input.format === "pdf" || input.format === "pptx";
  const sheets = whole ? exportSheets(document) : [];
  const pages = whole ? [...new Set(sheets.map((sheet) => sheet.page))] : [page];
  const assets = yield* loadAssets(source, pages);
  const context: DesignRenderContext = {
    system: source.system,
    mode: input.mode ?? source.system?.modes[0]?.id ?? "light",
    assetUrl: (asset) => assets.get(asset) ?? MISSING_IMAGE,
  };
  const base = slug(document.title);

  if (input.format === "pdf") return yield* exportPdf(source, sheets, context, base);
  if (input.format === "pptx") {
    const pptx = yield* exportPptx({ document, sheets, context, render: source.render });
    return {
      fileName: `${base}.pptx`,
      mimeType: PPTX_MIME_TYPE,
      data: Buffer.from(pptx.bytes).toString("base64"),
      width: pptx.width,
      height: pptx.height,
    } satisfies DesignExportResult;
  }

  if (input.frameId !== undefined && !page.nodes.some((node) => node.id === input.frameId)) {
    return yield* failure("not_found", `No frame ${input.frameId} on that page.`);
  }
  const rendered = renderDesignHtml(
    document,
    input.frameId === undefined ? { pageId: page.id } : { pageId: page.id, frameId: input.frameId },
    context,
  );
  const frameName =
    input.frameId === undefined
      ? page.name
      : (page.nodes.find((node) => node.id === input.frameId)?.name ?? input.frameId);
  const name = `${base}-${slug(frameName)}`;
  if (input.format === "html") {
    return {
      fileName: `${name}.html`,
      mimeType: "text/html",
      data: Buffer.from(rendered.html, "utf8").toString("base64"),
      width: rendered.width,
      height: rendered.height,
    } satisfies DesignExportResult;
  }
  const scale = input.scale ?? 1;
  if (Math.max(rendered.width, rendered.height) * scale > MAX_FIXED_CAPTURE_EDGE) {
    return yield* failure(
      "too_large",
      `That is ${rendered.width} x ${rendered.height}; a PNG edge can be at most ${MAX_FIXED_CAPTURE_EDGE / scale} pixels at ${scale}x. Export a single frame.`,
    );
  }
  const data = yield* source.render
    .capture({
      html: rendered.html,
      width: rendered.width,
      height: rendered.height,
      scale,
      format: "png",
    })
    .pipe(Effect.mapError(renderFailure));
  return {
    fileName: `${name}${scale === 2 ? "@2x" : ""}.png`,
    mimeType: "image/png",
    data,
    width: rendered.width * scale,
    height: rendered.height * scale,
  } satisfies DesignExportResult;
});

/** One PDF page per sheet, each at its own size. */
const exportPdf = Effect.fn("DesignExport.exportPdf")(function* (
  source: DesignExportSource,
  targets: ReadonlyArray<DesignSheet>,
  context: DesignRenderContext,
  base: string,
) {
  if (targets.length === 0) return yield* failure("invalid", "There is nothing to export.");
  if (targets.length > MAX_PDF_SHEETS) {
    return yield* failure("too_large", `A PDF holds at most ${MAX_PDF_SHEETS} pages.`);
  }
  const sheets = targets.map((sheet) => {
    const rendered = renderDesignHtml(source.document, sheet.target, context);
    return { body: bodyOf(rendered.html), width: rendered.width, height: rendered.height };
  });
  if (sheets.some((sheet) => Math.max(sheet.width, sheet.height) > MAX_FIXED_CAPTURE_EDGE)) {
    return yield* failure(
      "too_large",
      `A frame edge can be at most ${MAX_FIXED_CAPTURE_EDGE} pixels.`,
    );
  }
  // Named pages give each sheet its own paper size.
  const css = sheets
    .map(
      (sheet, index) =>
        `@page s${index}{size:${sheet.width}px ${sheet.height}px;margin:0}.s${index}{page:s${index};width:${sheet.width}px;height:${sheet.height}px}`,
    )
    .join("");
  const body = sheets
    .map((sheet, index) => `<section class="s${index}">${sheet.body}</section>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${base}</title><style>html,body{margin:0;padding:0}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}section{position:relative;overflow:hidden;break-after:page}section:last-child{break-after:auto}${css}</style></head><body>${body}</body></html>`;
  const width = Math.max(...sheets.map((sheet) => sheet.width));
  const data = yield* source.render
    .capture({ html, width, height: sheets[0]!.height, scale: 1, format: "pdf" })
    .pipe(Effect.mapError(renderFailure));
  return {
    fileName: `${base}.pdf`,
    mimeType: "application/pdf",
    data,
    width: sheets[0]!.width,
    height: sheets[0]!.height,
  } satisfies DesignExportResult;
});
