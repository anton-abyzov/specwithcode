/**
 * Downscale + re-encode for image attachments that are too big for where
 * they're headed. Two consumers share the same pipeline:
 *
 * - The prompt stash persists images as base64 in localStorage (~5MB origin
 *   quota), so `compressImageForStash` targets a per-image character budget.
 * - The composer prepares pasted/dropped images with
 *   `prepareImageForAttachment`, which shrinks them to the size and
 *   dimensions Claude Code sends instead of rejecting the paste.
 *
 * Supported images already within budget pass through untouched. HEIC/HEIF
 * photos are decoded to JPEG first because providers cannot consume them.
 */

/**
 * Longest edge kept when an image has to be re-encoded, and the most an
 * attached image may have. Matches Claude Code: the Anthropic API rejects
 * images over 2000 px once a request carries more than 20 of them, and
 * downsizes larger ones anyway.
 */
export const MAX_ATTACHMENT_IMAGE_DIMENSION = 2000;
const MAX_DIMENSION = MAX_ATTACHMENT_IMAGE_DIMENSION;
/**
 * Encoded size cap for an attached image, matching Claude Code: 3.75 MiB of
 * binary is 5 MiB of base64, the Anthropic API's per-image limit. Twenty
 * typical 2000 px images stay well inside the 22 MiB per-message total.
 */
export const MAX_ATTACHMENT_IMAGE_BYTES = (15 * 1024 * 1024) / 4;
/** Base64 budget for a single stashed image (~975KB of binary). */
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000;
/**
 * Ceiling on the *source* file handed to the re-encoder. File size is a
 * proxy for pixel count, and decoding hundreds of megapixels into an
 * ImageBitmap can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
/**
 * Most pixels decoded only to bring an image that already fits the byte cap
 * under 2000 px. A small file can declare a huge canvas, and decoding it
 * costs 4 bytes per pixel, so past this such an image goes as it is.
 */
const MAX_DIMENSION_FIT_DECODE_PIXELS = 100_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
/**
 * Quality ladder tried in order until the encoded image fits the budget.
 * The floor stays high enough to avoid visible blocking on UI screenshots;
 * if even that overflows we drop resolution instead of quality.
 */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
/** Extra downscale passes applied when even the lowest quality overflows. */
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
/** Head of the file read to find its pixel size without decoding it. */
const IMAGE_HEADER_BYTES = 512 * 1024;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

type ImageSize = { width: number; height: number };

export interface CompressedStashImage {
  imageSize?: ImageSize;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  /** True when the payload was re-encoded rather than stored verbatim. */
  recompressed: boolean;
}

/**
 * Why an image could not be compressed. Callers report these differently:
 * "too large" is a budget outcome, "unreadable" is a decode failure.
 */
export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressStashImageResult =
  | { ok: true; image: CompressedStashImage }
  | { ok: false; reason: ImageCompressionFailureReason };

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

interface HeicMetadataBox {
  payloadOffset: number;
  endOffset: number;
}

function findHeicMetadataBox(
  view: DataView,
  startOffset: number,
  endOffset: number,
  type: number,
): HeicMetadataBox | null {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;

    const nextOffset = offset + size;
    if (view.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: nextOffset };
    }
    offset = nextOffset;
  }
  return null;
}

/** Read HEIC image dimensions before the decoder allocates full RGBA buffers. */
async function validateHeicImageDimensions(
  file: File,
): Promise<ImageCompressionFailureReason | null> {
  const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
  const view = new DataView(metadata);
  const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
  const properties = findHeicMetadataBox(view, meta.payloadOffset + 4, meta.endOffset, 0x69707270);
  if (!properties) return "unreadable";
  const containers = findHeicMetadataBox(
    view,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return "unreadable";

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(view, offset, containers.endOffset, 0x69737065);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return "unreadable";
    if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-large";
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  return foundImageDimensions ? null : "unreadable";
}

function readPngSize(view: DataView): ImageSize | null {
  if (
    view.byteLength < 24 ||
    view.getUint32(0) !== 0x89504e47 ||
    view.getUint32(12) !== 0x49484452
  ) {
    return null;
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGifSize(view: DataView): ImageSize | null {
  // "GIF8"
  if (view.byteLength < 10 || view.getUint32(0) !== 0x47494638) return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readWebpSize(view: DataView): ImageSize | null {
  // "RIFF" .... "WEBP"
  if (
    view.byteLength < 30 ||
    view.getUint32(0) !== 0x52494646 ||
    view.getUint32(8) !== 0x57454250
  ) {
    return null;
  }
  const chunk = view.getUint32(12);
  if (chunk === 0x56503820) {
    // "VP8 ": lossy, 14-bit dimensions after the frame start code.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === 0x5650384c && view.getUint8(20) === 0x2f) {
    // "VP8L": lossless, 14-bit dimensions packed after the signature byte.
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 0x56503858) {
    // "VP8X": extended, 24-bit canvas dimensions.
    const readUint24 = (offset: number) =>
      view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    return { width: readUint24(24) + 1, height: readUint24(27) + 1 };
  }
  return null;
}

function readJpegSize(view: DataView): ImageSize | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // Start of scan or end of image: no frame header before the pixel data.
    if (marker === 0xda || marker === 0xd9) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > view.byteLength) return null;
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/**
 * Pixel size from the file header, without decoding the image. Covers the
 * formats providers accept; anything else, or a header this cannot parse,
 * returns null.
 */
export async function readImageSize(file: Blob): Promise<ImageSize | null> {
  let view: DataView;
  try {
    view = new DataView(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
  } catch {
    return null;
  }
  const size = readPngSize(view) ?? readGifSize(view) ?? readWebpSize(view) ?? readJpegSize(view);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

function dataUrlLength(blob: Blob): number {
  return (
    `data:${blob.type || "application/octet-stream"};base64,`.length + 4 * Math.ceil(blob.size / 3)
  );
}

/** Base64 payload of a data URL decoded back into a `File`. */
export function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}

/**
 * Re-encoding changes the container, so a name like `shot.png` would lie
 * about its contents. Swap the extension to match the encoded mime type.
 */
function fileNameForMimeType(name: string, mimeType: string): string {
  const extension =
    mimeType === "image/webp" ? ".webp" : mimeType === "image/png" ? ".png" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return { canvas, context };
}

/** Encodes the canvas, or null when the browser cannot write `mimeType`. */
async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<Blob | null> {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  }
  return blob?.type === mimeType ? blob : null;
}

const composerThumbnails = new WeakMap<File, Promise<string | null>>();

/** Cache a centered square crop for the composer's object-cover image tiles. */
export function createComposerImageThumbnail(file: File): Promise<string | null> {
  const cached = composerThumbnails.get(file);
  if (cached) return cached;
  const thumbnail = (async () => {
    if (!canRecompress()) return null;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      if (side <= 0) return null;
      const dimension = Math.min(256, side);
      const surface = createCanvas(dimension, dimension);
      if (!surface) return null;
      surface.context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        dimension,
        dimension,
      );
      const blob = await encodeCanvas(surface.canvas, 1, "image/png");
      return blob ? await readFileAsDataUrl(blob) : null;
    } catch {
      return null;
    } finally {
      bitmap?.close();
    }
  })();
  composerThumbnails.set(file, thumbnail);
  return thumbnail;
}

/**
 * Draws `bitmap` scaled to fit `maxDimension` and encodes it as `mimeType`,
 * stepping quality down until the data URL fits `budgetChars`. Returns null
 * when nothing fits or the browser cannot encode that format.
 */
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
  mimeType: string,
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;

  // JPEG has no alpha, so transparent regions get a white matte first.
  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  // PNG is lossless; quality does not change its size.
  const qualities = mimeType === "image/png" ? QUALITY_STEPS.slice(0, 1) : QUALITY_STEPS;
  for (const quality of qualities) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType);
    if (!encoded) break;
    if (dataUrlLength(encoded) <= budgetChars) {
      return { blob: encoded, mimeType, imageSize: { width, height } };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

/**
 * WebP is preferred: at matched visual quality it lands roughly 25-35%
 * smaller than JPEG, so the same budget buys more resolution and detail,
 * and it keeps alpha, so screenshots with transparency survive intact.
 * Browsers that cannot encode it fall back to JPEG.
 */
const LOSSY_ENCODINGS = ["image/webp", "image/jpeg"] as const;

/**
 * Walks the fallback downscale passes, trying each encoding in order at every
 * size, until one fits `budgetChars`. The caller owns `bitmap`.
 */
async function reencodeBitmapWithinBudget(
  bitmap: ImageBitmap,
  budgetChars: number,
  encodings: ReadonlyArray<string>,
): Promise<ReencodeResult> {
  // Each pass shrinks relative to the *previous target*, capped by
  // MAX_DIMENSION. Scaling a fixed ceiling instead would be a no-op for
  // images already smaller than that ceiling — the fallback passes would
  // all resolve to the source size and never actually reduce resolution.
  const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height));
  // Tracks whether the *last* attempt threw, so a run of encoder failures
  // is reported as unreadable while a run of merely-too-big results is
  // reported as too-large.
  let encodeFailed = false;
  for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
    const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
    for (const mimeType of encodings) {
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars, mimeType);
      } catch {
        // Canvas allocation, drawing, or the codec itself can throw — often
        // precisely *because* the target is too big (OOM on a large bitmap).
        // Keep trying the smaller fallback scales rather than giving up: a
        // reduced pass may well succeed. The exception must never escape,
        // though, since callers finalize state after this returns and a
        // throw would strand it (e.g. a stash entry stuck "still saving").
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) {
        return {
          ok: true,
          blob: encoded.blob,
          mimeType: encoded.mimeType,
          imageSize: encoded.imageSize,
        };
      }
    }
  }
  return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
}

/** Decodes `file`, then re-encodes it within `budgetChars`. */
async function reencodeWithinBudget(
  file: File,
  budgetChars: number,
  encodings: ReadonlyArray<string> = LOSSY_ENCODINGS,
): Promise<ReencodeResult> {
  if (!canRecompress()) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    return await reencodeBitmapWithinBudget(bitmap, budgetChars, encodings);
  } finally {
    bitmap.close();
  }
}

/**
 * Produces the payload to persist for a stashed image.
 *
 * Small images are stored verbatim (preserving PNG transparency and exact
 * pixels). Anything over budget is downscaled and re-encoded; if it still
 * doesn't fit after the fallback passes, reports a failure so the caller
 * can record it as dropped.
 */
export async function compressImageForStash(
  file: File,
  budgetChars: number = MAX_STASH_IMAGE_DATA_URL_CHARS,
): Promise<CompressStashImageResult> {
  try {
    if (dataUrlLength(file) <= budgetChars) {
      return {
        ok: true,
        image: {
          dataUrl: await readFileAsDataUrl(file),
          mimeType: file.type,
          sizeBytes: file.size,
          recompressed: false,
        },
      };
    }
    const reencoded = await reencodeWithinBudget(file, budgetChars);
    if (!reencoded.ok) {
      return reencoded;
    }
    return {
      ok: true,
      image: {
        dataUrl: await readFileAsDataUrl(reencoded.blob),
        mimeType: reencoded.mimeType,
        sizeBytes: reencoded.blob.size,
        recompressed: true,
        imageSize: reencoded.imageSize,
      },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Shrinks `file` until its binary size fits `maxBytes`, returning a new
 * `File` (WebP or JPEG). Files already within the limit pass through
 * untouched, preserving their exact bytes and format. Sources above
 * `MAX_COMPRESSIBLE_SOURCE_BYTES` are refused outright — decoding them is
 * the risk, so no amount of output budget makes them safe. An internally
 * converted image can provide its original source size when the intermediate
 * format expands beyond that ceiling.
 */
export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  if (file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  // The re-encode loop budgets in data-URL characters. Base64 turns 3 bytes
  // into 4 chars; flooring keeps the budget a hair conservative instead of
  // admitting an encoding right at the byte cap.
  const budgetChars = Math.floor(maxBytes / 3) * 4;
  const reencoded = await reencodeWithinBudget(
    file,
    budgetChars,
    options?.preferredMimeType ? [options.preferredMimeType] : LOSSY_ENCODINGS,
  );
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      { type: reencoded.mimeType },
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}

/** Re-encode formats for an attached image, its own format first where a canvas can write it. */
function attachmentEncodingsFor(mimeType: string): ReadonlyArray<string> {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return ["image/jpeg"];
    case "image/webp":
      return LOSSY_ENCODINGS;
    // A canvas cannot write GIF; PNG keeps its transparency.
    case "image/gif":
    case "image/png":
      return ["image/png", ...LOSSY_ENCODINGS];
    default:
      return LOSSY_ENCODINGS;
  }
}

function fitsAttachmentDimension(size: ImageSize): boolean {
  return Math.max(size.width, size.height) <= MAX_ATTACHMENT_IMAGE_DIMENSION;
}

/**
 * Downscales `file` so its long edge is at most 2000 px and its encoding at
 * most `maxBytes`, keeping aspect ratio and, where a canvas can write it, the
 * source format. Never upscales. An image already within both limits passes
 * through untouched, as does one whose size cannot be checked or changed but
 * already fits `maxBytes`.
 */
async function fitImageForAttachment(
  file: File,
  maxBytes: number,
  options: { encodings: ReadonlyArray<string>; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  const withinBytes = file.size <= maxBytes;
  const untouched: CompressImageFileResult = { ok: true, file, recompressed: false };
  if (withinBytes) {
    const headerSize = await readImageSize(file);
    if (
      (headerSize &&
        (fitsAttachmentDimension(headerSize) ||
          headerSize.width * headerSize.height > MAX_DIMENSION_FIT_DECODE_PIXELS)) ||
      !canRecompress()
    ) {
      return untouched;
    }
  } else if ((options.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  if (!canRecompress()) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Nothing to shrink if it cannot be decoded; a small file still goes as
    // is and the provider decides.
    return withinBytes ? untouched : { ok: false, reason: "unreadable" };
  }
  try {
    if (withinBytes && fitsAttachmentDimension(bitmap)) {
      return untouched;
    }
    // Base64 turns 3 bytes into 4 chars; flooring keeps the budget a hair
    // conservative instead of admitting an encoding right at the byte cap.
    const budgetChars = Math.floor(maxBytes / 3) * 4;
    const reencoded = await reencodeBitmapWithinBudget(bitmap, budgetChars, options.encodings);
    if (!reencoded.ok) {
      return reencoded;
    }
    return {
      ok: true,
      file: new File(
        [reencoded.blob],
        fileNameForMimeType(file.name || "image", reencoded.mimeType),
        { type: reencoded.mimeType, lastModified: file.lastModified },
      ),
      recompressed: true,
      imageSize: reencoded.imageSize,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Prepares an image for a chat attachment the way Claude Code does: at most
 * 2000 px on the long edge and `maxBytes` encoded (3.75 MiB by default).
 * HEIC/HEIF photos are converted to provider-compatible JPEG first; the
 * decoder is loaded only when such a photo arrives.
 */
export async function prepareImageForAttachment(
  file: File,
  maxBytes: number = MAX_ATTACHMENT_IMAGE_BYTES,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return fitImageForAttachment(file, maxBytes, {
      encodings: attachmentEncodingsFor(file.type),
    });
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let converted: Blob;
  try {
    const dimensionError = await validateHeicImageDimensions(file);
    if (dimensionError) {
      return { ok: false, reason: dimensionError };
    }
    const { heicTo } = await import("heic-to/csp");
    converted = await heicTo({ blob: file, type: "image/jpeg", quality: QUALITY_STEPS[0] });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const jpeg = new File([converted], fileNameForMimeType(file.name || "image", "image/jpeg"), {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
  const result = await fitImageForAttachment(jpeg, maxBytes, {
    encodings: ["image/jpeg"],
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}
