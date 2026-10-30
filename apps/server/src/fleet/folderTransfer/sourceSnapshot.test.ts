// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - isolated immutable capture fixtures and a bounded churn window.
import * as NodeFS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { scanFolder, selectEntries } from "./manifest.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { CaptureFilesystemRefused } from "./sourceCaptureFilesystem.ts";
import {
  CaptureSpaceRefused,
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
it("waits out a parent folder that keeps changing for a moment instead of failing", async () => {
  for (let index = 0; index < 20; index++)
    await FSP.writeFile(Path.join(source, `note-${index}.txt`), `note ${index}`);
  const scan = await scanFolder(source);
  const entries = selectEntries(scan.entries, new Set(DEFAULT_SELECTION));
  // Another process adds and removes files beside the selection for a while,
  // as agents and editors do in a project or home folder.
  let churning = true;
  const churn = (async () => {
    for (let index = 0; churning; index++) {
      const name = Path.join(source, `.churn-${index}`);
      await FSP.writeFile(name, "x");
      await FSP.unlink(name);
    }
  })();
  const stopChurn = new AbortController();
  void NodeTimersPromises.setTimeout(300, undefined, { signal: stopChurn.signal }).then(
    () => (churning = false),
    () => {},
  );
  try {
    const { captured } = await capture({ entries });
    expect(Object.keys(await loadCapturedIndex(root, captured))).toContain("note-19.txt");
  } finally {
    churning = false;
    stopChurn.abort();
    await churn;
  }
});
it("keeps the last consistent read of a file that changes on every try, only when asked", async () => {
  const work = Path.join(source, "work.txt");
  let writes = 0;
  // Another program rewrites the file on every read, as an agent appending to a ledger does.
  const rewrite = () => {
    writes += 1;
    NodeFS.writeFileSync(work, `rewritten ${writes} ${"x".repeat(writes % 7)}`);
  };
  const quick = { stop: rewrite, retryWait: async () => {} };
  await expect(capture(quick)).rejects.toThrow(/kept changing while being captured: work\.txt/);
  const { entries, captured, manifest } = await capture({ ...quick, onChanging: "keep-last" });
  const kept = entries.find((entry) => entry.path === "work.txt")!;
  expect(kept.unstable).toBeUndefined();
  const index = await loadCapturedIndex(root, captured);
  const bytes = await capturedRange(root, index, "work.txt", 0, index["work.txt"]!.size);
  expect(bytes.toString()).toMatch(/^rewritten \d+ x*$/);
  expect(kept.size).toBe(bytes.length);
  expect(kept.sha256).toBe(sha256Hex(bytes));
  expect(kept.chunks).toEqual([sha256Hex(bytes)]);
  await expect(validateCapturedSource(root, captured, manifest)).resolves.toBeUndefined();
  expect(captured.changing).toEqual(["work.txt"]);
  expect(captured.stats["work.txt"]).toBeUndefined();
});
it("records each steadily read file's identity for the later drift check", async () => {
  const { captured } = await capture({ onChanging: "keep-last", now: () => Date.now() + 10_000 });
  const stat = await FSP.lstat(Path.join(source, "work.txt"), { bigint: true });
  expect(captured.changing).toEqual([]);
  expect(captured.stats["work.txt"]).toEqual({
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    ino: String(stat.ino),
    dev: String(stat.dev),
  });
});
it("records no identity for a file stamped within a clock tick of its read", async () => {
  // A coarse clock could stamp a rewrite in the same tick: the drift check must read it.
  const { captured } = await capture({ onChanging: "keep-last" });
  expect(captured.changing).toEqual([]);
  expect(captured.stats["work.txt"]).toBeUndefined();
  const later = await capture({ onChanging: "keep-last", now: () => Date.now() + 10_000 });
  expect(later.captured.stats["work.txt"]).toBeDefined();
});
it("refuses a capture without room as a refused volume, so a moving copy can fall back", async () => {
  const refused = capture({ freeBytes: async () => 0 });
  await expect(refused).rejects.toBeInstanceOf(CaptureSpaceRefused);
  await expect(refused).rejects.toBeInstanceOf(CaptureFilesystemRefused);
  await expect(refused).rejects.toThrow(/needs \d+ bytes free on the source/);
});
