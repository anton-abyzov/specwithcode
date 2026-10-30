// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - isolated capture durability and cancellation tests.
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Zlib from "node:zlib";
import { DEFAULT_SELECTION } from "./classify.ts";
import * as Durable from "./durable.ts";
import { makeUmbrella } from "./folderFixture.testkit.ts";
import * as Capture from "./sourceSnapshot.ts";
import { SourceTransfers } from "./sourceService.ts";
vi.mock("./durable.ts", async (original) => {
  const actual = await original<typeof Durable>();
  return { ...actual, writeJson: vi.fn(actual.writeJson) };
});
vi.mock("./sourceSnapshot.ts", async (original) => {
  const actual = await original<typeof Capture>();
  return { ...actual, captureSourceFiles: vi.fn(actual.captureSourceFiles) };
});
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof FSP>()) }));
let base: string;
let folder: string;
let state: string;
let source: SourceTransfers;
let id: string;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-capture-state-")));
  folder = Path.join(base, "source");
  state = Path.join(base, "state");
  await FSP.mkdir(folder);
  await FSP.writeFile(Path.join(folder, "a.txt"), "first source");
  await FSP.writeFile(Path.join(folder, "b.txt"), "second source");
  // File stamps older than a tick before capture, as on a machine where files settled.
  source = new SourceTransfers(state, { stampClock: () => Date.now() + 10_000 });
  id = Crypto.randomUUID();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(Durable.writeJson).mockReset();
  vi.mocked(Capture.captureSourceFiles).mockReset();
  await source.close();
  await FSP.rm(base, { recursive: true, force: true });
});
async function offered() {
  const offer = await source.offer({
    operationId: id,
    folder,
    projectId: "fixture",
    mode: "copy-only",
    destinationEnvironmentId: "destination",
  });
  const loaded = await source.authorize(id, offer.token);
  await loaded.building;
  return loaded;
}
it("does not expose captured manifest or approve until the ready capability is durable", async () => {
  const loaded = await offered();
  const actual = await vi.importActual<typeof Durable>("./durable.ts");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(Durable.writeJson).mockImplementation(async (file, value) => {
    if ((value as { state?: string }).state === "ready") {
      entered();
      await held;
    }
    return actual.writeJson(file, value);
  });
  let approving: Promise<unknown> | undefined;
  let reading: Promise<unknown> | undefined;
  try {
    await source.requestManifest(loaded, DEFAULT_SELECTION);
    await waiting;
    expect(loaded.record.state).toBe("ready");
    let approved = false;
    let read = false;
    approving = source.validateReviewed(id).then((value) => {
      approved = true;
      return value;
    });
    reading = source.manifest(loaded).then((value) => {
      read = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(approved).toBe(false);
    expect(read).toBe(false);
    release();
    await expect(approving).resolves.toEqual({ current: true, captured: true });
    await expect(reading).resolves.toMatchObject({ ready: true });
    const persisted = JSON.parse(
      await FSP.readFile(Path.join(state, "folder-sources", id, "operation.json"), "utf8"),
    );
    expect(persisted.capturedSource).toEqual(loaded.record.capturedSource);
  } finally {
    release();
    await loaded.building;
    await Promise.allSettled([approving, reading]);
  }
});
it("cleans partial capture after cancellation and never changes source files", async () => {
  const loaded = await offered();
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  let cancellation: ReturnType<SourceTransfers["cancel"]> | undefined;
  vi.mocked(Capture.captureSourceFiles).mockImplementation((input) =>
    actual.captureSourceFiles({
      ...input,
      progress(value) {
        input.progress?.(value);
        if (!cancellation) cancellation = source.cancel(id, "cancel during actual pack capture");
      },
    }),
  );
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  await cancellation;
  expect((await source.read(id))?.state).toBe("cancelled");
  await expect(
    FSP.stat(Path.join(state, "folder-sources", id, "captured-files")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await FSP.readFile(Path.join(folder, "a.txt"), "utf8")).toBe("first source");
  expect(await FSP.readFile(Path.join(folder, "b.txt"), "utf8")).toBe("second source");
});
it("fails without publishing a capability when source disk cannot hold the capture", async () => {
  const loaded = await offered();
  const stats = await FSP.statfs(base);
  vi.spyOn(FSP, "statfs").mockResolvedValue({ ...stats, bavail: 0 });
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  const record = await source.read(id);
  expect(record).toMatchObject({ state: "failed" });
  expect(record?.capturedSource).toBeUndefined();
  await expect(
    FSP.stat(Path.join(state, "folder-sources", id, "captured-files")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await FSP.readFile(Path.join(folder, "a.txt"), "utf8")).toBe("first source");
});

it("publishes captured byte totals when a file grows after listing", async () => {
  const loaded = await offered();
  const originalBytes = loaded.record.summary!.totals.untracked.bytes;
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  vi.mocked(Capture.captureSourceFiles).mockImplementation(async (input) => {
    await FSP.appendFile(Path.join(folder, "a.txt"), " captured growth");
    return actual.captureSourceFiles(input);
  });
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  expect(loaded.record.state).toBe("ready");
  const manifest = await source.manifest(loaded);
  if (!manifest.ready) throw new Error("capture not ready");
  const [header, ...entries] = Zlib.gunzipSync(manifest.bytes)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(header.totals.untracked.bytes).toBe(originalBytes + Buffer.byteLength(" captured growth"));
  expect(header.totals.untracked.bytes).toBe(
    entries
      .filter((entry) => entry.class === "untracked")
      .reduce((sum, entry) => sum + entry.size, 0),
  );
  expect(loaded.record.summary!.totals.untracked.bytes).toBe(header.totals.untracked.bytes);
});

it("cleans captured bytes despite a busy Git directory and retries pending cleanup on read", async () => {
  const loaded = await offered();
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  vi.mocked(Capture.captureSourceFiles).mockImplementation(actual.captureSourceFiles);
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  const operationRoot = Path.join(state, "folder-sources", id);
  const gitRoot = Path.join(operationRoot, "portable-git");
  await FSP.mkdir(gitRoot, { recursive: true });
  await FSP.writeFile(Path.join(gitRoot, ".DS_Store"), "synthetic Finder metadata");
  const originalRm = FSP.rm;
  const remove = vi.spyOn(FSP, "rm").mockImplementation(async (path, options) => {
    if (path === gitRoot) throw Object.assign(new Error("busy directory"), { code: "ENOTEMPTY" });
    return originalRm(path, options);
  });
  await source.cancel(id, "cleanup regression");
  expect(loaded.record.snapshotCleanupPending).toBe(true);
  expect(loaded.record.snapshotCleanupCodes).toEqual(["ENOTEMPTY"]);
  expect(remove).toHaveBeenCalledWith(
    gitRoot,
    expect.objectContaining({ maxRetries: 3, retryDelay: 100 }),
  );
  await expect(FSP.stat(Path.join(operationRoot, "captured-files"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await FSP.readFile(Path.join(folder, "a.txt"), "utf8")).toBe("first source");
  remove.mockRestore();
  expect((await source.read(id))?.snapshotCleanupPending).toBe(false);
  await expect(FSP.stat(gitRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])(
  "handles ordinary sibling creation during capture (keeps changing=%s)",
  async (keepsChanging) => {
    const loaded = await offered();
    const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
    vi.mocked(Capture.captureSourceFiles).mockImplementation((input) =>
      actual.captureSourceFiles({ ...input, retryWait: async () => {} }),
    );
    const open = FSP.open;
    let creations = 0;
    vi.spyOn(FSP, "open").mockImplementation(async (path, flags, mode) => {
      if (path === Path.join(folder, "a.txt") && (keepsChanging || creations === 0)) {
        creations++;
        await FSP.writeFile(Path.join(folder, `new-sibling-${creations}.txt`), "ordinary new work");
      }
      return open(path, flags, mode);
    });
    await source.requestManifest(loaded, DEFAULT_SELECTION);
    await loaded.building;
    if (keepsChanging) {
      expect(creations).toBe(actual.STABLE_ATTEMPTS);
      expect(loaded.record.state).toBe("failed");
      expect(loaded.record.capturedSource).toBeUndefined();
      await expect(
        FSP.stat(Path.join(state, "folder-sources", id, "captured-files")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(creations).toBe(1);
      expect(loaded.record.state).toBe("ready");
      await expect(source.validateReviewed(id)).resolves.toEqual({ current: true, captured: true });
    }
    expect(await FSP.readFile(Path.join(folder, "a.txt"), "utf8")).toBe("first source");
  },
);

it("captures a moving copy like a plain one, so a growing ledger does not stale its approval", async () => {
  const umbrella = makeUmbrella(base);
  const ledger = Path.join(umbrella.root, ".specweave/increments/0001-x/ledger.jsonl");
  await FSP.writeFile(ledger, '{"t":"T-01","e":"claim"}\n');
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  vi.mocked(Capture.captureSourceFiles).mockImplementation(actual.captureSourceFiles);
  const offer = await source.offer({
    operationId: id,
    folder: umbrella.root,
    projectId: "fixture",
    mode: "copy-and-move",
    destinationEnvironmentId: "destination",
  });
  const loaded = await source.authorize(id, offer.token);
  await loaded.building;
  await source.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  expect(loaded.record).toMatchObject({ state: "ready", error: null });
  expect(loaded.record.capturedSource?.packHash).toMatch(/^[a-f0-9]{64}$/);
  expect(vi.mocked(Capture.captureSourceFiles).mock.calls[0]?.[0].onChanging).toBe("keep-last");
  const basis = JSON.parse(
    await FSP.readFile(Path.join(state, "folder-sources", id, "drift-basis.json"), "utf8"),
  );
  expect(basis.stats[".specweave/increments/0001-x/ledger.jsonl"]).toMatchObject({
    size: String(Buffer.byteLength('{"t":"T-01","e":"claim"}\n')),
  });
  expect(Object.keys(basis.stats).some((path) => path.includes(".git/"))).toBe(false);
  expect(basis.changing).toEqual([]);
  expect(Object.keys(basis.indexes)).toEqual(expect.arrayContaining(["."]));
  // The manifest the destination reads is unchanged: the basis stays beside it.
  const manifest = await source.manifest(loaded);
  if (!manifest.ready) throw new Error("capture not ready");
  expect(manifest.bytes.includes(Buffer.from("ctimeNs"))).toBe(false);
  await FSP.appendFile(ledger, '{"t":"T-01","e":"done"}\n');
  await expect(source.validateReviewed(id)).resolves.toEqual({ current: true, captured: true });
});

it("falls back to live checks for a moving copy the source has no room to capture", async () => {
  const actual = await vi.importActual<typeof Capture>("./sourceSnapshot.ts");
  vi.mocked(Capture.captureSourceFiles).mockImplementation(async () => {
    throw new actual.CaptureSpaceRefused("Capturing this copy needs 10 bytes free on the source.");
  });
  for (const mode of ["copy-and-move", "copy-only"] as const) {
    const operationId = Crypto.randomUUID();
    const offer = await source.offer({
      operationId,
      folder,
      projectId: "fixture",
      mode,
      destinationEnvironmentId: "destination",
    });
    const loaded = await source.authorize(operationId, offer.token);
    await loaded.building;
    await source.requestManifest(loaded, DEFAULT_SELECTION);
    await loaded.building;
    if (mode === "copy-and-move") {
      // As before captured moves: the live tree is hashed and served, nothing is refused.
      expect(loaded.record).toMatchObject({ state: "ready", error: null });
      expect(loaded.record.capturedSource).toBeUndefined();
    } else {
      expect(loaded.record.state).toBe("failed");
      expect(loaded.record.error).toMatch(/needs 10 bytes free/);
    }
  }
});
