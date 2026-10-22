// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated copy snapshots and bounded background waits.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProjectId } from "@specweave-studio/contracts";
import { ACTIVE_COPY_WARNING, makeFolderCopyManifest } from "../folderCopyPreparation.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { runGit } from "./git.ts";
import { readManifestFile } from "./manifest.ts";
import { SourceTransfers } from "./sourceService.ts";

const folders: Array<string> = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const projectId = ProjectId.make("source-project");
const operationId = "00000000-0000-4000-8000-000000000990";

async function snapshot(
  withRepository = false,
  commit = true,
  hooks: ConstructorParameters<typeof SourceTransfers>[1] = {},
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
        if (change === "mode") NodeFS.chmodSync(file, 0o700);
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

  it("acknowledges a committed copy even if cleanup fails and retries housekeeping on status read", async () => {
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
  });
});
