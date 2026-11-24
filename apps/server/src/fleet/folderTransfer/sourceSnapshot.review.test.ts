// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - isolated capture fixtures for review regressions: content re-checks, ancestor swaps, FIFOs and racy stamps.
import * as ChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { DEFAULT_SELECTION } from "./classify.ts";
import { scanFolder, selectEntries } from "./manifest.ts";
import { pinSourceRoot } from "./sourceCaptureAnchor.ts";
import { CaptureFilesystemRefused } from "./sourceCaptureFilesystem.ts";
import { captureSourceFiles, capturedRange, loadCapturedIndex } from "./sourceSnapshot.ts";
import { sha256Hex } from "./wire.ts";

let base: string;
let source: string;
let root: string;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-capture-review-")));
  source = Path.join(base, "outer", "source");
  root = Path.join(base, "snapshot");
  await FSP.mkdir(source, { recursive: true });
  await FSP.writeFile(Path.join(source, "work.txt"), "reviewed contents");
});
afterEach(async () => {
  await FSP.rm(base, { recursive: true, force: true });
});

type CaptureInput = Parameters<typeof captureSourceFiles>[0];
async function scanned() {
  const scan = await scanFolder(source);
  const entries = selectEntries(scan.entries, new Set(DEFAULT_SELECTION));
  return { scan, entries };
}
const run = (input: Partial<CaptureInput> & Pick<CaptureInput, "entries">) =>
  captureSourceFiles({
    root,
    sourceRoot: () => source,
    stop: () => {},
    retryWait: async () => {},
    ...input,
  });
const packed = async () => (await FSP.readFile(Path.join(root, "files.pack"))).toString("utf8");

it("refuses an untracked .envrc that gained a secret value after the scan", async () => {
  await FSP.writeFile(Path.join(source, ".envrc"), "use flake\n");
  const { scan, entries } = await scanned();
  const envrc = entries.find((entry) => entry.path === ".envrc");
  expect(envrc?.class).not.toBe("secret");
  await FSP.writeFile(Path.join(source, ".envrc"), "export API_KEY=live-value-123456\n");
  await expect(run({ entries, contentProbed: scan.contentProbed })).rejects.toThrow(
    /secret|Compare again|comparison/i,
  );
  expect(await packed().catch(() => "")).not.toContain("live-value-123456");
});

it("refuses a probed config file that gained a known token after the scan", async () => {
  await FSP.writeFile(Path.join(source, "settings.json"), '{"theme":"dark"}');
  const { scan, entries } = await scanned();
  expect(entries.find((entry) => entry.path === "settings.json")?.class).not.toBe("secret");
  const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  await FSP.writeFile(Path.join(source, "settings.json"), `{"token":"${token}"}`);
  await expect(run({ entries, contentProbed: scan.contentProbed })).rejects.toThrow(
    /secret|Compare again|comparison/i,
  );
  expect(await packed().catch(() => "")).not.toContain(token);
});

it("refuses a config file the scan saw too big to judge that is now small and holds a token", async () => {
  await FSP.writeFile(Path.join(source, "settings.json"), `{"pad":"${"x".repeat(70_000)}"}`);
  const { scan, entries } = await scanned();
  expect(scan.contentProbed?.has("settings.json") ?? false).toBe(false);
  const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  await FSP.writeFile(Path.join(source, "settings.json"), `{"token":"${token}"}`);
  await expect(run({ entries, contentProbed: scan.contentProbed })).rejects.toThrow(
    /Compare again/,
  );
  expect(await packed().catch(() => "")).not.toContain(token);
});

it("refuses a config file the scan saw past the streaming size that is now small and holds a token", async () => {
  await FSP.writeFile(Path.join(source, "settings.json"), Buffer.alloc(9 * 1024 * 1024, 0x20));
  const { scan, entries } = await scanned();
  const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  await FSP.writeFile(Path.join(source, "settings.json"), `{"token":"${token}"}`);
  await expect(run({ entries, contentProbed: scan.contentProbed })).rejects.toThrow(
    /Compare again/,
  );
  expect(await packed().catch(() => "")).not.toContain(token);
});

it("refuses a config file that shrank and gained a token between its size check and the streamed open", async () => {
  const settings = Path.join(source, "settings.json");
  await FSP.writeFile(settings, Buffer.alloc(9 * 1024 * 1024, 0x20));
  const { scan, entries } = await scanned();
  const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  let opens = 0;
  await expect(
    run({
      entries,
      contentProbed: scan.contentProbed,
      raceHooks: {
        // The buffered try sees it big; it is small with a token by the streamed open.
        afterAncestors: async (absolute) => {
          if (absolute === settings && ++opens === 2)
            await FSP.writeFile(settings, `{"token":"${token}"}`);
        },
      },
    }),
  ).rejects.toThrow(/Compare again/);
  expect(opens).toBeGreaterThanOrEqual(2);
  expect(await packed().catch(() => "")).not.toContain(token);
});

it("captures an unchanged probed .envrc and config file", async () => {
  await FSP.writeFile(Path.join(source, ".envrc"), "use flake\n");
  await FSP.writeFile(Path.join(source, "settings.json"), '{"theme":"dark"}');
  const { scan, entries } = await scanned();
  const result = await run({ entries, contentProbed: scan.contentProbed });
  const captured = { ...result, capturedAt: 1, manifestHash: sha256Hex(Buffer.from("m")) };
  const index = await loadCapturedIndex(root, captured);
  expect(Object.keys(index).sort()).toEqual([".envrc", "settings.json", "work.txt"]);
});

it("refuses a probed .envrc grown past the probe limit since the scan", async () => {
  await FSP.writeFile(Path.join(source, ".envrc"), "use flake\n");
  const { scan, entries } = await scanned();
  await FSP.writeFile(Path.join(source, ".envrc"), `use flake\n${"# padding\n".repeat(8_000)}`);
  await expect(run({ entries, contentProbed: scan.contentProbed })).rejects.toThrow(
    /Compare again/,
  );
});

// AC-03 covers macOS and Linux; Windows keeps the path checks only (D-03).
it.skipIf(process.platform === "win32")(
  "refuses a tree swapped in above the copy root after the scan and before capture",
  async () => {
    const { scan, entries } = await scanned();
    const outer = Path.join(base, "outer");
    await FSP.rename(outer, Path.join(base, "outer-parked"));
    await FSP.mkdir(source, { recursive: true });
    await FSP.writeFile(Path.join(source, "work.txt"), "outside bytes!!!!");
    await expect(
      run({ entries, scannedRoots: new Map([[source, scan.rootIdentity!]]) }),
    ).rejects.toThrow(/changed after it was measured/);
    expect(await packed().catch(() => "")).not.toContain("outside bytes");
  },
);

it.skipIf(process.platform === "win32")(
  "never packs bytes from a tree swapped in above the copy root and restored",
  async () => {
    const { entries } = await scanned();
    const outer = Path.join(base, "outer");
    const parked = Path.join(base, "outer-parked");
    let swaps = 0;
    const result = await run({
      entries,
      raceHooks: {
        afterAncestors: async () => {
          if (swaps++ > 0) return;
          await FSP.rename(outer, parked);
          await FSP.mkdir(source, { recursive: true });
          await FSP.writeFile(Path.join(source, "work.txt"), "outside bytes!!!!");
        },
        beforeRecheck: async () => {
          if (!NodeFS.existsSync(parked)) return;
          await FSP.rm(outer, { recursive: true, force: true });
          await FSP.rename(parked, outer);
        },
      },
    });
    const captured = { ...result, capturedAt: 1, manifestHash: sha256Hex(Buffer.from("m")) };
    const index = await loadCapturedIndex(root, captured);
    expect((await capturedRange(root, index, "work.txt", 0, 17)).toString()).toBe(
      "reviewed contents",
    );
    expect(await packed()).not.toContain("outside bytes");
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a link the scan named from another tree than the pinned one",
  async () => {
    await FSP.symlink("work.txt", Path.join(source, "latest"));
    const { scan, entries } = await scanned();
    const link = entries.find((entry) => entry.path === "latest");
    expect(link?.target).toBe("work.txt");
    // As if a tree swapped in during the walk, and put back since, held another link here.
    const named = entries.map((entry) =>
      entry === link ? { ...entry, target: "../../outside/secret" } : entry,
    );
    await expect(
      run({ entries: named, scannedRoots: new Map([[source, scan.rootIdentity!]]) }),
    ).rejects.toThrow(/latest changed after this folder was measured/);
    // The link as the pinned tree holds it captures.
    await FSP.rm(root, { recursive: true, force: true });
    await expect(
      run({ entries, scannedRoots: new Map([[source, scan.rootIdentity!]]) }),
    ).resolves.toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a link whose folder became a link out of the root",
  async () => {
    await FSP.mkdir(Path.join(source, "docs"));
    await FSP.symlink("../work.txt", Path.join(source, "docs", "latest"));
    const { entries } = await scanned();
    expect(entries.find((entry) => entry.path === "docs/latest")?.target).toBe("../work.txt");
    // docs now leads outside, to a folder holding a link with the same text.
    const outside = Path.join(base, "elsewhere");
    await FSP.mkdir(outside);
    await FSP.rename(Path.join(source, "docs"), Path.join(outside, "docs"));
    await FSP.symlink(Path.join(outside, "docs"), Path.join(source, "docs"));
    await expect(run({ entries })).rejects.toThrow(/docs\/latest changed after/);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses, and never offers the live fallback for, a root that became a link",
  async () => {
    const { scan, entries } = await scanned();
    await FSP.rename(source, `${source}-real`);
    await FSP.symlink(`${source}-real`, source);
    const refused = await run({
      entries,
      scannedRoots: new Map([[source, scan.rootIdentity!]]),
    }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(Error);
    // A refused filesystem lets a moving copy fall back to live reads; a changed root must not.
    expect(refused).not.toBeInstanceOf(CaptureFilesystemRefused);
    expect((refused as Error).message).toMatch(/changed after it was measured/);
  },
);

it.skipIf(process.platform === "win32")(
  "treats a root removed while it is pinned as changed, not as an unsupported filesystem",
  async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const gone = Path.join(base, `gone-${platform}`);
      await FSP.mkdir(gone);
      const refused = await pinSourceRoot(gone, platform, undefined, {
        afterStat: () => FSP.rm(gone, { recursive: true }),
      }).catch((cause: unknown) => cause);
      expect(refused).not.toBeInstanceOf(CaptureFilesystemRefused);
      expect((refused as Error).message).toMatch(/changed after it was measured/);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses, without the live fallback, when the anchored lookup fails for another reason",
  async () => {
    const lookUp = () => Promise.reject(Object.assign(new Error("I/O error"), { code: "EIO" }));
    for (const platform of ["darwin", "linux"] as const) {
      const refused = await pinSourceRoot(source, platform, undefined, { lookUp }).catch(
        (cause: unknown) => cause,
      );
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(CaptureFilesystemRefused);
    }
    // A lookup that does not exist while the root is there is an unsupported filesystem.
    const missing = () => Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
    await expect(
      pinSourceRoot(source, "darwin", undefined, { lookUp: missing }),
    ).rejects.toBeInstanceOf(CaptureFilesystemRefused);
  },
);

it("does not trust the stamp of a file read within a tick, however long the pack lane took", async () => {
  const { entries } = await scanned();
  const stamp = Date.now();
  const at = new Date(stamp - 1_000);
  await FSP.utimes(Path.join(source, "work.txt"), at, at);
  const pack = Path.join(root, "files.pack");
  // The clock reads the read's own moment while nothing is packed; once the pack lane
  // has written, it reads ten seconds later, as after a long wait on the writer.
  const now = () =>
    NodeFS.existsSync(pack) && NodeFS.statSync(pack).size > 0 ? stamp + 10_000 : stamp;
  const result = await run({ entries, now });
  expect(result.stats["work.txt"]).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "refuses a FIFO that replaced a scanned file without blocking",
  async () => {
    const { entries } = await scanned();
    const fifo = Path.join(source, "work.txt");
    await FSP.unlink(fifo);
    ChildProcess.execFileSync("mkfifo", [fifo]);
    let writer: FSP.FileHandle | null = null;
    const unblock = setTimeout(() => {
      // Before the fix the capture blocks in open(); a writer lets the test end.
      void FSP.open(fifo, "w").then(
        (handle) => (writer = handle),
        () => undefined,
      );
    }, 3_000);
    try {
      const started = Date.now();
      await expect(run({ entries })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      clearTimeout(unblock);
      await (writer as FSP.FileHandle | null)?.close();
    }
  },
  10_000,
);
