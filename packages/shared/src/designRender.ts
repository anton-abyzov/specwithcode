import type {
  DesignDocument,
  DesignLength,
  DesignNode,
  DesignOperation,
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

/**
 * The mode a design renders in. A deck renders in its system's first mode for
 * every viewer, so the editor, Present and exports match whatever the viewer's
 * app theme is; other designs follow the viewer's theme when the system has it.
 */
export function designRenderMode(
  kind: DesignDocument["kind"],
  system: DesignSystem | null,
  viewerTheme: string,
): string {
  const modes = system?.modes.map((item) => item.id) ?? [];
  if (kind !== "slides" && modes.includes(viewerTheme)) return viewerTheme;
  return modes[0] ?? "light";
}

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

/** CSS Color 4 keywords; `currentcolor` and the system colors depend on context. */
const CSS_COLOR_NAMES = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen transparent"
  ).split(" "),
);

/**
 * A color that paints on its own: a hex color, a color keyword, or one color function
 * over plain numbers. `var()`, `color-mix()`, relative colors and token aliases
 * (`{color.primary}`, `colors.blue.500`) need something else to resolve, so they are not.
 */
export function isConcreteCssColor(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (CSS_COLOR_NAMES.has(text)) return true;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return true;
  return /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?=[^()]*\d)[-+.\w%\s,/]*\)$/.test(text);
}

/**
 * A font-family list of quoted names and plain identifiers (`Inter, "SF Pro", sans-serif`).
 * `var()`, custom properties and dotted or `$` aliases are not one.
 */
export function isFontFamilyList(value: string): boolean {
  const family = /^(?:"[^"\\]*"|'[^'\\]*'|-?[a-z_][\w-]*(?:\s+[\w-]+)*)$/i;
  return value.split(",").every((part) => family.test(part.trim()));
}

/**
 * Update operations that write each token reference in the document as the value it
 * shows now: the token's resolved value in `context.mode`, or its raw value when it has
 * none. Choosing no system runs them first, so token-filled layers keep their fills,
 * strokes, text colors, radii and type instead of turning transparent. A token the
 * system lacks, or one whose value is not a concrete color, length or font list (a
 * `var()`, an alias), stays a reference.
 */
export function detachDesignTokens(
  document: Pick<DesignDocument, "pages">,
  context: Pick<DesignRenderContext, "system" | "mode">,
): DesignOperation[] {
  const { system, mode } = context;
  if (system === null) return [];
  const literal = (token: string) => {
    const value = designTokenValue(system, token, mode);
    return value === null ? undefined : safeCssValue(value);
  };
  const paint = (value: DesignPaint | undefined) => {
    if (value === undefined || typeof value === "string") return undefined;
    const css = literal(value.token);
    // A paint holds at most 120 characters.
    return css === undefined || css.length > 120 || !isConcreteCssColor(css) ? undefined : css;
  };
  const length = (value: DesignLength | undefined) => {
    if (value === undefined || typeof value === "number") return undefined;
    const css = literal(value.token);
    const px = css === undefined ? undefined : cssLengthToPx(css);
    return px === undefined || px < 0 || px > 1e6 ? undefined : px;
  };
  const operations: DesignOperation[] = [];
  for (const page of document.pages)
    for (const node of page.nodes) {
      const patch: Record<string, string | number | undefined> = {};
      if ("fill" in node) patch.fill = paint(node.fill);
      if ("stroke" in node) patch.stroke = paint(node.stroke);
      if ("radius" in node) patch.radius = length(node.radius);
      if (node.type === "text") {
        patch.color = paint(node.color);
        patch.fontSize = length(node.fontSize);
        if (node.fontFamily !== undefined && typeof node.fontFamily !== "string") {
          const family = literal(node.fontFamily.token);
          if (family !== undefined && family.length <= 200 && isFontFamilyList(family))
            patch.fontFamily = family;
        }
      }
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
      if (Object.keys(patch).length > 0)
        operations.push({ op: "update_node", pageId: page.id, id: node.id, patch });
    }
  return operations;
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

/** `{brand-500}` or `var(--brand-500)` names another token; returns that name. */
export function designTokenAlias(raw: string): string | null {
  const trimmed = raw.trim();
  const braces = /^\{([A-Za-z0-9._-]+)\}$/.exec(trimmed);
  if (braces) return braces[1]!;
  const variable = /^var\(\s*--([A-Za-z0-9._-]+)\s*\)$/.exec(trimmed);
  return variable ? variable[1]! : null;
}

const cssName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);

type TokenSource = Pick<DesignSystem, "tokens" | "modes">;
const tokensCssCache = new WeakMap<TokenSource, Map<string, string>>();

/**
 * `:root{--name:value}` for one mode: the token's own value there, else the first
 * mode's, `default` or any value, as the design system page shows it. Aliases become
 * `var(--target)`; values that could break out of a declaration are left out. Empty
 * for no system or no usable token. Component frames on the canvas, in the picker,
 * on the system page and in every export get the same block.
 */
export function designTokensCss(system: TokenSource | null, mode: string): string {
  if (system === null) return "";
  let byMode = tokensCssCache.get(system);
  const cached = byMode?.get(mode);
  if (cached !== undefined) return cached;
  const first = system.modes[0]?.id;
  const declarations: string[] = [];
  for (const token of system.tokens) {
    const value =
      token.values[mode] ??
      (first === undefined ? undefined : token.values[first]) ??
      token.values.default ??
      Object.values(token.values)[0];
    if (value === undefined) continue;
    const raw = value.resolved ?? value.raw;
    const alias = designTokenAlias(raw);
    const css = alias === null ? safeCssValue(raw) : `var(--${cssName(alias)})`;
    if (css === undefined || css === "") continue;
    declarations.push(`--${cssName(token.name)}:${css}`);
  }
  const css = declarations.length === 0 ? "" : `:root{${declarations.join(";")}}`;
  if (byMode === undefined) tokensCssCache.set(system, (byMode = new Map()));
  byMode.set(mode, css);
  return css;
}

/**
 * The document a sandboxed component preview frame shows: the system's tokens as
 * CSS variables, then its stylesheet (which wins on a clash), then the preview HTML.
 */
export function designComponentSrcdoc(
  node: Extract<DesignNode, { type: "component" }>,
  context: DesignRenderContext,
): string {
  const component = context.system?.components.find((item) => item.id === node.componentId);
  const body =
    component?.previewHtml ??
    `<div style="font:12px system-ui;color:#675d69;padding:8px">${escapeHtml(component?.name ?? node.name ?? node.componentId)}</div>`;
  const css = (
    designTokensCss(context.system, context.mode) + (context.system?.stylesheet ?? "")
  ).replaceAll("</style", "<\\/style");
  return `<!doctype html><html data-theme="${escapeHtml(context.mode)}"><head>${DESIGN_FRAME_CSP_META}<meta charset="utf-8"><style>html,body{margin:0}${css}</style></head><body>${body}</body></html>`;
}

/**
 * Built component previews (a kit's stories rendered to static HTML) run no script
 * at all, so their frames can be same-origin and measured for height.
 */
export const DESIGN_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Light or dark, the way kits switch: a `data-theme` attribute, a `dark` class and the color scheme. */
export type DesignPreviewTheme = "light" | "dark";

const PREVIEW_GROUND: Record<DesignPreviewTheme, { ground: string; ink: string; caption: string }> =
  {
    light: { ground: "#ffffff", ink: "#16181d", caption: "#7a7f89" },
    dark: { ground: "#101114", ink: "#eceef2", caption: "#8b919c" },
  };

/**
 * The document a built preview frame shows: a plain page in the chosen theme, the
 * kit's stylesheet (which wins on any clash), then each story as a captioned
 * section. SVG fragments get their viewBox from the frame's owner once laid out.
 */
export function designPreviewSrcdoc(input: {
  readonly html: string;
  readonly css: string;
  readonly theme: DesignPreviewTheme;
}): string {
  const colors = PREVIEW_GROUND[input.theme];
  const base =
    `html,body{margin:0}` +
    `html{color-scheme:${input.theme};background:${colors.ground};color:${colors.ink}}` +
    `body{padding:20px;display:flex;flex-direction:column;gap:28px;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}` +
    `section[data-swc-story]{min-width:0}` +
    `section[data-swc-story]::before{content:attr(data-swc-story);display:block;margin:0 0 10px;font:500 11px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.02em;color:${colors.caption}}` +
    `svg[data-swc-fragment]{display:block;width:auto;max-width:100%;height:240px;overflow:visible}`;
  const css = input.css.replace(/<\/style/gi, "<\\/style");
  const theme = escapeHtml(input.theme);
  return `<!doctype html><html data-theme="${theme}" class="${theme}"><head><meta http-equiv="Content-Security-Policy" content="${DESIGN_PREVIEW_CSP}"><meta charset="utf-8"><style>${base}</style><style>${css}</style></head><body>${input.html}</body></html>`;
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
