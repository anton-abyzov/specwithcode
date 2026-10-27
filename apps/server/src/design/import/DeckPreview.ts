// @effect-diagnostics nodeBuiltinImport:off - Names pictures by content hash, as DesignStore does.
/**
 * `design.previewDeck`: a PowerPoint deck on the host, read as the slides the
 * import would make (`pptxImport.ts`, `importedPages`) and stored nowhere.
 * The file viewer draws them with the slides renderer. The path follows the
 * rules absolute media files follow (`readableHostFile`): a regular file that
 * is not a credential or app state file, under the session's filesystem:read.
 */
import * as NodeCrypto from "node:crypto";

import {
  DESIGN_DECK_IMPORT_MAX_BYTES,
  DESIGN_DECK_PREVIEW_IMAGE_BYTES,
  DesignError,
  type DesignPreviewDeckInput,
  type DesignPreviewDeckResult,
} from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readableHostFile } from "../../assets/AssetAccess.ts";
import { importedPages } from "./DesignImport.ts";
import { megabytes, PptxImportError, readPptxDeck, type ImportedDeck } from "./pptxImport.ts";

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * The deck's pictures as `data:` URLs by asset name, up to the preview's
 * picture budget; image nodes of pictures past it are left out of the pages.
 */
export function previewImages(
  deck: ImportedDeck,
  budget: number = DESIGN_DECK_PREVIEW_IMAGE_BYTES,
): {
  readonly assets: ReadonlyMap<string, string>;
  readonly images: Record<string, string>;
  readonly omitted: number;
} {
  const assets = new Map<string, string>();
  const images: Record<string, string> = {};
  let used = 0;
  let omitted = 0;
  for (const [media, image] of deck.media) {
    if (used + image.bytes.byteLength > budget) {
      omitted += 1;
      continue;
    }
    used += image.bytes.byteLength;
    const hash = NodeCrypto.createHash("sha256").update(image.bytes).digest("hex");
    const name = `${hash}.${EXTENSION[image.mimeType] ?? "png"}`;
    assets.set(media, name);
    images[name] ??= `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
  }
  return { assets, images, omitted };
}

/** The preview of a deck already read from disk. */
export async function previewDeckBytes(bytes: Uint8Array): Promise<DesignPreviewDeckResult> {
  const deck = await readPptxDeck(bytes, () => designId("n"));
  const { assets, images, omitted } = previewImages(deck);
  const { pages, notImported } = importedPages(deck, assets);
  return { pages, images, imagesOmitted: omitted, notImported };
}

const notFound = () =>
  new DesignError({ code: "not_found", detail: "The file is not on this machine any more." });

export const previewDeck = (input: DesignPreviewDeckInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(input.path)) {
      return yield* new DesignError({
        code: "invalid",
        detail: "A deck preview needs the file's full path.",
      });
    }
    if (path.extname(input.path).toLowerCase() !== ".pptx") {
      return yield* new DesignError({
        code: "invalid",
        detail: "Only PowerPoint decks (.pptx) have a slide preview.",
      });
    }
    const file = yield* readableHostFile(input.path).pipe(Effect.orElseSucceed(() => null));
    if (file === null) return yield* notFound();
    const info = yield* fileSystem.stat(file).pipe(Effect.mapError(notFound));
    if (Number(info.size) > DESIGN_DECK_IMPORT_MAX_BYTES) {
      return yield* new DesignError({
        code: "too_large",
        detail: `The deck is larger than ${megabytes(DESIGN_DECK_IMPORT_MAX_BYTES)}, the preview limit.`,
      });
    }
    const bytes = yield* fileSystem.readFile(file).pipe(Effect.mapError(notFound));
    return yield* Effect.tryPromise({
      try: () => previewDeckBytes(bytes),
      catch: (error) =>
        error instanceof PptxImportError
          ? new DesignError({ code: error.code, detail: error.message })
          : new DesignError({
              code: "invalid",
              detail: "The file could not be read as a PowerPoint deck (.pptx).",
            }),
    });
  }).pipe(Effect.withSpan("DeckPreview.previewDeck"));
