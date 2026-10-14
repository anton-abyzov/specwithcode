import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import * as Effect from "effect/Effect";

/** Synchronous Node-backed Effect crypto at native protocol/serialization boundaries. */
export function sha256(chunks: ReadonlyArray<string | Uint8Array>): Buffer;
export function sha256(
  chunks: ReadonlyArray<string | Uint8Array>,
  encoding: BufferEncoding,
): string;
export function sha256(
  chunks: ReadonlyArray<string | Uint8Array>,
  encoding?: BufferEncoding,
): Buffer | string {
  const input = Buffer.concat(
    chunks.map((chunk) =>
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk),
    ),
  );
  const digest = Buffer.from(Effect.runSync(NodeCrypto.make.digest("SHA-256", input)));
  return encoding === undefined ? digest : digest.toString(encoding);
}
export const randomBytes = (size: number): Buffer =>
  Buffer.from(Effect.runSync(NodeCrypto.make.randomBytes(size)));
