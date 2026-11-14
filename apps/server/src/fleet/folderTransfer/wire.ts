// @effect-diagnostics nodeBuiltinImport:off - binary framing and gzip or zstd of chunk batches.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

/**
 * The copy's HTTP wire. Every route lives under one versioned prefix so an older
 * server answers 404 and the newer side can say which machine needs an update.
 */
export const FOLDER_TRANSFER_PREFIX = "/api/folder-transfer/v1";
export const FOLDER_TRANSFER_VERSION = 1;
/** A chunk batch request names at most this many chunks... */
export const MAX_BATCH_CHUNKS = 32;
/**
 * ...or this many, when the source's hello offers it (`maxBatchChunks`). Small files are
 * one chunk each, so a larger batch cuts the request count for many small files. An older
 * source never offers it, and an older destination never asks for more than 32.
 */
export const MAX_BATCH_CHUNKS_LARGE = 1024;
/** ...and the destination keeps each batch under this many bytes. */
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export const CHUNK_OK = 0;
/** The chunk is not in this operation's manifest. */
export const CHUNK_UNKNOWN = 1;
/** The file holding the chunk changed since the manifest; ask for a refresh. */
export const CHUNK_CHANGED = 2;

export interface ChunkFrame {
  readonly sha256: string;
  readonly status: number;
  readonly data: Buffer;
}

/** Batch compression. zstd only when this runtime has it and the destination asked for it. */
export type FrameEncoding = "gzip" | "zstd";
export const zstdAvailable = (): boolean =>
  typeof NodeZlib.zstdCompressSync === "function" &&
  typeof NodeZlib.zstdDecompressSync === "function";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Frames: 32-byte SHA-256, 1-byte status, 4-byte big-endian length, data. Gzipped, or zstd
 * when asked. The decoder tells them apart by their magic bytes, so no header has to survive
 * the relay.
 */
export function encodeFrames(
  frames: ReadonlyArray<ChunkFrame>,
  encoding: FrameEncoding = "gzip",
): Buffer {
  const parts: Array<Buffer> = [];
  for (const frame of frames) {
    const head = Buffer.alloc(37);
    Buffer.from(frame.sha256, "hex").copy(head, 0);
    head.writeUInt8(frame.status, 32);
    head.writeUInt32BE(frame.data.length, 33);
    parts.push(head, frame.data);
  }
  const raw = Buffer.concat(parts);
  return encoding === "zstd" && zstdAvailable()
    ? NodeZlib.zstdCompressSync(raw, {
        params: { [NodeZlib.constants.ZSTD_c_compressionLevel]: 3 },
      })
    : NodeZlib.gzipSync(raw, { level: 1 });
}

export function decodeFrames(body: Uint8Array): Array<ChunkFrame> {
  const limit = { maxOutputLength: MAX_BATCH_BYTES + 1024 * 1024 };
  const zstd = body.length >= 4 && ZSTD_MAGIC.equals(Buffer.from(body.subarray(0, 4)));
  if (zstd && !zstdAvailable()) throw new Error("This machine cannot read zstd chunk batches.");
  const raw = zstd ? NodeZlib.zstdDecompressSync(body, limit) : NodeZlib.gunzipSync(body, limit);
  const frames: Array<ChunkFrame> = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 37 > raw.length) throw new Error("Truncated chunk frame.");
    const sha256 = raw.subarray(offset, offset + 32).toString("hex");
    const status = raw.readUInt8(offset + 32);
    const length = raw.readUInt32BE(offset + 33);
    offset += 37;
    if (offset + length > raw.length) throw new Error("Truncated chunk data.");
    frames.push({ sha256, status, data: raw.subarray(offset, offset + length) });
    offset += length;
  }
  return frames;
}

export const sha256Hex = (data: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

export const SHA256 = /^[a-f0-9]{64}$/;
export const OPERATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
