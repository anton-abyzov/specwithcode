// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - isolated copy snapshots and bounded background waits.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { ProjectId } from "@specweave-studio/contracts";
import { ACTIVE_COPY_WARNING, makeFolderCopyManifest } from "../folderCopyPreparation.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import * as Durable from "./durable.ts";
import { runGit } from "./git.ts";
import { readManifestFile } from "./manifest.ts";
import { handleSourceRequest } from "./sourceRoutes.ts";
import { SourceTransfers } from "./sourceService.ts";
import { CHUNK_CHANGED, CHUNK_OK } from "./wire.ts";
import { TRANSFER_GRANT_IDLE_MS } from "./transferGrant.ts";

// Passes through; the close test holds one record write open to make its race deterministic.
vi.mock("./durable.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./durable.ts")>();
  return { ...actual, writeJson: vi.fn(actual.writeJson) };
});

const folders: Array<string> = [];
afterEach(() => {
  vi.mocked(Durable.writeJson).mockReset();
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const projectId = ProjectId.make("source-project");
const operationId = "00000000-0000-4000-8000-000000000990";

async function snapshot(
  withRepository = false,
  commit = true,
  hooks: ConstructorParameters<typeof SourceTransfers>[1] = {},
  files: Readonly<Record<string, string>> = {},
) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-copy-snapshot-")),
  );
  folders.push(base);
  const folder = NodePath.join(base, "project");
  const state = NodePath.join(base, "state");
  NodeFS.mkdirSync(folder);
  NodeFS.writeFileSync(NodePath.join(folder, "unfinished.txt"), "unfinished work\n");
  NodeFS.writeFileSync(NodePath.join(folder, ".env"), "EXAMPLE_ONLY=one\n");
  for (const [name, text] of Object.entries(files))
    NodeFS.writeFileSync(NodePath.join(folder, name), text);
  const repo = NodePath.join(folder, "custom", "services", "api");
  if (withRepository) {
    NodeFS.mkdirSync(repo, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, "readme.txt"), "original\n");
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await runGit(repo, ["add", "readme.txt"]);
    await runGit(repo, [
      "-c",
      "user.name=Copy fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
  }
  const sources = new SourceTransfers(state, hooks);
  const offered = await sources.offer({
    operationId,
    projectId,
    folder,
    mode: "copy-and-move",
    destinationEnvironmentId: "destination",
    warnings: [ACTIVE_COPY_WARNING],
  });
  const loaded = await sources.authorize(operationId, offered.token);
  await sources.requestManifest(loaded, DEFAULT_SELECTION);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await sources.read(operationId);
    if (record?.state === "failed") throw new Error(record.error ?? "scan failed");
    if (record?.state === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await loaded.building; // The ready record is visible before its final durable write settles.
  if (commit) await sources.commit(loaded);
  return { sources, folder, state, repo, loaded, token: offered.token };
}

describe("a completed copy before coordinator context transfer", () => {
  it.live("retains the activity warning in the status, manifest and restarted source", () =>
    Effect.gen(function* () {
      const { sources, state, folder } = yield* Effect.promise(() => snapshot());
      expect((yield* Effect.promise(() => sources.read(operationId)))?.summary?.warnings).toContain(
        ACTIVE_COPY_WARNING,
      );
      const manifest = yield* Effect.promise(() =>
        readManifestFile(NodePath.join(state, "folder-sources", operationId, "manifest.ndjson.gz")),
      );
      expect(manifest.header.warnings).toContain(ACTIVE_COPY_WARNING);
      const restarted = new SourceTransfers(state);
      expect(
        (yield* Effect.promise(() => restarted.read(operationId)))?.summary?.warnings,
      ).toContain(ACTIVE_COPY_WARNING);
      yield* Effect.promise(() => restarted.assertCurrentSnapshot(operationId));
      expect(
        yield* makeFolderCopyManifest(restarted)(operationId, projectId, "destination", folder),
      ).toMatchObject({ operationId });
    }),
  );

  it.live.each(["edit", "new-file", "delete", "mode", "symlink"])(
    "refuses newer context after a %s and keeps the copied operation",
    (change) =>
      Effect.gen(function* () {
        const { sources, folder } = yield* Effect.promise(() => snapshot());
        const file = NodePath.join(folder, "unfinished.txt");
        if (change === "edit") NodeFS.writeFileSync(file, "later edit\n");
        if (change === "new-file") NodeFS.writeFileSync(NodePath.join(folder, "new.txt"), "new\n");
        if (change === "delete") NodeFS.unlinkSync(file);
        // Windows has no execute bits; chmod there only toggles read-only, a mode it still records.
        if (change === "mode") NodeFS.chmodSync(file, process.platform === "win32" ? 0o444 : 0o700);
        if (change === "symlink") {
          NodeFS.unlinkSync(file);
          NodeFS.symlinkSync("new.txt", file);
        }
        const result = yield* makeFolderCopyManifest(sources)(
          operationId,
          projectId,
          "destination",
          folder,
        ).pipe(Effect.flip);
        expect(result.code).toBe("source_changed");
        expect((yield* Effect.promise(() => sources.read(operationId)))?.state).toBe("committed");
      }),
  );

  it("persists abandoned context without changing the copied files", async () => {
    const { sources, folder, state } = await snapshot();
    await sources.abandonContextTransfer(operationId, "Start fresh");
    expect(NodeFS.readFileSync(NodePath.join(folder, "unfinished.txt"), "utf8")).toBe(
      "unfinished work\n",
    );
    const restarted = new SourceTransfers(state);
    await expect(restarted.assertContextAvailable(operationId)).rejects.toMatchObject({
      code: "context_closed",
    });
    expect((await restarted.read(operationId))?.releaseReason).toBe("Start fresh");
  });

  it("ignores later edits in deliberately excluded secret files", async () => {
    const { sources, folder } = await snapshot();
    NodeFS.writeFileSync(NodePath.join(folder, ".env"), "EXAMPLE_ONLY=two\n");
    await expect(sources.assertCurrentSnapshot(operationId)).resolves.toBeUndefined();
  });

  it("validates unchanged custom repository layout and rejects an un-copied branch", async () => {
    const { sources, repo } = await snapshot(true);
    await expect(sources.assertCurrentSnapshot(operationId)).resolves.toBeUndefined();
    await runGit(repo, ["branch", "later-branch"]);
    await expect(sources.assertCurrentSnapshot(operationId)).rejects.toMatchObject({
      code: "source_changed",
    });
  });

  it("ignores Git runtime locks and fsmonitor sockets in the context snapshot fence", async () => {
    const { sources, repo } = await snapshot(true);
    NodeFS.writeFileSync(NodePath.join(repo, ".git/index.lock"), "transient lock");
    NodeFS.writeFileSync(NodePath.join(repo, ".git/fsmonitor--daemon.ipc"), "transient endpoint");
    await expect(sources.assertCurrentSnapshot(operationId)).resolves.toBeUndefined();
  });

  it("ignores newly created excluded caches", async () => {
    const { sources, folder } = await snapshot();
    NodeFS.mkdirSync(NodePath.join(folder, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(folder, "node_modules", "cache.txt"), "cache\n");
    await expect(sources.assertCurrentSnapshot(operationId)).resolves.toBeUndefined();
  });

  it("detects a repository added in an arbitrary nested layout", async () => {
    const { sources, folder } = await snapshot();
    const repo = NodePath.join(folder, "custom", "services", "api");
    NodeFS.mkdirSync(repo, { recursive: true });
    await runGit(repo, ["init", "-q"]);
    await expect(sources.assertCurrentSnapshot(operationId)).rejects.toMatchObject({
      code: "source_changed",
    });
  });
});

describe("terminal source snapshot cleanup", () => {
  it("retains the manifest for context checks but removes generated Git data after commit and restart", async () => {
    const { sources, state, folder, loaded } = await snapshot(true, false);
    const directory = NodePath.join(state, "folder-sources", operationId);
    expect(NodeFS.existsSync(NodePath.join(directory, "portable-git"))).toBe(true);
    await sources.commit(loaded);
    expect(NodeFS.existsSync(NodePath.join(directory, "portable-git"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(directory, "manifest.ndjson.gz"))).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(folder, "unfinished.txt"), "utf8")).toBe(
      "unfinished work\n",
    );
    await sources.commit(loaded);
    await sources.assertCurrentSnapshot(operationId);
    await new SourceTransfers(state).assertCurrentSnapshot(operationId);
  });

  it("finishes an authorized Git chunk read before terminal cleanup, including cold concurrent loads", async () => {
    const { state, token } = await snapshot(true, false);
    const restarted = new SourceTransfers(state);
    const [first, second] = await Promise.all([
      restarted.authorize(operationId, token),
      restarted.authorize(operationId, token),
    ]);
    expect(first).toBe(second);
    const manifest = await readManifestFile(
      NodePath.join(state, "folder-sources", operationId, "manifest.ndjson.gz"),
    );
    const entry = manifest.entries.find((item) => item.portableGit && item.chunks?.length);
    expect(entry).toBeDefined();
    const reading = restarted.chunks(first, entry!.chunks!);
    const committing = restarted.commit(second);
    expect((await reading).every((frame) => frame.status === 0)).toBe(true);
    expect((await committing).state).toBe("committed");
    expect(
      NodeFS.existsSync(NodePath.join(state, "folder-sources", operationId, "portable-git")),
    ).toBe(false);
    await expect(restarted.chunks(first, entry!.chunks!)).rejects.toMatchObject({
      code: "committed",
    });
  });

  it.each(["release", "cancel"] as const)(
    "%s waits for a new manifest build and cannot be overwritten by it",
    async (action) => {
      const { sources, state, folder } = await snapshot(true);
      const nextId = "00000000-0000-4000-8000-000000000991";
      const offered = await sources.offer({
        operationId: nextId,
        projectId,
        folder,
        mode: "copy-only",
        destinationEnvironmentId: "destination",
      });
      const loaded = await sources.authorize(nextId, offered.token);
      await sources.requestManifest(loaded, DEFAULT_SELECTION);
      expect(loaded.building).not.toBeNull();
      const record =
        action === "release"
          ? await sources.release(loaded, "test")
          : await sources.cancel(nextId, "test");
      expect(record.state).toBe(action === "release" ? "released" : "cancelled");
      expect(loaded.building).toBeNull();
      expect((await new SourceTransfers(state).read(nextId))?.state).toBe(record.state);
      expect(
        NodeFS.existsSync(NodePath.join(state, "folder-sources", nextId, "portable-git")),
      ).toBe(false);
      await expect(sources.requestManifest(loaded, DEFAULT_SELECTION)).rejects.toMatchObject({
        code: record.state,
      });
    },
  );

  it("answers a repeated commit, hello and release with its committed grant and refuses every other request", async () => {
    const { sources, token } = await snapshot(false);
    const send = (method: string, action: string, bearer = token) =>
      handleSourceRequest(sources, "env-source", {
        method,
        path: `/${operationId}/${action}`,
        authorization: `Bearer ${bearer}`,
        body: async () => new TextEncoder().encode("{}"),
      });
    const parsed = (response: { body: Uint8Array }) =>
      JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    // The first commit's reply was lost; the destination sends it again with the same grant.
    const again = await send("POST", "commit");
    expect(again.status).toBe(200);
    expect(parsed(again)).toEqual({ state: "committed" });
    // A destination about to Undo asks first, and learns the copy is committed.
    const hello = await send("GET", "hello");
    expect(hello.status).toBe(200);
    expect(parsed(hello)).toMatchObject({ operationId, state: "committed" });
    const release = await send("POST", "release");
    expect(release.status).toBe(409);
    expect(parsed(release)).toEqual({ error: "committed" });
    for (const [method, action] of [
      ["GET", "manifest"],
      ["POST", "chunks"],
      ["POST", "stat"],
      ["GET", "secrets"],
    ] as const)
      expect((await send(method, action)).status).toBe(401);
    expect((await send("GET", "hello", `${token}x`)).status).toBe(401);
    expect((await send("POST", "release", `${token}x`)).status).toBe(401);
    expect((await send("POST", "commit", `${token}x`)).status).toBe(401);
    // The source stays committed: it cannot be cancelled after the destination finished.
    await expect(sources.cancel(operationId, "late")).rejects.toMatchObject({ code: "committed" });
  });

  it("serves a chunk from an unchanged duplicate when the file it was indexed from changed", async () => {
    const { sources, state, folder, loaded } = await snapshot(
      false,
      false,
      {},
      {
        "a-first.txt": "same bytes\n",
        "b-copy.txt": "same bytes\n",
      },
    );
    const manifest = await readManifestFile(
      NodePath.join(state, "folder-sources", operationId, "manifest.ndjson.gz"),
    );
    const hash = manifest.entries.find((entry) => entry.path === "b-copy.txt")!.chunks![0]!;
    NodeFS.writeFileSync(NodePath.join(folder, "a-first.txt"), "changed after hashing\n");
    const [frame] = await sources.chunks(loaded, [hash]);
    expect(frame).toMatchObject({ sha256: hash, status: CHUNK_OK });
    expect(frame!.data.toString()).toBe("same bytes\n");
    // With every copy changed, the chunk is reported changed.
    NodeFS.writeFileSync(NodePath.join(folder, "b-copy.txt"), "also changed\n");
    expect((await sources.chunks(loaded, [hash]))[0]?.status).toBe(CHUNK_CHANGED);
  });

  it("refuses a commit with a grant revoked by a release", async () => {
    const { sources, loaded, token } = await snapshot(false, false);
    await sources.release(loaded, "stopped");
    const response = await handleSourceRequest(sources, "env-source", {
      method: "POST",
      path: `/${operationId}/commit`,
      authorization: `Bearer ${token}`,
      body: async () => new TextEncoder().encode("{}"),
    });
    expect(response.status).toBe(401);
    expect((await sources.read(operationId))?.state).toBe("released");
  });

  it("a cancel on the source unfences a copy-and-move whose grant expired while held", async () => {
    let skew = 0;
    const released: Array<string> = [];
    const { sources, loaded, token } = await snapshot(false, false, {
      now: () => Date.now() + skew,
      release: async (record) => {
        released.push(record.operationId);
      },
    });
    skew = TRANSFER_GRANT_IDLE_MS + 60_000;
    await expect(sources.authorize(operationId, token)).rejects.toMatchObject({ status: 401 });
    expect(loaded.record.state).toBe("ready");
    const record = await sources.cancel(operationId, "The destination could not finish.");
    expect(record).toMatchObject({ state: "cancelled", grant: { revokedReason: "cancelled" } });
    expect(released).toEqual([operationId]);
  });

  it("serializes a yielding release hook against commit and preserves terminal replay", async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const hookEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { sources, loaded } = await snapshot(true, false, {
      release: async () => {
        entered();
        await releaseGate;
      },
    });
    const releasing = sources.release(loaded, "stopped");
    await hookEntered;
    const committing = sources.commit(loaded).then(
      () => "unexpected",
      (error: { code: string }) => error.code,
    );
    unblock();
    expect((await releasing).state).toBe("released");
    expect(await committing).toBe("released");
    expect((await sources.release(loaded, "again")).state).toBe("released");
  });

  // The cleanup fault is a read-only POSIX directory (mode 0o500); Windows ignores directory
  // permission bits, so the removal succeeds there and no fault is injected.
  it.skipIf(process.platform === "win32")(
    "acknowledges a committed copy even if cleanup fails and retries housekeeping on status read",
    async () => {
      const { sources, loaded, state } = await snapshot(true, false);
      const overlay = NodePath.join(state, "folder-sources", operationId, "portable-git");
      NodeFS.chmodSync(overlay, 0o500);
      try {
        expect((await sources.commit(loaded)).state).toBe("committed");
        expect(loaded.record.snapshotCleanupPending).toBe(true);
      } finally {
        NodeFS.chmodSync(overlay, 0o700);
      }
      const retried = await new SourceTransfers(state).read(operationId);
      expect(retried?.snapshotCleanupPending).toBe(false);
      expect(retried?.warnings).not.toContain(
        "Temporary Git snapshot cleanup is pending; the copy result is unchanged.",
      );
      expect(
        NodeFS.existsSync(NodePath.join(state, "folder-sources", operationId, "portable-git")),
      ).toBe(false);
    },
  );
});

describe("closing the source service", () => {
  it("waits for the scanned record's durable write so its state folder can be removed", async () => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-copy-close-")),
    );
    folders.push(base);
    const folder = NodePath.join(base, "project");
    const state = NodePath.join(base, "state");
    NodeFS.mkdirSync(folder);
    NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "notes\n");
    const actual = await vi.importActual<typeof import("./durable.ts")>("./durable.ts");
    let openWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      openWrite = resolve;
    });
    // Hold the durable "scanned" write, as a slow Windows fsync and rename would.
    vi.mocked(Durable.writeJson).mockImplementation(async (file, value) => {
      if ((value as { state?: string }).state === "scanned") await writeHeld;
      return actual.writeJson(file, value);
    });
    const sources = new SourceTransfers(state);
    await sources.offer({
      operationId,
      projectId,
      folder,
      mode: "copy-only",
      destinationEnvironmentId: "destination",
    });
    // "scanned" is published in memory before operation.json is rewritten.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await sources.read(operationId))?.state !== "scanning") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await sources.read(operationId))?.state).toBe("scanned");
    setTimeout(openWrite, 50);
    await sources.close();
    const directory = NodePath.join(state, "folder-sources", operationId);
    expect(NodeFS.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const persisted = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, "operation.json"), "utf8"),
    );
    expect(persisted.state).toBe("scanned");
    NodeFS.rmSync(state, { recursive: true });
    expect(NodeFS.existsSync(state)).toBe(false);
  });
});

describe("scan freshness", () => {
  it.live("keeps an unchanged resumed job, manifest and secret choices", () =>
    Effect.gen(function* () {
      const { sources, state, loaded } = yield* Effect.promise(() => snapshot(false, false));
      const before = yield* Effect.promise(() => sources.read(operationId));
      const manifest = NodeFS.readFileSync(
        NodePath.join(state, "folder-sources", operationId, "manifest.ndjson.gz"),
      );
      const resumed = new SourceTransfers(state);
      const checked = yield* Effect.promise(() => resumed.checkScan(operationId));
      expect(checked?.freshness?.current).toBe(true);
      expect(checked?.scanCompletedAt).toBe(before?.scanCompletedAt);
      expect(yield* Effect.promise(() => resumed.read(operationId))).toEqual(before);
      expect(
        NodeFS.readFileSync(
          NodePath.join(state, "folder-sources", operationId, "manifest.ndjson.gz"),
        ),
      ).toEqual(manifest);
      expect(loaded.record.selection).not.toContain("secret");
    }),
  );

  it.live("detects removed and added files without replacing the saved scan", () =>
    Effect.gen(function* () {
      const { sources, folder } = yield* Effect.promise(() => snapshot(false, false));
      NodeFS.unlinkSync(NodePath.join(folder, "unfinished.txt"));
      NodeFS.writeFileSync(NodePath.join(folder, "added.txt"), "new work");
      const before = yield* Effect.promise(() => sources.read(operationId));
      expect(
        (yield* Effect.promise(() => sources.checkScan(operationId)))?.freshness?.current,
      ).toBe(false);
      expect(yield* Effect.promise(() => sources.read(operationId))).toEqual(before);
    }),
  );

  it.live("detects added external worktrees and missing registrations", () =>
    Effect.gen(function* () {
      const { sources, repo } = yield* Effect.promise(() => snapshot(true, false));
      const external = NodePath.join(
        NodePath.dirname(NodePath.dirname(NodePath.dirname(NodePath.dirname(repo)))),
        "outside-worktree",
      );
      yield* Effect.promise(() =>
        runGit(repo, ["worktree", "add", "-q", "-b", "external", external]),
      );
      expect(
        (yield* Effect.promise(() => sources.checkScan(operationId)))?.freshness?.current,
      ).toBe(false);
      NodeFS.rmSync(external, { recursive: true, force: true });
      expect(
        (yield* Effect.promise(() => sources.checkScan(operationId)))?.freshness?.current,
      ).toBe(false);
      // Git on Windows lists paths with forward slashes.
      expect(
        (yield* Effect.promise(() => runGit(repo, ["worktree", "list", "--porcelain"]))).stdout,
      ).toContain(external.replaceAll("\\", "/"));
    }),
  );

  it.live("does not bless a legacy scan that has no persisted fingerprint", () =>
    Effect.gen(function* () {
      const { sources, state } = yield* Effect.promise(() => snapshot(false, false));
      const file = NodePath.join(state, "folder-sources", operationId, "operation.json");
      const record = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      delete record.sourceFingerprint;
      delete record.scanCompletedAt;
      NodeFS.writeFileSync(file, JSON.stringify(record));
      const legacy = new SourceTransfers(state);
      expect((yield* Effect.promise(() => legacy.checkScan(operationId)))?.freshness?.current).toBe(
        false,
      );
      expect((yield* Effect.promise(() => sources.read(operationId)))?.state).toBe("ready");
    }),
  );
});

it.live("detects an added empty directory", () =>
  Effect.gen(function* () {
    const { sources, folder } = yield* Effect.promise(() => snapshot(false, false));
    NodeFS.mkdirSync(NodePath.join(folder, "new-empty-directory"));
    expect((yield* Effect.promise(() => sources.checkScan(operationId)))?.freshness?.current).toBe(
      false,
    );
  }),
);
