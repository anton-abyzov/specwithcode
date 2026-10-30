// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MachineHandoffError, type ProjectId } from "@specweave-studio/contracts";
import { makeFolderCopyManifest } from "../folderCopyPreparation.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { git, write } from "./folderFixture.testkit.ts";
import * as Manifest from "./manifest.ts";
import { SourceTransfers } from "./sourceService.ts";
import { liveMovingCopies } from "./sourceTestServer.testkit.ts";

vi.mock("./manifest.ts", async (original) => {
  const actual = await original<typeof Manifest>();
  return { ...actual, hashFile: vi.fn(actual.hashFile) };
});

const LEDGER = ".specweave/increments/0001-move/ledger.jsonl";
/** File stamps older than a tick before capture, as on a machine where files settled. */
const STAMPS = { stampClock: () => Date.now() + 10_000 };

let base: string;
let folder: string;
let state: string;
let sources: SourceTransfers;
let id: string;
beforeEach(async () => {
  base = await FSP.realpath(await FSP.mkdtemp(Path.join(OS.tmpdir(), "swc-drift-")));
  folder = Path.join(base, "source");
  state = Path.join(base, "state");
  write(Path.join(folder, "README.md"), "moving project\n");
  write(Path.join(folder, ".gitignore"), "repositories/\nnode_modules/\n.env\n");
  write(Path.join(folder, "docs/guide.md"), "guide\n");
  git(folder, "init", "-q");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "initial");
  write(Path.join(folder, LEDGER), '{"t":"T-01","e":"claim"}\n');
  write(Path.join(folder, "notes/todo.md"), "untracked todo\n");
  write(Path.join(folder, ".env"), "EXAMPLE_PRIVATE=fixture\n");
  write(Path.join(folder, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  const nested = Path.join(folder, "repositories/svc");
  write(Path.join(nested, "src/a.ts"), "export const a = 1;\n");
  git(nested, "init", "-q");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "initial");
  sources = new SourceTransfers(state, STAMPS);
  id = Crypto.randomUUID();
});
afterEach(async () => {
  vi.mocked(Manifest.hashFile).mockClear();
  await sources.close();
  await FSP.chmod(Path.join(folder, "docs"), 0o755).catch(() => {});
  await FSP.rm(base, { recursive: true, force: true });
});

/** A copy-and-move the destination has applied and committed. */
async function committed(
  options: {
    readonly before?: (loaded: Awaited<ReturnType<SourceTransfers["authorize"]>>) => Promise<void>;
  } = {},
) {
  const offer = await sources.offer({
    operationId: id,
    projectId: "source-project",
    folder,
    mode: "copy-and-move",
    destinationEnvironmentId: "destination-env",
  });
  const loaded = await sources.authorize(id, offer.token);
  await loaded.building;
  await sources.requestManifest(loaded, DEFAULT_SELECTION);
  await loaded.building;
  expect(loaded.record.state).toBe("ready");
  await options.before?.(loaded);
  await sources.commit(loaded);
  expect(loaded.record.state).toBe("committed");
  vi.mocked(Manifest.hashFile).mockClear();
}
const hashed = () =>
  vi
    .mocked(Manifest.hashFile)
    .mock.calls.map(([absolute]) => Path.relative(folder, absolute))
    .filter((path) => !path.startsWith(".."));

it("reports nothing and reads no file when nothing changed", async () => {
  await committed();
  const drift = await sources.driftSince(id);
  expect(drift).toMatchObject({ total: 0, rows: [], truncated: false });
  expect(hashed()).toEqual([]);
});

it("lists an edited ledger as one changed row, keyed by path only", async () => {
  await committed();
  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-01","e":"done"}\n');
  const drift = await sources.driftSince(id);
  expect(drift.rows).toEqual([
    {
      path: LEDGER,
      kind: "changed",
      size: Buffer.byteLength('{"t":"T-01","e":"claim"}\n{"t":"T-01","e":"done"}\n'),
    },
  ]);
  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-02","e":"claim"}\n');
  const again = await sources.driftSince(id);
  expect(again.digest).toBe(drift.digest);
  const report = await sources.driftReport(id, drift.digest);
  expect(report?.rows.map((row) => row.path)).toEqual([LEDGER]);
  expect(await sources.driftReport(id, "0".repeat(64))).toBeNull();
  expect(await sources.driftReport(id, "../operation")).toBeNull();
});

it("ignores a touch but catches a same-size rewrite", async () => {
  await committed();
  const guide = Path.join(folder, "docs/guide.md");
  const later = new Date(Date.now() + 60_000);
  await FSP.utimes(guide, later, later);
  expect((await sources.driftSince(id)).total).toBe(0);
  // Same size, and the modification time put back: only the change time differs.
  const before = await FSP.stat(guide);
  await FSP.writeFile(guide, "GUIDE\n");
  await FSP.utimes(guide, before.atime, before.mtime);
  expect((await sources.driftSince(id)).rows).toEqual([
    { path: "docs/guide.md", kind: "changed", size: 6 },
  ]);
});

it("lists deleted and new files", async () => {
  await committed();
  await FSP.rm(Path.join(folder, "notes/todo.md"));
  write(Path.join(folder, "notes/new.md"), "new work\n");
  expect((await sources.driftSince(id)).rows).toEqual([
    { path: "notes/new.md", kind: "added", size: 9 },
    { path: "notes/todo.md", kind: "removed", size: Buffer.byteLength("untracked todo\n") },
  ]);
});

it("lists a nested repository's new commit with both heads", async () => {
  await committed();
  const nested = Path.join(folder, "repositories/svc");
  const from = git(nested, "rev-parse", "HEAD");
  git(nested, "commit", "-q", "--allow-empty", "-m", "later");
  const to = git(nested, "rev-parse", "HEAD");
  const rows = (await sources.driftSince(id)).rows;
  expect(rows).toEqual([
    {
      path: "repositories/svc",
      kind: "repository",
      repository: {
        headFrom: from,
        headTo: to,
        branchesChanged: ["main"],
        stashFrom: 0,
        stashTo: 0,
        indexChanged: false,
      },
    },
  ]);
});

it("lists a staged-only change as the repository's index", async () => {
  await committed();
  git(folder, "add", "notes/todo.md");
  const rows = (await sources.driftSince(id)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    path: ".",
    kind: "repository",
    repository: { indexChanged: true },
  });
  expect(rows[0]!.repository!.headFrom).toBe(rows[0]!.repository!.headTo);
});

it("lists a new tag, note or remote-tracking ref as the repository's refs", async () => {
  await committed();
  const repository = async () => (await sources.driftSince(id)).rows;
  for (const add of [
    ["tag", "v2.0"],
    ["notes", "add", "-m", "reviewed", "HEAD"],
    ["update-ref", "refs/remotes/upstream/main", "HEAD"],
  ]) {
    git(folder, ...add);
    const rows = await repository();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: ".",
      kind: "repository",
      repository: { refsChanged: true, indexChanged: false, branchesChanged: [] },
    });
  }
  git(folder, "tag", "-d", "v2.0");
  git(folder, "update-ref", "-d", "refs/notes/commits");
  git(folder, "update-ref", "-d", "refs/remotes/upstream/main");
  // Packing moves refs between files without changing any of them.
  git(folder, "pack-refs", "--all");
  expect(await repository()).toEqual([]);
});

it("lists a changed Git setting, exclude rule or hook as the repository's settings", async () => {
  await committed();
  const config = Path.join(folder, ".git/config");
  const exclude = Path.join(folder, "repositories/svc/.git/info/exclude");
  const hook = Path.join(folder, "repositories/svc/.git/hooks/pre-commit");
  const original = { config: await FSP.readFile(config), exclude: await FSP.readFile(exclude) };
  const changed = async () =>
    (await sources.driftSince(id)).rows.map((row) => {
      expect(row).toMatchObject({ kind: "repository", repository: { settingsChanged: true } });
      return row.path;
    });
  git(folder, "remote", "add", "upstream", "https://example.invalid/upstream.git");
  expect(await changed()).toEqual(["."]);
  await FSP.appendFile(exclude, "scratch/\n");
  expect(await changed()).toEqual([".", "repositories/svc"]);
  await FSP.writeFile(config, original.config);
  await FSP.writeFile(exclude, original.exclude);
  expect(await changed()).toEqual([]);
  write(hook, "#!/bin/sh\nexit 0\n");
  expect(await changed()).toEqual(["repositories/svc"]);
  await FSP.rm(hook);
  expect(await changed()).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "lists a folder holding a new file it cannot copy, not nothing",
  async () => {
    await committed();
    write(Path.join(folder, "notes/bad\nname.md"), "cannot travel\n");
    expect((await sources.driftSince(id)).rows).toEqual([{ path: "notes", kind: "unreadable" }]);
  },
);

it("ignores secrets and rebuildable folders the copy left out", async () => {
  await committed();
  await FSP.writeFile(Path.join(folder, ".env"), "EXAMPLE_PRIVATE=later\n");
  write(Path.join(folder, "node_modules/pkg/index.js"), "module.exports = 2;\n");
  write(Path.join(folder, "node_modules/other/index.js"), "module.exports = 3;\n");
  expect((await sources.driftSince(id)).total).toBe(0);
});

it("lists an approved secret the destination pulled once it changes here", async () => {
  await committed({
    before: async (loaded) => {
      await sources.approveSecrets({ operationId: id, paths: [".env"], destinationLabel: "M3" });
      await sources.secretFile(loaded, ".env");
    },
  });
  expect((await sources.driftSince(id)).total).toBe(0);
  await FSP.writeFile(Path.join(folder, ".env"), "EXAMPLE_PRIVATE=rotated\n");
  expect((await sources.driftSince(id)).rows).toEqual([
    { path: ".env", kind: "changed", size: Buffer.byteLength("EXAMPLE_PRIVATE=rotated\n") },
  ]);
  await FSP.rm(Path.join(folder, ".env"));
  expect((await sources.driftSince(id)).rows).toEqual([
    { path: ".env", kind: "removed", size: Buffer.byteLength("EXAMPLE_PRIVATE=fixture\n") },
  ]);
  // Only its hash is kept, never the secret's bytes.
  const served = await FSP.readFile(
    Path.join(state, "folder-sources", id, "secrets-served.ndjson"),
    "utf8",
  );
  expect(served).not.toContain("EXAMPLE_PRIVATE");
});

it.skipIf(process.platform === "win32")(
  "lists a second uncopyable entry in a folder that already had one",
  async () => {
    write(Path.join(folder, "notes/bad\nfirst.md"), "cannot travel\n");
    await committed();
    expect((await sources.driftSince(id)).total).toBe(0);
    write(Path.join(folder, "notes/bad\nsecond.md"), "cannot travel either\n");
    expect((await sources.driftSince(id)).rows).toEqual([{ path: "notes", kind: "unreadable" }]);
  },
);

it("lists a file still being written on the copy's last read as copied mid-write", async () => {
  await committed();
  const basisFile = Path.join(state, "folder-sources", id, "drift-basis.json");
  const basis = JSON.parse(await FSP.readFile(basisFile, "utf8"));
  // As the capture leaves a file that never settled: listed in changing, no stat.
  delete basis.stats[LEDGER];
  await FSP.writeFile(basisFile, JSON.stringify({ ...basis, changing: [LEDGER] }));
  expect((await sources.driftSince(id)).total).toBe(0);
  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-01","e":"done"}\n');
  expect((await sources.driftSince(id)).rows).toEqual([
    expect.objectContaining({ path: LEDGER, kind: "changed", unsettled: true }),
  ]);
});

it("reads a file again when its captured stat is within a clock tick of the read", async () => {
  await sources.close();
  // The default clock: every fixture file was just written, so none keeps a stat.
  sources = new SourceTransfers(state);
  if (process.platform === "win32") {
    // Git runs slowly there, so the fixture's files can be past the slack, settled, by the
    // read. Date the file ahead of the read, as one written within a tick of it would be.
    const stamp = new Date(Date.now() + 60_000);
    await FSP.utimes(Path.join(folder, "docs/guide.md"), stamp, stamp);
  }
  await committed();
  const basis = JSON.parse(
    await FSP.readFile(Path.join(state, "folder-sources", id, "drift-basis.json"), "utf8"),
  );
  expect(basis.stats["docs/guide.md"]).toBeUndefined();
  expect((await sources.driftSince(id)).total).toBe(0);
  expect(hashed()).toContain("docs/guide.md");
});

it.skipIf(process.platform === "win32")(
  "keeps a file row and a repository row at the same path, and accepts each only by itself",
  async () => {
    await committed();
    git(folder, "add", "notes/todo.md");
    const first = await sources.driftSince(id);
    expect(first.rows.map((row) => `${row.kind}:${row.path}`)).toEqual(["repository:."]);
    write(Path.join(folder, "bad\nroot.md"), "cannot travel\n");
    const both = await sources.driftSince(id);
    expect(both.rows.map((row) => `${row.kind}:${row.path}`)).toEqual([
      "unreadable:.",
      "repository:.",
    ]);
    // Moving without the repository row alone does not cover the new entry at the root.
    const error = await refusedPublish(first.digest);
    expect(error.code).toBe("source_changed");
    expect(error.changes?.digest).toBe(both.digest);
  },
);

it("keeps an older record without a drift basis strict: refs files and every warning", async () => {
  await committed();
  await FSP.rm(Path.join(state, "folder-sources", id, "drift-basis.json"));
  expect((await sources.driftSince(id)).total).toBe(0);
  git(folder, "tag", "v2.0");
  expect((await sources.driftSince(id)).rows).toEqual([
    expect.objectContaining({
      path: ".",
      kind: "repository",
      repository: expect.objectContaining({ refsChanged: true }),
    }),
  ]);
  git(folder, "tag", "-d", "v2.0");
  expect((await sources.driftSince(id)).total).toBe(0);
  if (process.platform === "win32") return;
  // Any skipped entry refuses, as the old whole-tree check did.
  write(Path.join(folder, "docs/bad\nname.md"), "cannot travel\n");
  expect((await sources.driftSince(id)).rows).toEqual([{ path: "docs", kind: "unreadable" }]);
});

it.skipIf(process.platform === "win32")("passes over a named pipe it never copied", async () => {
  await committed();
  NodeChildProcess.execFileSync("mkfifo", [Path.join(folder, "notes/pipe")]);
  expect((await sources.driftSince(id)).total).toBe(0);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "lists a folder it can no longer read as unreadable, not as deleted files",
  async () => {
    await committed();
    await FSP.chmod(Path.join(folder, "docs"), 0o000);
    const rows = (await sources.driftSince(id)).rows;
    expect(rows).toEqual([{ path: "docs", kind: "unreadable" }]);
  },
);

/** A publish of the committed copy, failing as the move would; accepting `digest` when given. */
const refusedPublish = (acceptedSourceChanges?: string) =>
  Effect.runPromise(
    Effect.flip(
      makeFolderCopyManifest(sources)(
        id,
        "source-project" as ProjectId,
        "destination-env",
        folder,
        { publish: true, ...(acceptedSourceChanges ? { acceptedSourceChanges } : {}) },
      ),
    ),
  );

/** Neither a legacy record nor a live-served copy may move without its changed paths. */
async function expectReviewOnly() {
  await FSP.appendFile(Path.join(folder, LEDGER), '{"t":"T-01","e":"done"}\n');
  const error = await refusedPublish();
  expect(error).toBeInstanceOf(MachineHandoffError);
  expect(error.code).toBe("source_changed");
  expect(error.changes).toMatchObject({ total: 1, acceptable: false, truncated: false });
  expect(error.changes?.rows.map((row) => row.path)).toEqual([LEDGER]);
  const again = await refusedPublish(error.changes!.digest);
  expect(again.code).toBe("source_changed");
  expect(again.changes).toMatchObject({ digest: error.changes!.digest, acceptable: false });
  const record = await sources.read(id);
  expect(record?.leftOnSource).toBeUndefined();
  expect(record?.acceptedDrift).toBeUndefined();
}

it("offers a legacy record's changes as review-only", async () => {
  await committed();
  await sources.close();
  const operation = Path.join(state, "folder-sources", id, "operation.json");
  const { capturedSource: _captured, ...legacy } = JSON.parse(
    await FSP.readFile(operation, "utf8"),
  );
  await FSP.writeFile(operation, JSON.stringify(legacy));
  sources = new SourceTransfers(state, STAMPS);
  await expectReviewOnly();
});

it("offers a move from a volume it could not capture as review-only", async () => {
  await sources.close();
  sources = new SourceTransfers(state, { ...STAMPS, verifyCaptureFilesystem: liveMovingCopies });
  await committed();
  expect((await sources.read(id))?.capturedSource).toBeUndefined();
  await expectReviewOnly();
});

it("keeps a decision across a restart, clears it with null, and never adds one after release", async () => {
  await committed();
  const decision = {
    accepted: { digest: "a".repeat(64), total: 2 },
    leftOnSource: { digest: "b".repeat(64), total: 1 },
  };
  // Started together with close: the decision still reaches disk.
  const [recorded] = await Promise.all([
    sources.recordDriftDecision(id, decision),
    sources.close(),
  ]);
  expect(recorded.leftOnSource).toMatchObject({ digest: "b".repeat(64), total: 1 });
  sources = new SourceTransfers(state, STAMPS);
  expect((await sources.read(id))?.leftOnSource).toMatchObject({ total: 1 });
  expect((await sources.read(id))?.acceptedDrift).toMatchObject({ total: 2 });
  await sources.recordDriftDecision(id, null);
  await sources.close();
  sources = new SourceTransfers(state, STAMPS);
  expect((await sources.read(id))?.leftOnSource).toBeUndefined();
  expect((await sources.read(id))?.acceptedDrift).toBeUndefined();

  // Racing a release: whichever lands first, a released record never gains a decision.
  const [raced] = await Promise.allSettled([
    sources.recordDriftDecision(id, decision),
    sources.abandonContextTransfer(id, "Keep it here"),
  ]);
  const ended = await sources.read(id);
  expect(ended?.state).toBe("released");
  if (raced.status === "rejected") expect(ended?.leftOnSource).toBeUndefined();
  await expect(sources.recordDriftDecision(id, decision)).rejects.toMatchObject({ status: 409 });
  sources = new SourceTransfers(state, STAMPS);
  expect((await sources.read(id))?.state).toBe("released");
});
