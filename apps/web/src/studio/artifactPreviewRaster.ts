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
/** The width a page lays out at before it is scaled down. */
const PAGE_WIDTH = 1040;
const PAGE_HEIGHT = Math.round((PAGE_WIDTH * HEIGHT) / WIDTH);
const HTML_MAX_CHARS = 256 * 1024;
const QUALITY = 0.72;
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

/** Waits for the browser to be idle, so drawing never lands inside a scroll frame. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 400 });
    } else setTimeout(resolve, 0);
  });
}

/** The page as well-formed XHTML with nothing that runs or loads. */
export function inertPageMarkup(html: string): { markup: string; text: string } | null {
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
    `width:${PAGE_WIDTH}px;height:${PAGE_HEIGHT}px;overflow:hidden;${root.getAttribute("style") ?? ""}`,
  );
  const base = page.createElement("style");
  base.textContent = "body{min-height:100%}";
  page.head.prepend(base);
  return {
    markup: new XMLSerializer().serializeToString(root),
    text: page.body?.textContent ?? "",
  };
}

export async function rasterizeHtmlPage(markup: string): Promise<string | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
    const image = new Image(PAGE_WIDTH, PAGE_HEIGHT);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    await idle();
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(image, 0, 0, WIDTH, HEIGHT);
    return await encode(canvas);
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
      return { type: "image", src: await encode(canvas) };
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

/** A document's finished preview, from its contents. */
export async function documentPreview(
  text: string,
  format: Exclude<ArtifactPreviewFormat, "image">,
): Promise<ArtifactPreview> {
  if (format !== "html") return textPreview(text, format);
  const page = inertPageMarkup(text);
  if (page === null) return { type: "none" };
  const src = await rasterizeHtmlPage(page.markup);
  return src === null ? textPreview(page.text, "text") : { type: "image", src };
}
