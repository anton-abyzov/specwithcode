import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@specweave-studio/shared/imageDimensions";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { readMediaFileHeader, type OpenMediaFile } from "./MediaFile.ts";

/** The widest thumbnail served; a chat column is never wider on a phone. */
export const THUMBNAIL_MAX_WIDTH = 640;
/** Everything the cache directory may hold before the least recently used thumbs go. */
export const THUMBNAIL_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** An image already this narrow and this light is its own thumbnail. */
const THUMBNAIL_SKIP_MAX_BYTES = 256 * 1024;
/** Larger sources are served whole instead of being copied for the resizer. */
const THUMBNAIL_SOURCE_MAX_BYTES = 48 * 1024 * 1024;
const THUMBNAIL_CACHE_DIRECTORY = "asset-thumbnails";
const THUMBNAIL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const RESIZE_TIMEOUT = Duration.seconds(15);
const STALE_TEMPORARY_FILE_MS = 10 * 60_000;
const SIPS_PATH = "/usr/bin/sips";

export class ThumbnailResizeError extends Schema.TaggedError<ThumbnailResizeError>()(
  "ThumbnailResizeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resize the image.";
  }
}

/** Formats whose pixel size the header parser reads and the resizer accepts. */
export const isThumbnailableExtension = (extension: string): boolean =>
  THUMBNAIL_EXTENSIONS.has(extension.toLowerCase());

/** Writes a JPEG of `source` at `width` pixels wide to `target`. */
export type ThumbnailResizer = (input: {
  readonly source: string;
  readonly target: string;
  readonly width: number;
}) => Effect.Effect<
  void,
  ThumbnailResizeError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
>;

/** macOS ships `sips`; other hosts have no resizer yet and serve the original. */
const sipsResizer: ThumbnailResizer = (input) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner
      .string(
        ChildProcess.make(
          SIPS_PATH,
          [
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "70",
            "--resampleWidth",
            String(input.width),
            input.source,
            "--out",
            input.target,
          ],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.timeout(RESIZE_TIMEOUT),
        Effect.mapError((cause) => new ThumbnailResizeError({ cause })),
      );
  });

export const platformThumbnailResizer = (): ThumbnailResizer | null =>
  process.platform === "darwin" ? sipsResizer : null;

// A feed can ask for many thumbs at once; two resizer processes at a time keeps the host calm.
const resizeSlots = Semaphore.makeUnsafe(2);

/** Drops the least recently used thumbs until the directory fits, and stale temporary files. */
export const pruneThumbnailCache = Effect.fn("AssetThumbnails.pruneThumbnailCache")(function* (
  directory: string,
  maxBytes: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fileSystem.readDirectory(directory);
  const entries: Array<{ file: string; size: number; usedAt: number }> = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const info = yield* fileSystem.stat(file).pipe(Effect.orElseSucceed(() => null));
    if (info === null || info.type !== "File") continue;
    const usedAt = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
    if (name.startsWith(".")) {
      if (now - usedAt > STALE_TEMPORARY_FILE_MS) {
        yield* fileSystem.remove(file).pipe(Effect.ignore);
      }
      continue;
    }
    entries.push({ file, size: Number(info.size), usedAt });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  entries.sort((left, right) => left.usedAt - right.usedAt);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    yield* fileSystem.remove(entry.file).pipe(Effect.ignore);
    total -= entry.size;
  }
});

/**
 * The cached thumbnail of an image the caller has already validated and
 * opened, or null to serve the original: no resizer on this host, an image
 * that is small already, a format the header parser cannot size, or any
 * failure. The resizer reads a private copy taken from the open descriptor, so
 * a path swapped after validation never reaches it. Thumbs are keyed by the
 * real path, modification time and size, so an edited file gets a new one.
 */
export const assetThumbnail = Effect.fn("AssetThumbnails.assetThumbnail")(
  function* (
    input: { readonly filePath: string; readonly file: OpenMediaFile },
    options?: {
      readonly resizer?: ThumbnailResizer | null | undefined;
      readonly maxCacheBytes?: number | undefined;
    },
  ) {
    const path = yield* Path.Path;
    const extension = path.extname(input.filePath).toLowerCase();
    if (!isThumbnailableExtension(extension)) return null;
    const { size, mtimeMs } = input.file.info;
    if (size <= 0n || size > BigInt(THUMBNAIL_SOURCE_MAX_BYTES)) return null;

    const dimensions = readImageDimensions(
      yield* readMediaFileHeader(input.filePath, input.file, IMAGE_DIMENSIONS_HEADER_BYTES),
    );
    if (dimensions === null) return null;
    if (dimensions.width <= THUMBNAIL_MAX_WIDTH && size <= BigInt(THUMBNAIL_SKIP_MAX_BYTES)) {
      return null;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const directory = path.join(config.providerStatusCacheDir, THUMBNAIL_CACHE_DIRECTORY);
    const key = Hex.encode(
      yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(`${input.filePath}\0${mtimeMs}\0${size}`),
      ),
    );
    const cachePath = path.join(directory, `${key}.jpg`);
    const now = yield* Clock.currentTimeMillis;
    if (yield* fileSystem.exists(cachePath)) {
      // The modification time is the last use, which is what pruning sorts by.
      const usedAt = DateTime.toDateUtc(DateTime.makeUnsafe(now));
      yield* fileSystem.utimes(cachePath, usedAt, usedAt).pipe(Effect.ignore);
      return cachePath;
    }

    const resizer = options?.resizer === undefined ? platformThumbnailResizer() : options.resizer;
    if (resizer === null) return null;

    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const temporary = path.join(
      directory,
      `.${key}-${process.pid}-${now.toString(36)}-${yield* crypto.randomUUIDv4}`,
    );
    const sourceCopy = `${temporary}.src${extension}`;
    const target = `${temporary}.jpg`;
    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(cachePath)) return cachePath;
      const bytes = Buffer.alloc(Number(size));
      const { bytesRead } = yield* Effect.tryPromise({
        try: () => input.file.handle.read(bytes, 0, bytes.length, 0),
        catch: (cause) => new ThumbnailResizeError({ cause }),
      });
      yield* fileSystem.writeFile(sourceCopy, bytes.subarray(0, bytesRead), { mode: 0o600 });
      yield* resizer({
        source: sourceCopy,
        target,
        width: Math.min(THUMBNAIL_MAX_WIDTH, dimensions.width),
      });
      const produced = yield* fileSystem.stat(target);
      if (produced.type !== "File" || produced.size === 0n) return null;
      yield* fileSystem.rename(target, cachePath);
      yield* pruneThumbnailCache(
        directory,
        options?.maxCacheBytes ?? THUMBNAIL_CACHE_MAX_BYTES,
      ).pipe(Effect.ignore);
      return (yield* fileSystem.exists(cachePath)) ? cachePath : null;
    }).pipe(
      Effect.ensuring(
        Effect.all([
          fileSystem.remove(sourceCopy).pipe(Effect.ignore),
          fileSystem.remove(target).pipe(Effect.ignore),
        ]),
      ),
      resizeSlots.withPermits(1),
    );
  },
  Effect.tapError((cause) => Effect.logWarning("Failed to make an asset thumbnail.", { cause })),
  Effect.orElseSucceed((): string | null => null),
);
