// @effect-diagnostics nodeBuiltinImport:off - the test encodes real PNG bytes for the resizer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeZlib from "node:zlib";
import { ThreadId } from "@specweave-studio/contracts";
import { readImageDimensions } from "@specweave-studio/shared/imageDimensions";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as StudioProjectFileLoader from "../project/StudioProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import {
  assetThumbnail,
  pruneThumbnailCache,
  THUMBNAIL_MAX_WIDTH,
  ThumbnailResizeError,
  type ThumbnailResizer,
} from "./AssetThumbnails.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { openMediaFile } from "./MediaFile.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-asset-thumbnails-test-",
});
const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(StudioProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(NodeServices.layer));

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
};
/** A real RGB PNG; noise keeps it from compressing to nothing. */
const png = (width: number, height: number, noisy = true) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  if (noisy) for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 31) & 0xff;
  for (let row = 0; row < height; row += 1) raw[row * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

const writeImage = Effect.fn(function* (name: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "studio-thumb-source-" });
  const filePath = yield* fs.realPath(directory).pipe(Effect.map((dir) => path.join(dir, name)));
  yield* fs.writeFile(filePath, bytes);
  return filePath;
});

const thumbnailOf = (filePath: string, resizer: ThumbnailResizer | null, maxCacheBytes?: number) =>
  openMediaFile(filePath).pipe(
    Effect.flatMap((file) =>
      file === null
        ? Effect.succeed(null)
        : assetThumbnail({ filePath, file }, { resizer, maxCacheBytes }),
    ),
    Effect.scoped,
  );

describe("AssetThumbnails", () => {
  it.effect("resizes once, then serves the cached thumb until the file changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = yield* writeImage("wide.png", png(1600, 40));
      const calls: Array<{ width: number; copied: number }> = [];
      const resizer: ThumbnailResizer = ({ source, target, width }) =>
        Effect.gen(function* () {
          calls.push({ width, copied: (yield* fs.readFile(source)).length });
          yield* fs.writeFileString(target, "thumb");
        });

      const first = yield* thumbnailOf(filePath, resizer);
      expect(first).toMatch(/asset-thumbnails[\\/][0-9a-f]{64}\.jpg$/);
      expect(yield* fs.readFileString(first!)).toBe("thumb");
      // The resizer reads a private copy of the validated bytes, at the capped width.
      expect(calls).toEqual([
        { width: THUMBNAIL_MAX_WIDTH, copied: (yield* fs.readFile(filePath)).length },
      ]);
      expect(yield* thumbnailOf(filePath, resizer)).toBe(first);
      // A cached thumb is served on a host with no resizer too.
      expect(yield* thumbnailOf(filePath, null)).toBe(first);
      expect(calls).toHaveLength(1);

      yield* fs.writeFile(filePath, png(1600, 41));
      const second = yield* thumbnailOf(filePath, resizer);
      expect(second).not.toBe(first);
      expect(calls).toHaveLength(2);
      // No temporary copy is left behind.
      const names = yield* fs.readDirectory(path.dirname(first!));
      expect(names.filter((name) => name.startsWith("."))).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the original when it cannot or need not resize", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resizer: ThumbnailResizer = ({ target }) => fs.writeFileString(target, "thumb");
      const failing: ThumbnailResizer = () =>
        Effect.fail(new ThumbnailResizeError({ cause: "resizer crashed" }));
      const silent: ThumbnailResizer = () => Effect.void;

      // No resizer on this host.
      expect(yield* thumbnailOf(yield* writeImage("a.png", png(1600, 40)), null)).toBeNull();
      // Small already.
      expect(yield* thumbnailOf(yield* writeImage("b.png", png(320, 20)), resizer)).toBeNull();
      // Not an image the header parser can size.
      expect(
        yield* thumbnailOf(yield* writeImage("c.png", new TextEncoder().encode("nope")), resizer),
      ).toBeNull();
      expect(yield* thumbnailOf(yield* writeImage("d.svg", png(1600, 40)), resizer)).toBeNull();
      // A resizer that fails or writes nothing.
      expect(yield* thumbnailOf(yield* writeImage("e.png", png(1600, 40)), failing)).toBeNull();
      expect(yield* thumbnailOf(yield* writeImage("f.png", png(1600, 40)), silent)).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  // Live: pruning compares file times with the real clock.
  it.live("drops the least recently used thumbs once the cache is over its cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "studio-thumb-cache-" });
      const now = yield* Clock.currentTimeMillis;
      const at = (millis: number) => DateTime.toDateUtc(DateTime.makeUnsafe(millis));
      for (const [name, ageMinutes] of [
        ["oldest.jpg", 30],
        ["older.jpg", 20],
        ["newest.jpg", 1],
        [".stale.src.png", 30],
        [".in-flight.src.png", 1],
      ] as const) {
        const file = path.join(directory, name);
        yield* fs.writeFile(file, new Uint8Array(100));
        yield* fs.utimes(file, at(now), at(now - ageMinutes * 60_000));
      }
      yield* pruneThumbnailCache(directory, 150);
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        ".in-flight.src.png",
        "newest.jpg",
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs the variant into the URL of an image and of nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const claimsOf = (relativeUrl: string) =>
        JSON.parse(
          Buffer.from(
            relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length).split(".")[0]!,
            "base64url",
          ).toString("utf8"),
        ) as { variant?: string };
      const image = yield* writeImage("shot.png", png(1600, 40));
      const video = yield* writeImage("clip.mp4", new Uint8Array(8));
      const issue = (path: string, variant?: "thumb") =>
        issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path },
          variant,
        });

      const full = yield* issue(image);
      const thumb = yield* issue(image, "thumb");
      expect(claimsOf(full.relativeUrl).variant).toBeUndefined();
      expect(claimsOf(thumb.relativeUrl).variant).toBe("thumb");
      // The box a client reserves keeps the original's ratio.
      expect(thumb.imageDimensions).toEqual({ width: 1600, height: 40 });
      expect(claimsOf((yield* issue(video, "thumb")).relativeUrl).variant).toBeUndefined();

      // The full URL never serves a thumb, whatever the cache holds.
      const suffix = full.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(
        yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
      ).toMatchObject({ kind: "file", path: yield* fs.realPath(image), mimeType: "image/png" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(process.platform !== "darwin")(
    "serves a real JPEG at most 640 px wide through a thumb URL",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const image = yield* writeImage("screenshot.png", png(1600, 900));
        const issued = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: image },
          variant: "thumb",
        });
        const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const asset = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
        expect(asset).toMatchObject({ kind: "file", mimeType: "image/jpeg" });
        if (asset?.kind !== "file") return;
        expect(asset.path).not.toBe(image);
        const bytes = yield* fs.readFile(asset.path);
        expect(readImageDimensions(bytes)).toEqual({ width: 640, height: 360 });
        expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
      }).pipe(Effect.provide(layerTest)),
  );
});
