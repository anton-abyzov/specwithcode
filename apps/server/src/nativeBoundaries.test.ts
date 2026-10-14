// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native crypto is the independent byte-compatibility oracle.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native path is the platform-compatibility oracle.
import * as path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { sha256, randomBytes } from "./nodeCrypto.ts";
import { nodePath } from "./nodePath.ts";
import { parseJson, stringifyJson } from "./json.ts";

describe("native boundary compatibility", () => {
  it("preserves SHA-256 chunk bytes and wire encodings", () => {
    const chunks = ["café", new Uint8Array([0, 255, 128]), "\u0000tail"];
    const native = createHash("sha256");
    for (const chunk of chunks) native.update(chunk);
    const expected = native.digest();
    expect(sha256(chunks)).toEqual(expected);
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(sha256(chunks, encoding)).toBe(expected.toString(encoding));
    }
    expect(randomBytes(32)).toHaveLength(32);
    expect(randomBytes(32)).not.toEqual(randomBytes(32));
  });
  it("preserves native POSIX and Windows path semantics", () => {
    for (const [actual, expected] of [
      [nodePath, path],
      [nodePath.posix, path.posix],
      [nodePath.win32, path.win32],
    ] as const) {
      expect(actual.join("a", "..", "b", "file.txt")).toBe(
        expected.join("a", "..", "b", "file.txt"),
      );
      expect(actual.resolve("a", "..", "b")).toBe(expected.resolve("a", "..", "b"));
      expect(actual.parse("/tmp/a.txt")).toEqual(expected.parse("/tmp/a.txt"));
    }
  });
  it("preserves JSON ordering, whitespace and optional-field behavior", () => {
    const payload = {
      z: "café",
      missing: undefined,
      array: [undefined, null, NaN],
      nested: { a: true },
    };
    expect(stringifyJson(payload)).toBe(JSON.stringify(payload));
    expect(stringifyJson(payload, null, 2)).toBe(JSON.stringify(payload, null, 2));
    expect(parseJson(stringifyJson(payload))).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(() => parseJson("{broken")).toThrow();
    expect(() => stringifyJson({ big: 1n })).toThrow();
  });
});
