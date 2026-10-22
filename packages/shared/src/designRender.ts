import type {
  DesignDocument,
  DesignLength,
  DesignNode,
  DesignPage,
  DesignPaint,
  DesignSystem,
} from "@specweave-studio/contracts";
import { injectHtmlRenderBootstrap } from "./htmlRender.ts";

/**
 * Styles and standalone HTML for design documents. The canvas, gallery
 * thumbnails, agent screenshots and every export use these functions, so a
 * design looks the same wherever it is shown.
 */

export interface DesignRenderContext {
  /** The design's system, for `{token}` values and component previews. */
  readonly system: DesignSystem | null;
  /** Mode id to resolve tokens in (`light`, `dark`, `default`). */
  readonly mode: string;
  /** URL for an image asset file name; standalone exports pass data URLs. */
  readonly assetUrl: (asset: string) => string;
}

export const NOTE_COLORS = {
  yellow: "#fdf1b8",
  blue: "#d6e8fb",
  green: "#d8f0dc",
  pink: "#f9dbe6",
  gray: "#e7e5ea",
} as const;

const FALLBACK_INK = "#1f1d24";

/** A token's value in the context's mode, falling back to `light`, then any mode. */
export function designTokenValue(
  system: DesignSystem | null,
  name: string,
  mode: string,
): string | null {
  const token = system?.tokens.find((candidate) => candidate.name === name);
  if (token === undefined) return null;
  const value =
    token.values[mode] ??
    token.values.light ??
    token.values.default ??
    Object.values(token.values)[0];
  if (value === undefined) return null;
  return value.resolved ?? value.raw;
}

export function resolveDesignPaint(
  paint: DesignPaint | undefined,
  context: DesignRenderContext,
): string | undefined {
  if (paint === undefined) return undefined;
  if (typeof paint === "string") return safeCssValue(paint);
  const value = designTokenValue(context.system, paint.token, context.mode);
  return value === null ? undefined : safeCssValue(value);
}

export function resolveDesignLength(
  length: DesignLength | undefined,
  context: DesignRenderContext,
): number | undefined {
  if (length === undefined) return undefined;
  if (typeof length === "number") return length;
  const value = designTokenValue(context.system, length.token, context.mode);
  if (value === null) return undefined;
  return cssLengthToPx(value);
}

/** px, rem (16 px) and unitless numbers; anything else is unknown. */
export function cssLengthToPx(value: string): number | undefined {
  const match = /^\s*(-?\d*\.?\d+)\s*(px|rem|em)?\s*$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === "rem" || match[2] === "em" ? amount * 16 : amount;
}

/** Rejects values that could break out of a CSS declaration. */
export function safeCssValue(value: string): string | undefined {
  if (/[;{}<>]|\/\*|url\s*\(|expression\s*\(|@import/i.test(value)) return undefined;
  return value.trim();
}

export type DesignStyle = Readonly<Record<string, string | number>>;

/** Absolute-position style of a node inside its parent, in CSS property names. */
export function designNodeStyle(node: DesignNode, context: DesignRenderContext): DesignStyle {
  const style: Record<string, string | number> = {
    position: "absolute",
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${node.width}px`,
    height: `${node.height}px`,
    "box-sizing": "border-box",
  };
  if (node.rotation !== undefined && node.rotation !== 0)
    style.transform = `rotate(${node.rotation}deg)`;
  if (node.opacity !== undefined) style.opacity = node.opacity;
  if (node.hidden === true) style.display = "none";
  switch (node.type) {
    case "frame":
    case "rect":
    case "ellipse": {
      const fill = resolveDesignPaint(node.fill, context);
      if (fill !== undefined) style.background = fill;
      const stroke = resolveDesignPaint(node.stroke, context);
      if (stroke !== undefined) style.border = `${node.strokeWidth ?? 1}px solid ${stroke}`;
      if (node.type === "ellipse") style["border-radius"] = "50%";
      else {
        const radius = resolveDesignLength(node.radius, context);
        if (radius !== undefined) style["border-radius"] = `${radius}px`;
      }
      if (node.type === "frame" && node.clip !== false) style.overflow = "hidden";
      break;
    }
    case "text": {
      style.color = resolveDesignPaint(node.color, context) ?? FALLBACK_INK;
      const family =
        node.fontFamily === undefined
          ? undefined
          : typeof node.fontFamily === "string"
            ? safeCssValue(node.fontFamily)
            : (designTokenValue(context.system, node.fontFamily.token, context.mode) ?? undefined);
      if (family !== undefined) style["font-family"] = family;
      const size = resolveDesignLength(node.fontSize, context);
      style["font-size"] = `${size ?? 16}px`;
      if (node.fontWeight !== undefined) style["font-weight"] = node.fontWeight;
      style["line-height"] = node.lineHeight ?? 1.4;
      if (node.letterSpacing !== undefined) style["letter-spacing"] = `${node.letterSpacing}px`;
      style["text-align"] = node.align ?? "left";
      style["white-space"] = "pre-wrap";
      style["overflow-wrap"] = "break-word";
      break;
    }
    case "note":
      style.background = NOTE_COLORS[node.color ?? "yellow"];
      style.color = FALLBACK_INK;
      style.padding = "12px";
      style["font-size"] = "14px";
      style["line-height"] = 1.4;
      style["white-space"] = "pre-wrap";
      style["box-shadow"] = "0 1px 2px rgba(31,29,36,.18)";
      break;
    case "image": {
      const radius = resolveDesignLength(node.radius, context);
      if (radius !== undefined) style["border-radius"] = `${radius}px`;
      style.overflow = "hidden";
      break;
    }
    case "line":
    case "path":
    case "html":
    case "component":
      break;
  }
  return style;
}

export function designStyleText(style: DesignStyle): string {
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** SVG path data for a line or pen path; points are relative to the node. */
export function designPathData(points: readonly (readonly [number, number])[], closed: boolean) {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  return `M${first[0]} ${first[1]}${rest.map(([x, y]) => ` L${x} ${y}`).join("")}${closed ? " Z" : ""}`;
}

/** Children of each parent id (null for page level), in paint order. */
export function designChildren(
  page: DesignPage,
): ReadonlyMap<string | null, readonly DesignNode[]> {
  const map = new Map<string | null, DesignNode[]>();
  for (const node of page.nodes) {
    const list = map.get(node.parentId) ?? [];
    list.push(node);
    map.set(node.parentId, list);
  }
  return map;
}

/**
 * Policy for every design iframe (agent HTML and component previews) on the
 * canvas, in thumbnails and in exports: inline script and style only, images
 * and fonts from data or blob URLs, and no network at all, so a frame cannot
 * call the local server or anything else.
 */
export const DESIGN_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

const DESIGN_FRAME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${DESIGN_FRAME_CSP}">`;

/**
 * The document a sandboxed HTML node frame shows, pinned to the design's mode
 * so the canvas, thumbnails and exports match whatever the viewer's OS uses.
 */
export function designHtmlSrcdoc(
  node: Extract<DesignNode, { type: "html" }>,
  context: Pick<DesignRenderContext, "mode">,
): string {
  const doc = injectHtmlRenderBootstrap(node.html, "", context.mode === "dark" ? "dark" : "light");
  // The policy goes ahead of all agent markup: placed after the agent's own <head>,
  // a <p> before that tag would push it into the body, where browsers ignore it.
  // Only a leading doctype (and comments before it) stays first, to keep standards mode.
  const at = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(doc)?.[0].length ?? 0;
  return doc.slice(0, at) + DESIGN_FRAME_CSP_META + doc.slice(at);
}

/** The document a sandboxed component preview frame shows. */
export function designComponentSrcdoc(
  node: Extract<DesignNode, { type: "component" }>,
  context: DesignRenderContext,
): string {
  const component = context.system?.components.find((item) => item.id === node.componentId);
  const body =
    component?.previewHtml ??
    `<div style="font:12px system-ui;color:#675d69;padding:8px">${escapeHtml(component?.name ?? node.componentId)}</div>`;
  const css = (context.system?.stylesheet ?? "").replaceAll("</style", "<\\/style");
  return `<!doctype html><html data-theme="${escapeHtml(context.mode)}"><head>${DESIGN_FRAME_CSP_META}<meta charset="utf-8"><style>html,body{margin:0}${css}</style></head><body>${body}</body></html>`;
}

function renderNodeHtml(
  node: DesignNode,
  children: ReadonlyMap<string | null, readonly DesignNode[]>,
  context: DesignRenderContext,
): string {
  const style = designStyleText(designNodeStyle(node, context));
  const label = node.name === undefined ? "" : ` data-name="${escapeHtml(node.name)}"`;
  const inner = (children.get(node.id) ?? [])
    .map((child) => renderNodeHtml(child, children, context))
    .join("");
  switch (node.type) {
    case "frame":
    case "rect":
    case "ellipse":
      return `<div data-node="${node.id}"${label} style="${style}">${inner}</div>`;
    case "text":
      return `<div data-node="${node.id}"${label} style="${style}">${escapeHtml(node.text)}</div>`;
    case "note":
      return `<div data-node="${node.id}"${label} style="${style}">${escapeHtml(node.text)}</div>`;
    case "image":
      return `<div data-node="${node.id}"${label} style="${style}"><img src="${escapeHtml(context.assetUrl(node.asset))}" alt="${escapeHtml(node.alt ?? "")}" style="width:100%;height:100%;object-fit:${node.fit ?? "cover"};display:block"></div>`;
    case "line":
    case "path": {
      const stroke = resolveDesignPaint(node.stroke, context) ?? FALLBACK_INK;
      const fill =
        node.type === "path" ? (resolveDesignPaint(node.fill, context) ?? "none") : "none";
      const d = designPathData(node.points, node.closed === true);
      return `<svg data-node="${node.id}"${label} style="${style};overflow:visible" width="${node.width}" height="${node.height}" viewBox="0 0 ${Math.max(node.width, 1)} ${Math.max(node.height, 1)}"><path d="${d}" fill="${escapeHtml(fill)}" stroke="${escapeHtml(stroke)}" stroke-width="${node.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    case "html":
      return `<iframe data-node="${node.id}"${label} sandbox="allow-scripts" style="${style};border:0" srcdoc="${escapeHtml(designHtmlSrcdoc(node, context))}"></iframe>`;
    case "component":
      return `<iframe data-node="${node.id}"${label} sandbox="" style="${style};border:0;pointer-events:none" srcdoc="${escapeHtml(designComponentSrcdoc(node, context))}"></iframe>`;
  }
}

export interface DesignBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Bounding box of the page's top-level nodes; an empty page is 1x1 at 0,0. */
export function designPageBounds(page: DesignPage): DesignBounds {
  const roots = page.nodes.filter((node) => node.parentId === null && node.hidden !== true);
  if (roots.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.min(...roots.map((node) => node.x));
  const minY = Math.min(...roots.map((node) => node.y));
  const maxX = Math.max(...roots.map((node) => node.x + node.width));
  const maxY = Math.max(...roots.map((node) => node.y + node.height));
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export interface DesignHtmlTarget {
  readonly pageId: string;
  /** Render one frame at its own size; the whole page when absent. */
  readonly frameId?: string;
}

/**
 * A standalone HTML document of one frame or one whole page, sized to its
 * content. Agent HTML and component previews stay in sandboxed iframes.
 */
export function renderDesignHtml(
  document: DesignDocument,
  target: DesignHtmlTarget,
  context: DesignRenderContext,
): { readonly html: string; readonly width: number; readonly height: number } {
  const page = document.pages.find((candidate) => candidate.id === target.pageId);
  if (page === undefined) throw new Error(`No page ${target.pageId}.`);
  const children = designChildren(page);
  let bounds: DesignBounds;
  let body: string;
  if (target.frameId !== undefined) {
    const frame = page.nodes.find((node) => node.id === target.frameId);
    if (frame === undefined) throw new Error(`No node ${target.frameId}.`);
    bounds = { x: 0, y: 0, width: frame.width, height: frame.height };
    body = renderNodeHtml({ ...frame, x: 0, y: 0, rotation: 0 }, children, context);
  } else {
    bounds = designPageBounds(page);
    body = (children.get(null) ?? [])
      .map((node) =>
        renderNodeHtml({ ...node, x: node.x - bounds.x, y: node.y - bounds.y }, children, context),
      )
      .join("");
  }
  const width = Math.ceil(bounds.width);
  const height = Math.ceil(bounds.height);
  const title = escapeHtml(document.title || "Design");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=${width}"><style>html,body{margin:0;padding:0}body{position:relative;width:${width}px;height:${height}px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style></head><body>${body}</body></html>`;
  return { html, width, height };
}
