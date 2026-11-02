/**
 * Draws a preview once into a small WebP, so a card holds a few kilobytes
 * instead of a browsing context or a full-size bitmap. HTML goes through an
 * SVG `foreignObject` image: browsers render those with scripts and network
 * off, and the page cannot reach the app. Every failure returns null, and the
 * caller falls back to text.
 */
import {
  IMAGE_MAX_BYTES,
  markdownPreviewLines,
  plainPreviewLines,
  type ArtifactPreview,
  type ArtifactPreviewFormat,
} from "./artifactPreview";

const WIDTH = 336;
const HEIGHT = 210;
/** A document's small type stays sharp at this size on a large card and a 2x screen. */
const DOCUMENT_WIDTH = 480;
const DOCUMENT_HEIGHT = 300;

interface PageSize {
  readonly width: number;
  readonly height: number;
}
/** The size a page lays out at before it is scaled down. */
const HTML_PAGE: PageSize = { width: 1040, height: 650 };
/** Narrower than a web page, so a card shows a title and the type above it, as a sheet does. */
const MARKDOWN_PAGE: PageSize = { width: 640, height: 400 };
const HTML_MAX_CHARS = 256 * 1024;
const QUALITY = 0.72;
const MIN_TINT_CHROMA = 18;
/** Legal in HTML, fatal to the XML an SVG image is parsed as, half an emoji included. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu;
const REMOVED = "script,iframe,frame,object,embed,link,base,meta,noscript,video,audio,template";

function encode(canvas: OffscreenCanvas): Promise<string> {
  return canvas.convertToBlob({ type: "image/webp", quality: QUALITY }).then(
    (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result as string));
        reader.addEventListener("error", () => reject(reader.error));
        reader.readAsDataURL(blob);
      }),
  );
}

/** The average colour of a picture, when it has one; plain paper has none. */
function pictureTint(canvas: OffscreenCanvas): string | undefined {
  try {
    const small = new OffscreenCanvas(8, 5);
    const context = small.getContext("2d");
    if (context === null) return undefined;
    context.drawImage(canvas, 0, 0, 8, 5);
    const { data } = context.getImageData(0, 0, 8, 5);
    const sum = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      sum[0]! += data[index]!;
      sum[1]! += data[index + 1]!;
      sum[2]! += data[index + 2]!;
    }
    const [r, g, b] = sum.map((value) => Math.round(value / 40)) as [number, number, number];
    return Math.max(r, g, b) - Math.min(r, g, b) < MIN_TINT_CHROMA
      ? undefined
      : `rgb(${r} ${g} ${b})`;
  } catch {
    return undefined;
  }
}

/** Waits for the browser to be idle, so drawing never lands inside a scroll frame. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 400 });
    } else setTimeout(resolve, 0);
  });
}

/** The page as well-formed XHTML with nothing that runs or loads. */
export function inertPageMarkup(
  html: string,
  size: PageSize = HTML_PAGE,
): { markup: string; text: string } | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  const page = new DOMParser().parseFromString(html.slice(0, HTML_MAX_CHARS), "text/html");
  for (const node of page.querySelectorAll(REMOVED)) node.remove();
  for (const element of page.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    }
  }
  const root = page.documentElement;
  root.setAttribute(
    "style",
    `width:${size.width}px;height:${size.height}px;overflow:hidden;${root.getAttribute("style") ?? ""}`,
  );
  const base = page.createElement("style");
  base.textContent = "body{min-height:100%}";
  page.head.prepend(base);
  return {
    markup: new XMLSerializer().serializeToString(root).replace(NOT_XML, ""),
    text: page.body?.textContent ?? "",
  };
}

export async function rasterizeHtmlPage(
  markup: string,
  size: PageSize = HTML_PAGE,
): Promise<{ readonly src: string; readonly tint: string | undefined } | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
    const image = new Image(size.width, size.height);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    await idle();
    const canvas = new OffscreenCanvas(DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    context.drawImage(image, 0, 0, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    return { src: await encode(canvas), tint: pictureTint(canvas) };
  } catch {
    return null;
  }
}

/**
 * The top of an image scaled to the card; decoding happens off the main thread.
 * An image too large to read whole has nothing to show, and one that cannot be
 * decoded here (an SVG) shows the file itself. Null means the read failed and
 * may work next time, which from another origin it never will.
 */
export async function imagePreview(
  url: string,
  signal?: AbortSignal,
): Promise<ArtifactPreview | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return { type: "original" };
  }
  let blob: Blob;
  try {
    // An hour-long browser cache would keep showing a file that has changed.
    const response = await fetch(url, { cache: "no-cache", ...(signal ? { signal } : {}) });
    if (response.status >= 500) return null;
    if (!response.ok) return { type: "none" };
    if (Number(response.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) {
      await response.body?.cancel();
      return { type: "none" };
    }
    blob = await response.blob();
  } catch {
    return null;
  }
  try {
    signal?.throwIfAborted();
    const bitmap = await createImageBitmap(blob, { resizeWidth: WIDTH, resizeQuality: "medium" });
    try {
      const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
      const context = canvas.getContext("2d");
      if (context === null) return { type: "original" };
      // A wide image scales up to fill the height, centered; a tall one shows its top.
      const scale = Math.max(1, HEIGHT / bitmap.height);
      const drawn = bitmap.width * scale;
      context.drawImage(bitmap, (WIDTH - drawn) / 2, 0, drawn, bitmap.height * scale);
      return { type: "image", src: await encode(canvas), tint: pictureTint(canvas) };
    } finally {
      bitmap.close();
    }
  } catch {
    return { type: "original" };
  }
}

function textPreview(text: string, format: "markdown" | "text"): ArtifactPreview {
  const lines = format === "markdown" ? markdownPreviewLines(text) : plainPreviewLines(text);
  return lines.length === 0
    ? { type: "none" }
    : { type: "lines", mono: format !== "markdown", lines };
}

/** A Markdown file drawn as its page; null when it is empty or this browser cannot draw it. */
async function markdownPicture(text: string): Promise<ArtifactPreview | null> {
  if (text.trim() === "" || typeof OffscreenCanvas === "undefined") return null;
  try {
    const { markdownPage } = await import("./artifactPreviewMarkdown");
    await idle();
    const page = markdownPage(text);
    const inert = inertPageMarkup(page.html, MARKDOWN_PAGE);
    const picture = inert && (await rasterizeHtmlPage(inert.markup, MARKDOWN_PAGE));
    return picture ? { type: "image", src: picture.src, title: page.title ?? undefined } : null;
  } catch {
    return null;
  }
}

/** A document's finished preview, from its contents. */
export async function documentPreview(
  text: string,
  format: Exclude<ArtifactPreviewFormat, "image">,
): Promise<ArtifactPreview> {
  if (format === "markdown") return (await markdownPicture(text)) ?? textPreview(text, format);
  if (format !== "html") return textPreview(text, format);
  const page = inertPageMarkup(text);
  if (page === null) return { type: "none" };
  const picture = await rasterizeHtmlPage(page.markup);
  return picture === null
    ? textPreview(page.text, "text")
    : { type: "image", src: picture.src, tint: picture.tint };
}
