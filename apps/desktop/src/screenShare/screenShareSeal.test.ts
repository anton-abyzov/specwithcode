import { describe, expect, it } from "vite-plus/test";

import {
  sealScreenShareStore,
  unsealScreenShareStore,
  type ScreenShareKeyWrap,
} from "./screenShareSeal.ts";

/**
 * Stands for `safeStorage` at its weakest: it hides the text but checks
 * nothing, so changed bytes still "decrypt". Each machine has its own pad.
 */
const weakWrap = (machine: number): ScreenShareKeyWrap => ({
  available: () => true,
  wrap: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ machine),
  unwrap: (bytes) => Buffer.from(Buffer.from(bytes).map((byte) => byte ^ machine)).toString("utf8"),
});

const TEXT = JSON.stringify({ enabled: true, grants: [{ label: "Work laptop" }] });
const parse = (file: Uint8Array) =>
  JSON.parse(Buffer.from(file).toString("utf8")) as Record<string, string>;
const write = (envelope: Record<string, unknown>) => Buffer.from(JSON.stringify(envelope), "utf8");
const flip = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
  return bytes.toString("base64");
};

describe("the screen sharing store's seal", () => {
  const wrap = weakWrap(0x5a);

  it("opens what it sealed and shows none of it in the file", () => {
    const file = sealScreenShareStore(wrap, TEXT);
    expect(unsealScreenShareStore(wrap, file)).toBe(TEXT);
    const onDisk = Buffer.from(file).toString("utf8");
    expect(onDisk).not.toContain("Work laptop");
    expect(onDisk).not.toContain("enabled");
  });

  it("uses a new key and nonce for every write", () => {
    const first = parse(sealScreenShareStore(wrap, TEXT));
    const second = parse(sealScreenShareStore(wrap, TEXT));
    expect(first.key).not.toBe(second.key);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.data).not.toBe(second.data);
  });

  it("refuses a file with one bit changed anywhere, even where the system checks nothing", () => {
    const envelope = parse(sealScreenShareStore(wrap, TEXT));
    for (const field of ["key", "nonce", "data"] as const)
      expect(() =>
        unsealScreenShareStore(wrap, write({ ...envelope, [field]: flip(envelope[field]!) })),
      ).toThrow();
  });

  it("refuses contents moved under another file's key, a cut file and a plain one", () => {
    const one = parse(sealScreenShareStore(wrap, TEXT));
    const two = parse(sealScreenShareStore(wrap, JSON.stringify({ enabled: false })));
    expect(() => unsealScreenShareStore(wrap, write({ ...two, data: one.data }))).toThrow();
    expect(() => unsealScreenShareStore(wrap, write({ ...one, key: two.key }))).toThrow();
    expect(() =>
      unsealScreenShareStore(wrap, write({ ...one, data: one.data!.slice(0, 12) })),
    ).toThrow();
    expect(() => unsealScreenShareStore(wrap, Buffer.from(TEXT, "utf8"))).toThrow();
    expect(() => unsealScreenShareStore(wrap, Buffer.from("not json", "utf8"))).toThrow();
    expect(() => unsealScreenShareStore(wrap, write({ ...one, v: 2 }))).toThrow();
  });

  it("refuses a file sealed on another machine", () => {
    const file = sealScreenShareStore(weakWrap(0x21), TEXT);
    expect(() => unsealScreenShareStore(wrap, file)).toThrow();
  });
});
