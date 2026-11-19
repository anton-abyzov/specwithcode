import { describe, expect, it } from "vite-plus/test";

import * as Manifest from "./manifest.ts";
import type { ManifestEntry } from "./manifest.ts";
import * as Paths from "./paths.ts";

/**
 * What a destination accepts in a received manifest, before it asks for a chunk.
 * One bad entry refuses the whole manifest.
 */

interface Volume {
  readonly platform: NodeJS.Platform;
  readonly caseInsensitive: boolean;
}
type Refusal = { readonly path: string; readonly reason: string } | null;
const validate = (entries: ReadonlyArray<ManifestEntry>, volume: Partial<Volume> = {}): Refusal =>
  (
    Manifest as unknown as {
      validateManifestEntries: (entries: ReadonlyArray<ManifestEntry>, volume: Volume) => Refusal;
    }
  ).validateManifestEntries(entries, { platform: "linux", caseInsensitive: false, ...volume });
const safe = (value: string, platform: NodeJS.Platform) =>
  (
    Paths as unknown as {
      isSafeDestinationPath: (value: string, platform: NodeJS.Platform) => boolean;
    }
  ).isSafeDestinationPath(value, platform);

const file = (path: string, size = 1): ManifestEntry => ({
  path,
  type: "file",
  mode: 0o644,
  size,
  mtimeMs: 0,
  class: "untracked",
  repo: null,
});
const directory = (path: string): ManifestEntry => ({ ...file(path, 0), type: "directory" });
const link = (path: string, target: string): ManifestEntry => ({
  ...file(path, 0),
  type: "symlink",
  target,
});

describe("isSafeDestinationPath", () => {
  it("accepts ordinary relative paths", () => {
    expect(safe("docs/guide.md", "linux")).toBe(true);
    expect(safe("docs/guide.md", "win32")).toBe(true);
    expect(safe("con/aux.txt", "linux")).toBe(true);
  });

  it.each(["/etc/passwd", "../outside", "a/../../b", "a//b", "./a", "a/\u0000b"])(
    "refuses %j everywhere",
    (path) => {
      expect(safe(path, "linux")).toBe(false);
      expect(safe(path, "darwin")).toBe(false);
      expect(safe(path, "win32")).toBe(false);
    },
  );

  it("refuses a part longer than 255 bytes, counted in UTF-8", () => {
    expect(safe(`a/${"x".repeat(255)}`, "linux")).toBe(true);
    expect(safe(`a/${"x".repeat(256)}`, "linux")).toBe(false);
    expect(safe(`a/${"é".repeat(128)}`, "linux")).toBe(false);
  });

  it.each([
    "CON",
    "nul.txt",
    "a/COM1",
    "a/lpt9.log",
    "a/Aux",
    "a/name.",
    "a/name ",
    "C:/x",
    "a\\b",
  ])("refuses %j on Windows only", (path) => {
    expect(safe(path, "win32")).toBe(false);
    expect(safe(path, "linux")).toBe(true);
  });
});

describe("validateManifestEntries", () => {
  it("accepts a plain tree, with a link kept as a link", () => {
    expect(
      validate([directory("a"), file("a/b.txt"), link("a/l", "../outside"), file("c.txt")]),
    ).toBeNull();
  });

  it.each([["/abs"], ["a/../../b"], [".."]])("refuses the path %j", (path) => {
    expect(validate([file("ok.txt"), file(path)])).toMatchObject({ path, reason: "unsafe-path" });
  });

  it("refuses two names that are one file where case does not matter", () => {
    const entries = [file("docs/README.md"), file("docs/Readme.md")];
    expect(validate(entries, { caseInsensitive: true })).toMatchObject({
      path: "docs/Readme.md",
      reason: "alias",
    });
    expect(validate(entries, { caseInsensitive: false })).toBeNull();
  });

  it("refuses two spellings of one name under Unicode normalization", () => {
    const entries = [file("caf\u00e9.txt"), file("cafe\u0301.txt")];
    expect(validate(entries, { platform: "darwin", caseInsensitive: true })).toMatchObject({
      reason: "alias",
    });
    expect(validate(entries, { platform: "darwin", caseInsensitive: false })).toMatchObject({
      reason: "alias",
    });
  });

  it("refuses folders that differ only by case, through the files in them", () => {
    expect(
      validate([file("Docs/a.txt"), file("docs/b.txt")], { caseInsensitive: true }),
    ).toMatchObject({ reason: "alias" });
  });

  it("refuses an entry that is both a file and a folder of another entry", () => {
    expect(validate([file("a"), file("a/b.txt")])).toMatchObject({
      path: "a/b.txt",
      reason: "not-a-folder",
    });
  });

  it("refuses an entry below a link: nothing is written through one", () => {
    expect(validate([link("a", "/etc"), file("a/passwd")])).toMatchObject({
      path: "a/passwd",
      reason: "link-in-path",
    });
    expect(validate([file("a/passwd"), link("a", "/etc")])).toMatchObject({
      reason: "link-in-path",
    });
  });

  it("refuses a link whose target text is not a path", () => {
    expect(validate([link("l", "a\u0000b")])).toMatchObject({ path: "l", reason: "unsafe-link" });
    expect(validate([link("l", "")])).toMatchObject({ path: "l", reason: "unsafe-link" });
    expect(validate([link("l", "x".repeat(4097))])).toMatchObject({ reason: "unsafe-link" });
  });

  it("refuses a size that is not a whole number of bytes", () => {
    expect(validate([file("a", 1.5)])).toMatchObject({ path: "a", reason: "bad-size" });
    expect(validate([file("a", -1)])).toMatchObject({ path: "a", reason: "bad-size" });
    expect(validate([file("a", Number.NaN)])).toMatchObject({ path: "a", reason: "bad-size" });
  });

  it("applies the Windows names only on Windows", () => {
    expect(
      validate([file("a/NUL.txt")], { platform: "win32", caseInsensitive: true }),
    ).toMatchObject({ reason: "unsafe-path" });
    expect(validate([file("a/NUL.txt")])).toBeNull();
  });
});
