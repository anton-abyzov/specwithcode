import {
  STUDIO_CODE_DARK_THEME_COLORS,
  STUDIO_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalettes.ts";

/**
 * Agent-authored HTML pages ("HTML renders") are self-contained documents an
 * agent publishes into a thread with Studio's `html_render` MCP tool. The server
 * stores each one as a thread attachment with a small bootstrap injected into
 * its head; clients show it in a sandboxed iframe (web, desktop) or WebView
 * (mobile) and hand it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
/** Quick inline diagrams and charts from an SVG or HTML fragment, stored as an HTML render. */
export const HTML_VISUAL_TOOL_NAME = "show_visual";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
/** The frame height of a visual published before the preview browser could measure it. */
export const HTML_VISUAL_UNMEASURED_HEIGHT = 420;

/** What the `html_render` tool result carries so clients can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
  /**
   * `visual` for a `show_visual` diagram, shown in full inline under a
   * collapsible "Made a visual" header; absent for a report page.
   */
  readonly kind?: "visual";
}

/** Frame widths the server measures a page at, from phones to the wide chat setting. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;

/**
 * The reply column's frame width at the default chat width. Agents preview at
 * it, and it picks the measured height when a client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 728;

const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights, kind } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
    ...(kind === "visual" ? { kind } : {}),
  };
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference) {
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.height === right.height &&
    left.kind === right.kind &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height,
    )
  );
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: NonNullable<HtmlRenderReference["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the client has one, else the server's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number,
) {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    // A visual always asks for the largest frame, so an unmeasured one waits
    // at a modest height until the page reports its own.
    const fallback = reference.kind === "visual" ? HTML_VISUAL_UNMEASURED_HEIGHT : reference.height;
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? fallback));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Fonts the server's headless browser lays pages out with. Arial-metric faces
 * stand in for the system UI fonts readers see, so measured heights and
 * preview screenshots wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

/** The resolved theme a client hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

// Roles themes cannot change (index.css keeps info/success fixed), plus a
// categorical chart series after the theme's own accent.
const FIXED_COLORS = {
  light: {
    success: "#10b981",
    successForeground: "#047857",
    info: "#3b82f6",
    infoForeground: "#1d4ed8",
    chart: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  },
  dark: {
    success: "#10b981",
    successForeground: "#34d399",
    info: "#3b82f6",
    infoForeground: "#60a5fa",
    chart: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
  },
} as const;

/**
 * Maps a theme palette to the variables HTML renders style against. Names
 * follow the app's own tokens, except `--accent`, which is the theme's brand
 * color here rather than the app's neutral hover surface.
 */
export function htmlRenderTheme(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
): HtmlRenderTheme {
  const fixed = FIXED_COLORS[appearance];
  return {
    appearance,
    variables: {
      "--background": colors.canvas,
      "--foreground": colors.text,
      "--muted": colors.muted,
      "--muted-foreground": colors.mutedForeground,
      "--card": colors.surface,
      "--card-foreground": colors.text,
      "--popover": colors.surfaceOverlay,
      "--popover-foreground": colors.text,
      "--secondary": colors.secondary,
      "--secondary-foreground": colors.secondaryForeground,
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.focus,
      "--primary": colors.messageAction,
      "--primary-foreground": colors.messageActionForeground,
      "--accent": colors.accent,
      "--accent-foreground": colors.accentForeground,
      "--accent-surface": colors.accentSurface,
      "--accent-surface-foreground": colors.accentSurfaceForeground,
      "--destructive": colors.error,
      "--destructive-foreground": colors.errorForeground,
      "--destructive-surface": colors.errorSurface,
      "--warning": colors.warning,
      "--warning-foreground": colors.warningForeground,
      "--warning-surface": colors.warningSurface,
      "--success": fixed.success,
      "--success-foreground": fixed.successForeground,
      "--info": fixed.info,
      "--info-foreground": fixed.infoForeground,
      "--code-background": colors.codeBackground,
      "--code-foreground": colors.codeForeground,
      "--chart-1": colors.accent,
      ...Object.fromEntries(fixed.chart.map((color, index) => [`--chart-${index + 2}`, color])),
      "--radius": "0.625rem",
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
    },
  };
}

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "SpecWithCode injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The report appears in a bounded preview (${HTML_RENDER_COLUMN_WIDTH}px desktop reply column, about 360px on phones), then opens in a spacious focused reader.`,
  "Lead with the outcome and one useful visual near the top, not a large property table. Put supporting metadata and detailed evidence below the explanation.",
  "Use readable sans-serif body text (15-16px), a restrained 24-30px heading, and short measured lines. Use the injected theme tokens, never a hard-coded black canvas. Keep the outer page fluid without another card or banner.",
  "For states or decisions, use a small semantic HTML or inline SVG flow with labels and a text alternative. For numerical comparisons use a chart plus its data table. Do not invent data or add a diagram merely as decoration. Markdown already supports Mermaid; HTML should be self-contained without a CDN dependency where practical.",
  "Keep controls keyboard accessible, show focus, respect reduced motion, and check light/dark at 390px and desktop widths with html_preview. Preserve all evidence and links; disclose long detail progressively.",
  'Link local evidence with a labeled anchor whose href is the absolute path (<a href="/Users/me/run/login.png">Login screenshot</a>); SpecWithCode shows it as a compact chip that opens the file in the app and copies its path. Do not print long paths as inline code.',

  "Give charts fixed heights. Let content set page height; avoid 100vh or height:100% on html/body because the frame grows to fit content.",
].join(" ");

/** The color ramps a visual's shapes take by class, as `c-<name>`. */
export const HTML_VISUAL_COLORS = {
  blue: "#3b82f6",
  teal: "#14b8a6",
  green: "#22c55e",
  amber: "#f59e0b",
  coral: "#f97362",
  red: "#ef4444",
  pink: "#ec4899",
  purple: "#8b5cf6",
  gray: "#8b8d93",
} as const;

export const HTML_VISUAL_MAX_CODE_LENGTH = 256_000;

const VISUAL_SHAPES = ":is(rect,circle,ellipse,polygon)";
const VISUAL_CLASSES = Object.keys(HTML_VISUAL_COLORS)
  .map((name) => `.c-${name}`)
  .join(",");

// Each ramp is mixed against the live theme instead of fixed per mode: a
// shape gets a faint fill over the page background, and its stroke and text
// the hue pulled toward the foreground (darker in light, lighter in dark), so one class reads in light and
// dark and follows the user's theme. Text tokens alias the app's own.
const VISUAL_CSS =
  ":root{--text-primary:var(--foreground);--text-secondary:var(--muted-foreground);" +
  "--text-muted:color-mix(in srgb,var(--muted-foreground) 72%,var(--background));" +
  "--text-success:var(--success-foreground);--text-warning:var(--warning);--text-danger:var(--destructive);--text-accent:var(--accent);" +
  "--surface-1:color-mix(in srgb,var(--foreground) 4%,var(--background));--surface-2:color-mix(in srgb,var(--foreground) 7%,var(--background))}" +
  "body{padding:2px 0;color:var(--text-primary);overflow-wrap:break-word}" +
  "body>svg{display:block;width:100%;max-width:100%;height:auto;margin:0 auto}" +
  "svg text{font-family:var(--font-sans)}" +
  ".t,.th{font-size:14px;fill:var(--text-primary)}.th{font-weight:500}.ts{font-size:12px;fill:var(--text-secondary)}" +
  Object.entries(HTML_VISUAL_COLORS)
    .map(([name, color]) => `.c-${name}{--hue:${color}}`)
    .join("") +
  `${VISUAL_SHAPES}:is(${VISUAL_CLASSES}),:is(${VISUAL_CLASSES})>${VISUAL_SHAPES}{fill:color-mix(in srgb,var(--hue) 14%,var(--background));stroke:color-mix(in srgb,var(--hue) 70%,var(--foreground));stroke-width:1}` +
  `:is(${VISUAL_CLASSES}) :is(.t,.th){fill:color-mix(in srgb,var(--hue) 45%,var(--foreground))}` +
  `:is(${VISUAL_CLASSES}) .ts{fill:color-mix(in srgb,var(--hue) 60%,var(--foreground))}` +
  ".arr{fill:none;stroke:var(--text-secondary);stroke-width:1.5}";

/** Whether a visual's code is an SVG rather than an HTML fragment. */
export function isHtmlVisualSvg(code: string) {
  return /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code);
}

/** Whether `code` is a whole document, which belongs in `html_render` instead. */
export function isHtmlVisualDocument(code: string) {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype|html|head|body)[\s>]/i.test(code);
}

/**
 * The self-contained page a `show_visual` fragment is stored as: the visual
 * stylesheet, then the agent's SVG or HTML as the body. The theme bootstrap is
 * injected on publish like any HTML render, so the frame stays sandboxed.
 */
export function htmlVisualDocument(code: string): string {
  const body = code.replace(/^\s*<\?xml[^>]*>/i, "").trim();
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style id="studio-visual">${VISUAL_CSS}</style></head><body>${body}</body></html>`
  );
}

/** Agent-facing rules for a `show_visual` fragment, used in its tool description. */
export const HTML_VISUAL_GUIDE = [
  "widget_code is an SVG starting with <svg>, or an HTML fragment with no DOCTYPE, html, head or body tags; SpecWithCode wraps it in a page with the theme.",
  "Leave the background transparent and never hard-code a hex or rgb color for text or a background.",
  "In HTML use color: var(--text-primary), var(--text-secondary) or var(--text-muted); var(--text-success), var(--text-warning), var(--text-danger) or var(--text-accent) for status (as text, or the fill of a bar or dot); background: var(--surface-1) or var(--surface-2) for a panel, and var(--border) for lines.",
  'In SVG give every <text> class="t" (14px), "ts" (12px, secondary) or "th" (14px, medium) instead of a fill.',
  `Color a rect, circle, ellipse or polygon, or the <g> that directly holds it and its text, with class ${Object.keys(
    HTML_VISUAL_COLORS,
  )
    .map((name) => `c-${name}`)
    .join(", ")}; the text inside takes a matching color.`,
  'Give a connecting line or path class="arr", with fill="context-stroke" on an arrowhead marker\'s path.',
  `Use a viewBox about ${HTML_RENDER_COLUMN_WIDTH - 48} units wide and no fixed width, so the SVG scales to the reply column; the frame fits its height.`,
  "Scripts run in a sandbox after the fragment is in the page; remote http(s) libraries load as-is.",
].join(" ");

// The bridge between a render and its client speaks the MCP Apps protocol
// (JSON-RPC over postMessage), so the same host code can later drive upstream
// MCP apps: https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** A render's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readHtmlRenderLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const url =
    typeof params === "object" && params !== null ? (params as { url?: unknown }).url : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? { id, url } : undefined;
}

/** The empty result a client sends back for a render's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

// App-namespaced requests: a local file is not a `ui/open-link` URL, which an
// MCP Apps host would hand to the system browser.
export const HTML_RENDER_OPEN_FILE_METHOD = "specwithcode/open-file";
export const HTML_RENDER_COPY_PATH_METHOD = "specwithcode/copy-path";
const EVIDENCE_PATH_MAX_LENGTH = 4096;

export type HtmlRenderErrorMessage =
  | "Invalid path"
  | "Policy violation"
  | "Not allowed here"
  | "Copy failed";

/** The error a client sends back when it refuses or cannot do a render's request. */
export function htmlRenderError(id: string | number, message: HtmlRenderErrorMessage) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } } as const;
}

export interface EvidencePath {
  readonly path: string;
  readonly kind: "posix" | "windows" | "home";
}

/**
 * An absolute local path a report links as evidence, or undefined. Relative,
 * URL-like, encoded, traversing, control-character and oversized strings are
 * refused, and so are network (UNC) paths: opening `\\host\share` makes the
 * machine connect, and sign in, to a host the page chose. Whether the file
 * may be read stays the server's decision.
 */
export function normalizeEvidencePath(raw: unknown): EvidencePath | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > EVIDENCE_PATH_MAX_LENGTH)
    return undefined;
  if (!plainPathCharacters(raw)) return undefined;
  const kind: EvidencePath["kind"] | undefined = raw.startsWith("~/")
    ? "home"
    : /^\/(?!\/)/.test(raw)
      ? "posix"
      : /^[A-Za-z]:[\\/]/.test(raw)
        ? "windows"
        : undefined;
  if (kind === undefined) return undefined;
  const windows = kind === "windows";
  if (!windows && raw.includes("\\")) return undefined;
  const rest = raw.slice(kind === "posix" ? 1 : kind === "windows" ? 3 : 2);
  const segments = rest.split(windows ? /[\\/]/ : "/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return undefined;
  return { path: raw, kind };
}

// Controls, format characters (bidirectional marks among them), lone
// surrogates, line and paragraph separators, characters that render as
// nothing (zero-width, tags, variation selectors, fillers) and `%`.
const UNPLAIN_PATH_CHARACTER = /[%\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

// Scripts whose letters a zero-width joiner or non-joiner visibly reshapes.
const JOINING_LETTER =
  "[\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}]";

// Invisible characters that are part of a visible glyph: an emoji's
// presentation selector, the joiner inside an emoji sequence or between
// letters of a joining script, and the tags of a subdivision flag up to its
// closing tag.
const GLYPH_PART = new RegExp(
  [
    "(?<=\\p{Extended_Pictographic})[\\uFE0E\\uFE0F]",
    "(?<=[#*0-9])\\uFE0F(?=\\u20E3)",
    "(?<=\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)\\u200D(?=\\p{Extended_Pictographic})",
    `(?<=(?=\\p{L})${JOINING_LETTER}\\p{M}*)[\\u200C\\u200D](?=(?=\\p{L})${JOINING_LETTER})`,
    "(?<=\\u{1F3F4}[\\u{E0020}-\\u{E007E}]*)[\\u{E0020}-\\u{E007E}](?=[\\u{E0020}-\\u{E007E}]*\\u{E007F})",
    "(?<=\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+)\\u{E007F}",
  ].join("|"),
  "gu",
);

/**
 * No control, bidirectional or invisible character, no percent sign (an
 * undecoded or double-encoded URL) and no lone surrogate: what the reader is
 * shown is the path that opens. Emoji and joining scripts keep the invisible
 * characters that form their visible glyphs.
 */
function plainPathCharacters(value: string): boolean {
  return !UNPLAIN_PATH_CHARACTER.test(value.replace(GLYPH_PART, ""));
}

export interface HtmlRenderFileRequest {
  readonly id: string | number;
  readonly method: "open-file" | "copy-path";
  readonly path: string;
  readonly line?: number;
}

/**
 * A render's request to open or copy a local evidence file. Only `path` and
 * `line` are read: where the file lives (machine, thread, folder) comes from
 * the frame showing the page, never from the page.
 */
export function readHtmlRenderFileRequest(data: unknown): HtmlRenderFileRequest | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0") return undefined;
  if (method !== HTML_RENDER_OPEN_FILE_METHOD && method !== HTML_RENDER_COPY_PATH_METHOD)
    return undefined;
  if (!((typeof id === "string" && id.length <= 128) || Number.isSafeInteger(id))) return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { path, line } = params as { path?: unknown; line?: unknown };
  const evidence = normalizeEvidencePath(path);
  if (evidence === undefined) return undefined;
  if (line !== undefined && !(Number.isSafeInteger(line) && (line as number) > 0)) return undefined;
  return method === HTML_RENDER_OPEN_FILE_METHOD
    ? {
        id: id as string | number,
        method: "open-file",
        path: evidence.path,
        ...(line === undefined ? {} : { line: line as number }),
      }
    : { id: id as string | number, method: "copy-path", path: evidence.path };
}

// Top-level folders a local path starts with; the app's own pages never do.
const LEGACY_LOCAL_ROOT = /^\/(?:Users|home|root|tmp|private|var|Volumes|opt|mnt|srv)\//;

/**
 * The local path a report published before evidence links asked to open: its
 * bootstrap resolved `/Users/…` against the page's own server and sent that
 * as a `ui/open-link` URL. A URL on the frame's own origin under a filesystem
 * root names a path; anything else, the app's own pages included, is an
 * ordinary link.
 */
export function legacyLocalPathFromOpenLink(url: string, frameSrc: string): string | undefined {
  try {
    const target = new URL(url);
    // A frame's `src` property is always an absolute URL.
    const frame = new URL(frameSrc);
    if (target.origin !== frame.origin || !LEGACY_LOCAL_ROOT.test(target.pathname))
      return undefined;
    return normalizeEvidencePath(decodeURIComponent(target.pathname))?.path;
  } catch {
    return undefined;
  }
}

const THEME_FRAGMENT_KEY = "studio-theme";

/** URL fragment that hands a render its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The `host-context-changed` notification a client posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// Evidence links: a compact labeled chip whose dot and tint say what kind of
// file it opens, a copy button, and the full path on hover or focus.
const EVIDENCE_LINK_CSS =
  ".studio-evidence-wrap{position:relative;display:inline-flex;align-items:center;gap:2px;max-width:100%;vertical-align:bottom}" +
  "a.studio-evidence{--evidence:var(--muted-foreground);display:inline-block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 .55em;border:1px solid color-mix(in srgb,var(--evidence) 40%,transparent);border-radius:999px;background:color-mix(in srgb,var(--evidence) 10%,transparent);color:var(--foreground);font-size:.92em;line-height:1.7;text-decoration:none;cursor:pointer}" +
  'a.studio-evidence::before{content:"";display:inline-block;width:.5em;height:.5em;margin-right:.4em;border-radius:50%;background:var(--evidence);vertical-align:.06em}' +
  "a.studio-evidence[data-kind=image],a.studio-evidence[data-kind=video]{--evidence:var(--info)}a.studio-evidence[data-kind=report]{--evidence:var(--accent)}" +
  "a.studio-evidence[data-evidence-state=denied],a.studio-evidence[data-evidence-state=unavailable]{--evidence:var(--warning)}" +
  "a.studio-evidence:hover{background:color-mix(in srgb,var(--evidence) 20%,transparent);border-color:color-mix(in srgb,var(--evidence) 70%,transparent)}" +
  "a.studio-evidence:focus-visible,.studio-evidence-copy:focus-visible{outline:2px solid var(--ring);outline-offset:2px}" +
  ".studio-evidence-copy{display:inline-grid;place-items:center;flex:none;width:1.75em;height:1.75em;padding:0;border:0;border-radius:6px;background:transparent;color:var(--muted-foreground);font:inherit;cursor:pointer}" +
  ".studio-evidence-copy:hover{background:color-mix(in srgb,var(--foreground) 9%,transparent);color:var(--foreground)}.studio-evidence-copy svg{width:1em;height:1em}" +
  ".studio-evidence-path{display:none;position:absolute;left:0;top:100%;z-index:20;box-sizing:border-box;width:max-content;max-width:min(36rem,calc(100vw - 1rem));padding:.35em .55em;border:1px solid var(--border);border-radius:6px;background:var(--popover);color:var(--popover-foreground);font:12px/1.45 var(--font-mono);white-space:normal;overflow-wrap:anywhere;user-select:text;box-shadow:0 4px 14px rgb(0 0 0/.16)}" +
  ".studio-evidence-wrap[data-open]>.studio-evidence-path{display:block}" +
  ".studio-evidence-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}" +
  "@media (prefers-reduced-motion:no-preference){a.studio-evidence{transition:background-color .12s,border-color .12s}}";

// The frame decorates explicit anchors whose href is an absolute local path
// (`/…`, `~/…`, `C:\…`, `\\host\…`, `file:` without a host); text and code
// are never turned into links. Activating one asks the client to open the file
// with `specwithcode/open-file`, and its copy button asks for
// `specwithcode/copy-path`; the client decides, so a page can only ask. The
// request carries the href at the moment of the click, never the label. A
// page outside a client (a download) keeps the path to copy.
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const EVIDENCE_LINK_SCRIPT = String.raw`(function(){var O=${JSON.stringify("specwithcode/open-file")},C=${JSON.stringify("specwithcode/copy-path")},CI=${JSON.stringify(COPY_ICON)},KI=${JSON.stringify(CHECK_ICON)},framed=window.parent!==window,seq=0,wait={},live=null;
function local(href){if(typeof href!=="string")return null;var h=href.trim(),p,hash="",i,m,line;if(/^file:/i.test(h)){try{var u=new URL(h);if(u.hostname&&u.hostname!=="localhost")return null;p=decodeURIComponent(u.pathname);if(/^\/[A-Za-z]:\//.test(p))p=p.slice(1);hash=u.hash;}catch(e){return null;}}else if(/^\/(?!\/)/.test(h)||/^~\//.test(h)){i=h.indexOf("#");if(i>=0){hash=h.slice(i);h=h.slice(0,i);}i=h.indexOf("?");if(i>=0)h=h.slice(0,i);try{p=decodeURIComponent(h);}catch(e){return null;}}else if(/^[A-Za-z]:[\\\/]/.test(h)){p=h;}else return null;m=/^#L(\d+)/.exec(hash);if(m)line=Number(m[1]);else{m=/^(.*[^:\\\/]):(\d+)(?::\d+)?$/.exec(p);if(m&&!/^[A-Za-z]$/.test(m[1])){p=m[1];line=Number(m[2]);}}if(!p||/[\u0000-\u001f\u007f]/.test(p))return null;return{p:p,line:line};}
function kind(p){var e=(/\.([A-Za-z0-9]+)$/.exec(p)||[])[1];e=e?e.toLowerCase():"";return /^(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/.test(e)?"image":/^(mp4|mov|webm|m4v|mkv)$/.test(e)?"video":/^(md|html?|pdf)$/.test(e)?"report":/^(log|txt|out|err|jsonl)$/.test(e)?"log":"file";}
function base(p){var parts=p.split(/[\\\/]/);return parts[parts.length-1]||p;}
function say(text){if(!live){live=document.createElement("span");live.className="studio-evidence-status";live.setAttribute("role","status");(document.body||document.documentElement).appendChild(live);}live.textContent="";setTimeout(function(){live.textContent=text;},30);}
function mark(el,state,note){if(!el)return;el.setAttribute("data-evidence-state",state);clearTimeout(el.__studioEvidenceTimer);el.__studioEvidenceTimer=setTimeout(function(){el.removeAttribute("data-evidence-state");if(el.classList.contains("studio-evidence-copy"))el.innerHTML=CI;},2500);if(state==="copied"&&el.classList.contains("studio-evidence-copy"))el.innerHTML=KI;say(state==="copied"?"Path copied":state==="opened"?"Opened in SpecWithCode":"Not available"+(note?": "+note:""));}
function anchorOf(w){return w&&w.querySelector("a.studio-evidence");}
function decorate(a){var t=a.closest("[data-no-evidence]")?null:local(a.getAttribute("href")),cur=a.getAttribute("data-studio-evidence"),w=a.parentElement;if(!t){if(cur!==null){a.removeAttribute("data-studio-evidence");a.classList.remove("studio-evidence");}return;}if(cur===t.p)return;a.setAttribute("data-studio-evidence",t.p);a.classList.add("studio-evidence");a.setAttribute("data-kind",kind(t.p));a.title=t.p;var label=(a.textContent||"").trim();if(!label||label===t.p||label===a.getAttribute("href")||a.getAttribute("data-studio-evidence-label")==="path"){a.textContent=base(t.p);a.setAttribute("data-studio-evidence-label","path");}if(!w||!w.classList.contains("studio-evidence-wrap")){w=document.createElement("span");w.className="studio-evidence-wrap";a.parentNode.insertBefore(w,a);w.appendChild(a);var b=document.createElement("button");b.type="button";b.className="studio-evidence-copy";b.innerHTML=CI;w.appendChild(b);var r=document.createElement("span");r.className="studio-evidence-path";r.id="studio-evidence-path-"+(++seq);r.setAttribute("role","tooltip");w.appendChild(r);a.setAttribute("aria-describedby",((a.getAttribute("aria-describedby")||"")+" "+r.id).trim());}w.querySelector(".studio-evidence-path").textContent=t.p;w.querySelector(".studio-evidence-copy").setAttribute("aria-label","Copy path "+t.p);}
var queued=false;function scan(){queued=false;var all=document.querySelectorAll("a[href],a[data-studio-evidence]");for(var i=0;i<all.length;i++)decorate(all[i]);}function later(){if(!queued){queued=true;setTimeout(scan,0);}}
function show(w,open){if(!w)return;if(!open){w.removeAttribute("data-open");return;}w.setAttribute("data-open","");var tip=w.querySelector(".studio-evidence-path");if(!tip)return;tip.style.left="0px";var r=tip.getBoundingClientRect(),over=r.right-(document.documentElement.clientWidth-8);if(over>0)tip.style.left=Math.max(-w.getBoundingClientRect().left+8,-over)+"px";}
function wrapOf(t){return t&&t.closest?t.closest(".studio-evidence-wrap"):null;}
document.addEventListener("mouseover",function(e){show(wrapOf(e.target),true);});document.addEventListener("mouseout",function(e){var w=wrapOf(e.target);if(w&&!w.contains(e.relatedTarget)&&!w.contains(document.activeElement))show(w,false);});document.addEventListener("focusin",function(e){show(wrapOf(e.target),true);});document.addEventListener("focusout",function(e){var w=wrapOf(e.target);if(w&&!w.contains(e.relatedTarget))show(w,false);});
document.addEventListener("keydown",function(e){var w=wrapOf(e.target);if(e.key==="Escape"&&w&&w.hasAttribute("data-open")){show(w,false);e.preventDefault();}});
function copyHere(path){var c=navigator.clipboard;try{var a=document.createElement("textarea");a.value=path;a.setAttribute("readonly","");a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();var ok=document.execCommand("copy");a.remove();if(ok)return true;}catch(e){}if(c&&c.writeText){c.writeText(path).catch(function(){});return true;}return false;}
function ask(method,params,el){var id="studio-file-"+(++seq);wait[id]={el:el,method:method,path:params.path};window.parent.postMessage({jsonrpc:"2.0",id:id,method:method,params:params},"*");setTimeout(function(){var w=wait[id];if(!w)return;delete wait[id];if(method===C&&copyHere(w.path))mark(el,"copied");else mark(el,"unavailable");},2000);}
window.addEventListener("message",function(e){var d=e.data,w;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||typeof d.id!=="string"||!(w=wait[d.id]))return;delete wait[d.id];if(d.error)mark(w.el,"denied",d.error&&typeof d.error.message==="string"?d.error.message:"");else mark(w.el,w.method===C?"copied":"opened");});
function activate(e){var el=e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href],.studio-evidence-copy");}),t;if(!el)return;if(el.classList.contains("studio-evidence-copy")){var a=anchorOf(wrapOf(el));t=a&&local(a.getAttribute("href"));e.preventDefault();if(!t||!e.isTrusted)return;if(framed)ask(C,{path:t.p},el);else mark(el,copyHere(t.p)?"copied":"unavailable");return;}if(el.closest("[data-no-evidence]"))return;t=local(el.getAttribute("href"));if(!t)return;e.preventDefault();if(!e.isTrusted||e.type!=="click")return;if(!framed){mark(el,"unavailable","open it in SpecWithCode");return;}var params={path:t.p};if(t.line)params.line=t.line;ask(O,params,el);}
window.addEventListener("click",activate,true);window.addEventListener("auxclick",activate,true);
new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["href","data-no-evidence"]});document.addEventListener("DOMContentLoaded",scan);later();})();`;

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  EVIDENCE_LINK_CSS;

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks to another page never replaces the page inside the thread:
// a framed page asks its client to open it, and a top-level page (mobile)
// opens it as a new window, which the client sends to the browser. A framed
// page also reports its content height, measured as the server measures it,
// so its client can fit the frame to the page.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("studio-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l||e.defaultPrevented)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"studio-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);document.addEventListener("keydown",function(e){if(e.isTrusted&&e.key==="Escape"&&!e.defaultPrevented&&!e.isComposing&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey){var owns=Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=menu], [role=listbox], [aria-expanded=true]")).some(function(el){return el.getClientRects().length>0&&!el.closest("[hidden], [aria-hidden=true]");});if(!owns)setTimeout(function(){if(!e.defaultPrevented)window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/report-escape"},"*");},0);}});}})();`;

// A page's Copy buttons and selections put exactly the text shown on the
// clipboard: no newline a textarea or <pre> ends with, no trailing spaces, no
// zero-width or no-break characters. Pasted into a macOS file dialog's Go to
// Folder, a trailing newline reads as a space and the path is not found. It
// mirrors `exactCopyText` in the web client; the copy listener sits on window,
// after the page's own handlers, and leaves a copy they handled alone.
export const HTML_RENDER_EXACT_COPY_SCRIPT = String.raw`(function(){var I=/[\u200B\u2060\uFEFF\u00AD]/g,S=/[\u00A0\u202F\u2007]/g;function x(t){return String(t).replace(I,"").replace(S," ").replace(/\r\n?/g,"\n").replace(/^(?:[ \t]*\n)+/,"").replace(/\s+$/,"");}var c=navigator.clipboard;if(c&&typeof c.writeText==="function"){var w=c.writeText.bind(c);try{c.writeText=function(t){return w(x(t));};}catch(e){}}window.addEventListener("copy",function(e){if(e.defaultPrevented||!e.clipboardData)return;var a=document.activeElement,t,s=null;if(a&&(a.tagName==="TEXTAREA"||a.tagName==="INPUT")&&typeof a.selectionStart==="number"){t=a.value.slice(a.selectionStart,a.selectionEnd);}else{s=window.getSelection();t=s?s.toString():"";}if(!t)return;var v=x(t);if(v===t)return;e.clipboardData.setData("text/plain",v);if(s&&s.rangeCount>0){var d=document.createElement("div");for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());e.clipboardData.setData("text/html",d.innerHTML);}e.preventDefault();});})();`;

function bootstrapMarkup(markup: string, appearance?: ThemeAppearance): string {
  const dark = htmlRenderTheme(STUDIO_CODE_DARK_THEME_COLORS, "dark");
  const light = htmlRenderTheme(STUDIO_CODE_LIGHT_THEME_COLORS, "light");
  // Without a client-provided theme (a direct download, the headless preview
  // without a fragment) the page follows the OS appearance, unless the caller
  // pins one.
  const defaultCss =
    appearance === undefined
      ? `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`
      : `${rootRule(appearance === "dark" ? dark : light)}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="studio-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}${HTML_RENDER_EXACT_COPY_SCRIPT}${EVIDENCE_LINK_SCRIPT}</script>`,
  ].join("");
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it. `before` goes ahead of the bootstrap
 * (a Content-Security-Policy meta must precede everything it governs).
 */
export function injectHtmlRenderBootstrap(
  html: string,
  before = "",
  appearance?: ThemeAppearance,
): string {
  const scan = blankNonMarkup(html);
  const markup = before + bootstrapMarkup(scan, appearance);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
