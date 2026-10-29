// @effect-diagnostics nodeBuiltinImport:off - isolated immutable capture fixtures.
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { scanFolder, selectEntries } from "./manifest.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import {
  captureSourceFiles,
  capturedRange,
  loadCapturedIndex,
  validateCapturedSource,
} from "./sourceSnapshot.ts";
import { sha256Hex } from "./wire.ts";
let base: string;
let source: string;
let root: string;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-captured-")));
  source = Path.join(base, "source");
  root = Path.join(base, "snapshot");
  await FSP.mkdir(source);
  await FSP.writeFile(Path.join(source, "work.txt"), "reviewed contents");
  await FSP.writeFile(Path.join(source, ".env"), "DO_NOT_CAPTURE=example");
});
afterEach(async () => {
  await FSP.rm(base, { recursive: true, force: true });
});
async function capture(extra: Partial<Parameters<typeof captureSourceFiles>[0]> = {}) {
  const scan = await scanFolder(source);
  const entries = selectEntries(scan.entries, new Set(DEFAULT_SELECTION));
  const result = await captureSourceFiles({
    root,
    entries,
    sourceRoot: () => source,
    stop: () => {},
    ...extra,
  });
  const manifest = Buffer.from(JSON.stringify(entries));
  const captured = { ...result, capturedAt: 1, manifestHash: sha256Hex(manifest) };
  return { entries, captured, manifest };
}
it("serves captured bytes after source rewrite/removal and never includes secrets", async () => {
  const { captured, manifest } = await capture();
  const index = await loadCapturedIndex(root, captured);
  expect(Object.keys(index)).toEqual(["work.txt"]);
  await FSP.writeFile(Path.join(source, "work.txt"), "later contents");
  await FSP.unlink(Path.join(source, "work.txt"));
  expect((await capturedRange(root, index, "work.txt", 0, 17)).toString()).toBe(
    "reviewed contents",
  );
  await expect(validateCapturedSource(root, captured, manifest)).resolves.toBeUndefined();
  expect(
    (await FSP.readFile(Path.join(root, "files.pack"))).includes(Buffer.from("DO_NOT_CAPTURE")),
  ).toBe(false);
});
it("rejects corrupt backing, index and manifest instead of rereading the source", async () => {
  const { captured, manifest } = await capture();
  await expect(
    validateCapturedSource(root, captured, Buffer.from("changed manifest")),
  ).rejects.toThrow();
  await FSP.writeFile(Path.join(root, "files.pack"), "bad");
  await expect(validateCapturedSource(root, captured, manifest)).rejects.toThrow();
  await FSP.writeFile(Path.join(root, "index.json"), "{}");
  await expect(loadCapturedIndex(root, captured)).rejects.toThrow();
});
it("rejects a selected file replaced by a symlink without reading its target", async () => {
  const scan = await scanFolder(source);
  const entries = selectEntries(scan.entries, new Set(DEFAULT_SELECTION));
  await FSP.unlink(Path.join(source, "work.txt"));
  await FSP.symlink(Path.join(source, ".env"), Path.join(source, "work.txt"));
  await expect(capture({ entries })).rejects.toThrow();
  expect((await FSP.readFile(Path.join(root, "files.pack"))).length).toBe(0);
});
it("refuses insufficient source disk and observes cancellation without altering source", async () => {
  await expect(capture({ freeBytes: async () => 0 })).rejects.toThrow(/free on the source/);
  await expect(
    capture({
      stop: () => {
        throw new Error("cancelled");
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(await FSP.readFile(Path.join(source, "work.txt"), "utf8")).toBe("reviewed contents");
});
it("captures link metadata without following links or adding target bytes", async () => {
  await FSP.symlink(".env", Path.join(source, "link"));
  const { entries, captured } = await capture();
  expect(entries.find((entry) => entry.path === "link")?.target).toBe(".env");
  expect(Object.keys(await loadCapturedIndex(root, captured))).not.toContain("link");
});
