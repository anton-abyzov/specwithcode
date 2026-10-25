/**
 * How the Files layer previews one file, decided from its path, origin and
 * size before anything is read: markdown rendered, text as read-only source,
 * images through `<img>`, fonts as a specimen, everything else explained.
 */
import { DESIGN_SYSTEM_FILE_MAX_BYTES } from "@specweave-studio/contracts";

import { extensionOf, type BrowserFile } from "./filesModel";

/** Text larger than this is not shown, like the reference's 512 KB. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export type PreviewPlan =
  | { readonly kind: "markdown" }
  | { readonly kind: "source" }
  | { readonly kind: "image"; readonly mimeType: string }
  | { readonly kind: "font" }
  | { readonly kind: "notice"; readonly message: string; readonly download: boolean };

const TEXT_EXTENSIONS = new Set([
  "txt",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "ts",
  "jsx",
  "tsx",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
]);

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf"]);

export const NO_PREVIEW = "Preview isn't available for this file type";
export const TOO_LARGE = "This file is too large to preview";

/** The image MIME type to label a blob with: the extension decides, so a stored type cannot turn an image into a page. */
export function imageMimeType(path: string): string | null {
  return IMAGE_TYPES[extensionOf(path)] ?? null;
}

export function previewPlan(
  file: Pick<BrowserFile, "path" | "bytes" | "unavailable">,
): PreviewPlan {
  if (file.unavailable !== undefined && file.unavailable.trim() !== "")
    return {
      kind: "notice",
      message: `This file can't be read from the repository: ${file.unavailable}`,
      download: false,
    };
  const extension = extensionOf(file.path);
  const isMarkdown = extension === "md" || extension === "markdown";
  if (isMarkdown || TEXT_EXTENSIONS.has(extension)) {
    if (file.bytes > TEXT_PREVIEW_MAX_BYTES)
      return { kind: "notice", message: `${TOO_LARGE} (over 512 KB).`, download: true };
    return isMarkdown ? { kind: "markdown" } : { kind: "source" };
  }
  const image = imageMimeType(file.path);
  if (image !== null || FONT_EXTENSIONS.has(extension)) {
    if (file.bytes > DESIGN_SYSTEM_FILE_MAX_BYTES)
      return { kind: "notice", message: `${TOO_LARGE} (over 10 MB).`, download: true };
    return image !== null ? { kind: "image", mimeType: image } : { kind: "font" };
  }
  return { kind: "notice", message: NO_PREVIEW, download: true };
}
