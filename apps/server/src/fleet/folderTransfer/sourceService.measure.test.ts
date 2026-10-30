// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable state folders and bounded polling.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { sourceStatus } from "../FolderCopyHandoff.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { git, write } from "./folderFixture.testkit.ts";
import * as Manifest from "./manifest.ts";
import { PORTABLE_GIT_NOTICE } from "./portableGit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { liveMovingCopies } from "./sourceTestServer.testkit.ts";

vi.mock("./manifest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest.ts")>();
  return { ...actual, scanFolder: vi.fn(actual.scanFolder) };
});

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

const folders: Array<string> = [];
afterEach(() => {
  vi.mocked(Manifest.scanFolder).mockReset();
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const operationId = "00000000-0000-4000-8000-000000000993";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function project(withRepository = true) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-copy-measure-")),
  );
  folders.push(base);
  const folder = NodePath.join(base, "project");
  write(NodePath.join(folder, "notes.txt"), "notes\n");
  write(NodePath.join(folder, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  if (withRepository) {
    const repo = NodePath.join(folder, "api");
    write(NodePath.join(repo, "readme.txt"), "readme\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
  }
  return { folder, state: NodePath.join(base, "state") };
}

const offer = (sources: SourceTransfers, folder: string) =>
  sources.offer({
    operationId,
    projectId: "source-project",
    folder,
    mode: "copy-and-move",
    destinationEnvironmentId: "destination",
  });

const snapshotDirectory = (state: string) =>
  NodePath.join(state, "folder-sources", operationId, "portable-git");

const persisted = (state: string) =>
  JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(state, "folder-sources", operationId, "operation.json"),
      "utf8",
    ),
  ) as { state: string; error: string | null };

/**
 * The next scan reports some progress, then waits (honouring its stop check)
 * until released. Resolves `entered` once it is waiting.
 */
async function holdNextScan() {
  const actual = await vi.importActual<typeof import("./manifest.ts")>("./manifest.ts");
  let release = false;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(Manifest.scanFolder).mockImplementationOnce(async (root, options) => {
    options?.onProgress?.({ files: 7, bytes: 900 });
    entered();
    for (;;) {
      if (options?.shouldStop?.()) throw new actual.FolderScanError("stopped");
      if (release) return actual.scanFolder(root, options);
      await sleep(5);
    }
  });
  return {
    waiting,
    release: () => {
      release = true;
    },
  };
}

describe("measuring a folder", () => {
  it("lists the folder without preparing a Git snapshot, and says when Git is captured", async () => {
    const { folder, state } = project();
    const sources = new SourceTransfers(state);
    const offered = await offer(sources, folder);
    const loaded = await sources.authorize(operationId, offered.token);
    await loaded.building;
    const record = (await sources.read(operationId))!;
    expect(record.state).toBe("scanned");
    expect(record.progress).toBeNull();
    expect(NodeFS.existsSync(snapshotDirectory(state))).toBe(false);
    expect(record.summary?.warnings).toContain(PORTABLE_GIT_NOTICE);
    expect(record.summary?.skipped).toEqual({ rebuildableFolders: 1, worktrees: [] });
    expect(record.summary?.totals.rebuildable).toEqual({ files: 0, bytes: 0 });
    expect(sourceStatus(record).summary?.skipped).toEqual({
      rebuildableFolders: 1,
      worktrees: [],
    });
    expect(sourceStatus(record).progress).toBeUndefined();

    // Copying starts the snapshot.
    await sources.requestManifest(loaded, DEFAULT_SELECTION);
    await loaded.building;
    expect(loaded.record.state).toBe("ready");
    expect(NodeFS.existsSync(snapshotDirectory(state))).toBe(true);
  });

  it.each(["cancel", "release"] as const)(
    "shows progress while measuring and stops promptly on %s",
    async (action) => {
      const { folder, state } = project(false);
      const held = await holdNextScan();
      const released: Array<string> = [];
      const sources = new SourceTransfers(state, {
        release: async (record) => {
          released.push(record.operationId);
        },
      });
      const offered = await offer(sources, folder);
      const loaded = await sources.authorize(operationId, offered.token);
      await held.waiting;
      const measuring = (await sources.read(operationId))!;
      expect(measuring.state).toBe("scanning");
      expect(measuring.progress).toEqual({ files: 7, bytes: 900, step: "listing" });
      expect(sourceStatus(measuring).progress).toEqual({ files: 7, bytes: 900, step: "listing" });

      // The held scan never finishes by itself: only its stop check ends it.
      const stopping =
        action === "cancel"
          ? sources.cancel(operationId, "stopped by the person")
          : sources.release(loaded, "destination stopped");
      const outcome = await Promise.race([stopping, sleep(5_000).then(() => "hung" as const)]);
      expect(outcome).not.toBe("hung");
      const expected = action === "cancel" ? "cancelled" : "released";
      expect((outcome as { state: string }).state).toBe(expected);
      expect(loaded.building).toBeNull();
      expect(released).toEqual([operationId]);
      expect(persisted(state)).toMatchObject({ state: expected, error: null });
      expect((await new SourceTransfers(state).read(operationId))?.state).toBe(expected);
      await expect(sources.requestManifest(loaded, DEFAULT_SELECTION)).rejects.toMatchObject({
        code: expected,
      });
    },
  );

  it("measures again when a restart left a record scanning, but never after close", async () => {
    const { folder, state } = project();
    await holdNextScan();
    const first = new SourceTransfers(state);
    const offered = await offer(first, folder);
    const loaded = await first.authorize(operationId, offered.token);
    await first.close();
    await loaded.building; // Stopped by close without recording a failure.
    expect(persisted(state).state).toBe("scanning");

    const closed = new SourceTransfers(state);
    await closed.close();
    const calls = vi.mocked(Manifest.scanFolder).mock.calls.length;
    expect((await closed.read(operationId))?.state).toBe("scanning");
    expect(vi.mocked(Manifest.scanFolder).mock.calls.length).toBe(calls);

    const restarted = new SourceTransfers(state);
    expect((await restarted.read(operationId))?.state).toBe("scanning");
    const resumed = await restarted.authorize(operationId, offered.token);
    expect(resumed.building).not.toBeNull();
    await resumed.building;
    const record = (await restarted.read(operationId))!;
    expect(record.state).toBe("scanned");
    expect(record.summary?.repositories.map((repo) => repo.path)).toEqual(["api"]);
    expect(persisted(state).state).toBe("scanned");
    expect(NodeFS.existsSync(snapshotDirectory(state))).toBe(false);
  });

  it("builds again when a restart left a record building, but never after close", async () => {
    const { folder, state } = project();
    const first = new SourceTransfers(state);
    const offered = await offer(first, folder);
    const loaded = await first.authorize(operationId, offered.token);
    await loaded.building;
    // A second service has no measured listing in memory, so its build lists the
    // folder again; that listing holds until stopped.
    const held = await holdNextScan();
    const later = new SourceTransfers(state);
    const relisted = await later.authorize(operationId, offered.token);
    await relisted.building;
    await later.requestManifest(relisted, DEFAULT_SELECTION);
    await held.waiting;
    expect(relisted.record.progress).toMatchObject({ step: "listing" });
    await later.close();
    await relisted.building; // Stopped by close without recording a failure.
    expect(persisted(state).state).toBe("building");

    const closed = new SourceTransfers(state);
    await closed.close();
    const calls = vi.mocked(Manifest.scanFolder).mock.calls.length;
    expect((await closed.read(operationId))?.state).toBe("building");
    expect(vi.mocked(Manifest.scanFolder).mock.calls.length).toBe(calls);

    const restarted = new SourceTransfers(state);
    const resumed = (await restarted.authorize(operationId, offered.token))!;
    expect(resumed.building).not.toBeNull();
    await resumed.building;
    const record = (await restarted.read(operationId))!;
    expect(record.state).toBe("ready");
    expect(persisted(state).state).toBe("ready");
    expect(NodeFS.existsSync(snapshotDirectory(state))).toBe(true);
    // The last step reported is hashing, with the totals it worked toward.
    expect(record.progress).toMatchObject({ step: "hashing" });
    expect(record.progress?.totalFiles).toBe(record.progress?.files);
    expect(sourceStatus(record).progress).toMatchObject({
      step: "hashing",
      totalFiles: record.progress?.files,
      totalBytes: record.progress?.bytes,
    });
  });

  it("names skipped worktrees with uncommitted changes first, ahead of 60 other warnings", async () => {
    const { folder, state } = project();
    const api = NodePath.join(folder, "api");
    git(api, "worktree", "add", "-qb", "dirty", NodePath.join(folder, "wt-dirty"));
    git(api, "worktree", "add", "-qb", "clean", NodePath.join(folder, "wt-clean"));
    write(NodePath.join(folder, "wt-dirty", "draft.txt"), "uncommitted\n");
    const sources = new SourceTransfers(state);
    const offered = await sources.offer({
      operationId,
      projectId: "source-project",
      folder,
      mode: "copy-and-move",
      destinationEnvironmentId: "destination",
      warnings: Array.from({ length: 60 }, (_, index) => `caveat ${index}`),
    });
    await (
      await sources.authorize(operationId, offered.token)
    ).building;
    const record = (await sources.read(operationId))!;
    expect(record.summary?.skipped).toEqual({
      rebuildableFolders: 1,
      worktrees: ["wt-clean", "wt-dirty"],
      dirtyWorktrees: ["wt-dirty"],
      uncheckedWorktrees: [],
      strandedWorktrees: [],
      worktreeCount: 2,
      dirtyCount: 1,
    });
    expect(record.summary?.warnings).toHaveLength(50);
    expect(record.summary?.warnings[0]).toContain(
      "2 linked worktree(s) inside this folder are not copied: wt-clean, wt-dirty.",
    );
    expect(record.summary?.warnings[0]).toContain(
      "1 of them have uncommitted changes that stay on this machine: wt-dirty.",
    );
    expect(sourceStatus(record).summary?.skipped).toMatchObject({
      dirtyWorktrees: ["wt-dirty"],
      uncheckedWorktrees: [],
      strandedWorktrees: [],
      worktreeCount: 2,
      dirtyCount: 1,
    });
  });
});

it("waits for a published ready manifest to finish persisting before checking freshness", async () => {
  const { folder, state } = project(false);
  const actual = await vi.importActual<typeof import("./manifest.ts")>("./manifest.ts");
  vi.mocked(Manifest.scanFolder).mockImplementation(actual.scanFolder);
  // An uncaptured move publishes its ready manifest before the record is durable.
  const sources = new SourceTransfers(state, { verifyCaptureFilesystem: liveMovingCopies });
  const offered = await offer(sources, folder);
  const loaded = await sources.authorize(operationId, offered.token);
  await loaded.building;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const open = NodeFSP.open;
  const handles: Array<{ mockRestore(): void }> = [];
  const spy = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const path = String(args[0]);
    if (path.startsWith(state) && path.endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      handles.push(
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          const record = JSON.parse(await NodeFSP.readFile(path, "utf8")) as { state?: string };
          if (record.state === "ready") {
            entered();
            await held;
          }
          return sync();
        }),
      );
    }
    return handle;
  });
  let checking: Promise<unknown> | undefined;
  try {
    await sources.requestManifest(loaded, DEFAULT_SELECTION);
    await waiting;
    expect(loaded.record.state).toBe("ready");
    expect((await sources.manifest(loaded)).ready).toBe(true);
    let settled = false;
    checking = sources.checkScan(operationId).then(
      (record) => {
        settled = true;
        return record;
      },
      (cause: unknown) => {
        settled = true;
        throw cause;
      },
    );
    // Observe rejection too so the failing baseline has no unhandled promise.
    const outcome = checking.then(
      (record) => ({ record }),
      (error: unknown) => ({ error }),
    );
    await sleep(10);
    expect(settled).toBe(false);
    release();
    expect(await outcome).toMatchObject({ record: { freshness: { current: true } } });
  } finally {
    release();
    await loaded.building;
    await checking?.catch(() => undefined);
    handles.forEach((handle) => handle.mockRestore());
    spy.mockRestore();
    await sources.close();
  }
});
