import { expect, it } from "vite-plus/test";

import { batchChunksFor } from "./pullWorker.ts";
import {
  CHUNK_OK,
  decodeFrames,
  encodeFrames,
  MAX_BATCH_CHUNKS,
  MAX_BATCH_CHUNKS_LARGE,
  sha256Hex,
  zstdAvailable,
} from "./wire.ts";

const frames = Array.from({ length: 300 }, (_, index) => {
  const data = Buffer.from(`chunk ${index} `.repeat(40));
  return { sha256: sha256Hex(data), status: CHUNK_OK, data };
});

it("reads a batch packed with gzip or zstd, telling them apart by their first bytes", () => {
  const gzip = encodeFrames(frames);
  expect([gzip[0], gzip[1]]).toEqual([0x1f, 0x8b]);
  expect(decodeFrames(gzip).map((frame) => frame.sha256)).toEqual(
    frames.map((frame) => frame.sha256),
  );
  if (!zstdAvailable()) return;
  const zstd = encodeFrames(frames, "zstd");
  expect([...zstd.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  const decoded = decodeFrames(zstd);
  expect(decoded).toHaveLength(frames.length);
  expect(decoded.every((frame, at) => frame.data.equals(frames[at]!.data))).toBe(true);
});

it("takes the batch size a source offers, within what this side accepts", () => {
  // An older source says nothing and keeps the old limit.
  expect(batchChunksFor(undefined)).toBe(MAX_BATCH_CHUNKS);
  expect(batchChunksFor("1024")).toBe(MAX_BATCH_CHUNKS);
  expect(batchChunksFor(MAX_BATCH_CHUNKS_LARGE)).toBe(MAX_BATCH_CHUNKS_LARGE);
  expect(batchChunksFor(1_000_000)).toBe(MAX_BATCH_CHUNKS_LARGE);
  expect(batchChunksFor(4)).toBe(MAX_BATCH_CHUNKS);
});
