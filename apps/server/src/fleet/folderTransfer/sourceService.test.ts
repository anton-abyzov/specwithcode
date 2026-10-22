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

async function snapshot(withRepository = false) {
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
  const sources = new SourceTransfers(state);
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
  await sources.commit(loaded);
  return { sources, folder, state, repo };
}

describe("a completed copy before coordinator context transfer", () => {
  it.live("retains the activity warning in the status, manifest and restarted source", () =>
    Effect.gen(function* () {
      const { sources, state } = yield* Effect.promise(() => snapshot());
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
        yield* makeFolderCopyManifest(restarted)(operationId, projectId, "destination"),
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
