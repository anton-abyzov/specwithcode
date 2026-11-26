/**
 * How the screen sharing store is kept on disk (1490 AC-02).
 *
 * `safeStorage` alone is not enough: on macOS it is AES-CBC with no integrity
 * check, so an edited file can still decrypt to something. So the contents are
 * sealed with AES-256-GCM under a random key made for each write, and only
 * that key goes through `safeStorage`. A file that was edited, cut short,
 * given another key or written for another purpose does not open.
 *
 * What this does not stop: a process running as this user can put back an
 * older file that once was valid. Nothing here can count writes outside the
 * file itself.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - synchronous AES-GCM for a file read at startup.
import * as NodeCrypto from "node:crypto";

/** The operating system's encryption for this app, as `safeStorage` gives it. */
export interface ScreenShareKeyWrap {
  readonly available: () => boolean;
  readonly wrap: (text: string) => Uint8Array;
  readonly unwrap: (bytes: Uint8Array) => string;
}

const PURPOSE = "specwithcode screen share store v1";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesOf = (text: unknown, length?: number): Buffer => {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new Error("bad field");
  const bytes = Buffer.from(text, "base64");
  if (length !== undefined && bytes.length !== length) throw new Error("bad length");
  return bytes;
};

export const sealScreenShareStore = (wrap: ScreenShareKeyWrap, text: string): Uint8Array => {
  const key = NodeCrypto.randomBytes(32);
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(PURPOSE, "utf8"));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      key: base64(wrap.wrap(base64(key))),
      nonce: base64(nonce),
      data: base64(data),
    }),
    "utf8",
  );
};

/** Throws for anything that is not a file this app sealed on this machine. */
export const unsealScreenShareStore = (wrap: ScreenShareKeyWrap, file: Uint8Array): string => {
  if (file.length > MAX_FILE_BYTES) throw new Error("too large");
  const envelope = JSON.parse(Buffer.from(file).toString("utf8")) as Record<string, unknown>;
  if (typeof envelope !== "object" || envelope === null || envelope.v !== 1)
    throw new Error("not a store");
  const key = bytesOf(wrap.unwrap(bytesOf(envelope.key)), 32);
  const nonce = bytesOf(envelope.nonce, 12);
  const data = bytesOf(envelope.data);
  if (data.length < 16) throw new Error("cut short");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(PURPOSE, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString("utf8");
};
