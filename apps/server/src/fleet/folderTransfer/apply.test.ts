// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { applyPlan, type ApplyInput, type JournalEntry } from "./apply.ts";
import { JsonLog } from "./durable.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { repositoryRelations, scanDestination } from "./destinationScan.ts";
import { git, makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import type { ManifestEntry, ManifestHeader } from "./manifest.ts";
import { finalPass, pullFiles } from "./pullWorker.ts";
import {
  planReady,
  planReconcile,
  pullRequirements,
  repoRowId,
  type Choice,
  type FileAction,
  type Plan,
} from "./reconcile.ts";
import { SourceClient } from "./sourceClient.ts";
import { SourceTransfers } from "./sourceService.ts";
import { liveMovingCopies, serveSource } from "./sourceTestServer.testkit.ts";
import { previewUndo, undoApply } from "./undo.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let counter = 0;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-apply-")));
  fixture = makeUmbrella(base);
  // Its moving copy exercises the live-file restore path that uncaptured volumes keep.
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    verifyCaptureFilesystem: liveMovingCopies,
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

/** Snapshot of every file (content hash, mode, link target) outside `.git`, plus refs per repository. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of NodeFS.readdirSync(directory)) {
      const absolute = NodePath.join(directory, name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      const stat = NodeFS.lstatSync(absolute);
      if (name === ".git") {
        const top = NodePath.dirname(absolute);
        result[`${NodePath.relative(root, top).split(NodePath.sep).join("/") || "."}:refs`] =
          git(top, "for-each-ref", "--format=%(refname) %(objectname)") +
          git(top, "rev-parse", "HEAD");
        continue;
      }
      if (stat.isSymbolicLink()) result[relative] = `link:${NodeFS.readlinkSync(absolute)}`;
      else if (stat.isDirectory()) walk(absolute);
      else
        result[relative] =
          `${(stat.mode & 0o777).toString(8)}:${NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(absolute)).digest("hex")}`;
    }
  };
  walk(root);
  return result;
}

async function prepareCopy(
  target: string,
  decisions: Record<string, Choice> = {},
  folder = fixture.root,
  mode: "copy-only" | "copy-and-move" = "copy-only",
) {
  counter += 1;
  const operationId = `019a0000-0000-7000-8000-0000000001${String(counter).padStart(2, "0")}`;
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder,
    mode,
    destinationEnvironmentId: "env-destination",
  });
  const client = new SourceClient({
    baseUrl: served.url,
    operationId,
    token: offered.token,
    allowLoopback: true,
    sleep: async () => undefined,
  });
  await client.requestManifest(DEFAULT_SELECTION);
  let manifest: { header: ManifestHeader; entries: Array<ManifestEntry> };
  for (;;) {
    const result = await client.manifest();
    if ("entries" in result) {
      manifest = result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const destination = await scanDestination(target, manifest.entries);
  const relations = await repositoryRelations(
    target,
    manifest.header.repositories,
    destination.repositories,
    (repo, commits) => client.ancestry(repo, commits),
  );
  const plan = (choices: Record<string, Choice>) =>
    planReconcile({
      sourceMachine: "M4MAX",
      repositories: manifest.header.repositories,
      entries: manifest.entries,
      targetRoot: target,
      destination,
      relations,
      caseInsensitive: destination.caseInsensitive,
      decisions: choices,
    });
  const state = NodePath.join(base, `dest-state-${counter}`);
  return { operationId, client, manifest, plan: plan(decisions), replan: plan, state };
}

async function transferAndApply(
  copy: Awaited<ReturnType<typeof prepareCopy>>,
  target: string,
  plan: Plan,
) {
  const staging = NodePath.join(copy.state, "staging");
  NodeFS.mkdirSync(staging, { recursive: true });
  const needs = pullRequirements(plan);
  const pulled = await pullFiles({
    client: copy.client,
    stagingRoot: staging,
    files: needs.files,
    directories: needs.directories,
  });
  const final = await finalPass({
    client: copy.client,
    stagingRoot: staging,
    files: needs.files,
    links: [],
  });
  // As the destination service does: refreshed files carry new hashes, moving ones stay behind.
  const refreshed = new Map([...pulled.refreshed, ...final.refreshed]);
  const unstable = new Set([
    ...pulled.unstable,
    ...final.unstable,
    ...pulled.vanished,
    ...final.vanished,
  ]);
  const leftBehind = new Set([
    ...(copy.manifest.header.repositories.length ? [".env", "node_modules"] : []),
    ...unstable,
  ]);
  return applyPlan({
    operationId: copy.operationId,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(copy.state, "backups"),
    journalFile: NodePath.join(copy.state, "journal.ndjson"),
    plan: {
      ...plan,
      actions: plan.actions.map((action) =>
        action.entry && refreshed.has(action.path)
          ? { ...action, entry: refreshed.get(action.path)! }
          : action,
      ),
    },
    sourceRepositories: copy.manifest.header.repositories,
    leftBehind,
    unstable,
  });
}

describe("Apply into a new empty folder", () => {
  it("produces a working copy: history, branches, stashes, status, links and modes; skips inner worktrees", async () => {
    const target = NodePath.join(base, "scratch", "copy-new");
    const copy = await prepareCopy(target);
    expect(copy.plan.rows.every((row) => row.status === "new" && !row.needsDecision)).toBe(true);
    const result = await transferAndApply(copy, target, copy.plan);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.checks.map((check) => check.repo).sort()).toEqual([
      ".",
      "repositories/svc-a",
      "repositories/svc-b",
    ]);
    // A worktree of a repository inside the folder is not copied: its branch
    // arrives with the main repository, which registers no dangling worktree.
    expect(NodeFS.existsSync(NodePath.join(target, "repositories/svc-a-wt-feature"))).toBe(false);
    expect(git(NodePath.join(target, "repositories/svc-a"), "rev-parse", "feature")).toBe(
      git(NodePath.join(fixture.root, "repositories/svc-a"), "rev-parse", "feature"),
    );
    // Git prints worktree paths with `/` on Windows; compare them in native form.
    const worktrees = git(
      NodePath.join(target, "repositories/svc-a"),
      "worktree",
      "list",
      "--porcelain",
    )
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => NodePath.resolve(line.slice("worktree ".length)));
    expect(worktrees).toEqual([NodePath.join(target, "repositories/svc-a")]);
    expect(
      NodeFS.lstatSync(NodePath.join(target, ".cursor/skills/appstore")).isSymbolicLink(),
    ).toBe(true);
    // Windows stores the absolute "/tmp" link against the current drive.
    expect(NodeFS.readlinkSync(NodePath.join(target, "outside-link"))).toBe(
      process.platform === "win32" ? NodePath.resolve("/tmp") : "/tmp",
    );
    // POSIX permission bits: Windows has no executable bit to carry.
    if (process.platform !== "win32")
      expect(NodeFS.statSync(NodePath.join(target, "scripts/run.sh")).mode & 0o777).toBe(0o755);
    expect(NodeFS.existsSync(NodePath.join(target, ".env"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(target, "work/big.bin"))).toBe(true);
    // The source folder is unchanged by the copy.
    expect(git(fixture.root, "status", "--porcelain")).toMatch(/^ ?M docs\/guide\.md$/m);

    const undo = await undoApply({
      targetRoot: target,
      backupRoot: NodePath.join(copy.state, "backups"),
      journalFile: NodePath.join(copy.state, "journal.ndjson"),
    });
    expect(undo.problems).toEqual([]);
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 120_000);
});

describe("Apply into an existing, out-of-sync folder", () => {
  it("fast-forwards, keeps a diverged repository's commits on both sides, and Undo restores everything", async () => {
    const target = NodePath.join(base, "existing");
    git(base, "clone", "-q", NodePath.join(fixture.origins, "umbrella.git"), target);
    NodeFS.mkdirSync(NodePath.join(target, "repositories"), { recursive: true });
    git(
      NodePath.join(target, "repositories"),
      "clone",
      "-q",
      NodePath.join(fixture.origins, "svc-b.git"),
      "svc-b",
    );
    const serviceB = NodePath.join(target, "repositories/svc-b");
    write(NodePath.join(serviceB, "src/dest-only.ts"), "destination commit\n");
    git(serviceB, "add", "-A");
    git(serviceB, "commit", "-q", "-m", "destination-only commit");
    const destinationHead = git(serviceB, "rev-parse", "HEAD");
    // The source moves its umbrella ahead: the destination is behind and clean.
    write(NodePath.join(fixture.root, "CHANGELOG.md"), "source commit\n");
    git(fixture.root, "add", "CHANGELOG.md");
    git(fixture.root, "commit", "-q", "-m", "source-only commit");
    git(
      NodePath.join(fixture.root, "repositories/svc-b"),
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "source-only svc-b commit",
    );
    write(NodePath.join(fixture.root, "work/session.log"), "source work data\n");
    write(NodePath.join(target, "work/session.log"), "destination work data\n");
    write(NodePath.join(target, "mine-only.txt"), "kept\n");
    const before = snapshot(target);

    const copy = await prepareCopy(target);
    const rowOf = (plan: Plan, id: string) => plan.rows.find((row) => row.id === id)!;
    expect(rowOf(copy.plan, repoRowId("."))).toMatchObject({ status: "fast-forward" });
    expect(rowOf(copy.plan, repoRowId("repositories/svc-b"))).toMatchObject({
      status: "diverged",
      needsDecision: true,
    });
    expect(rowOf(copy.plan, repoRowId("repositories/svc-a"))).toMatchObject({ status: "new" });
    expect(rowOf(copy.plan, repoRowId(".")).conflicts.map((conflict) => conflict.path)).toEqual([
      "work/session.log",
    ]);
    expect(planReady(copy.plan)).toBe(false);

    // svc-b stays on its own commit, so the source's uncommitted b.ts edit is a file decision too.
    const pending = copy.replan({
      [repoRowId("repositories/svc-b")]: "leave-both",
      "file:work/session.log": "keep-both",
    });
    expect(
      rowOf(pending, repoRowId("repositories/svc-b")).conflicts.map((conflict) => conflict.path),
    ).toEqual(["repositories/svc-b/src/b.ts"]);
    const plan = copy.replan({
      [repoRowId("repositories/svc-b")]: "leave-both",
      "file:work/session.log": "keep-both",
      "file:repositories/svc-b/src/b.ts": "keep-both",
    });
    expect(planReady(plan)).toBe(true);
    // Interrupt Apply partway: one staged file is missing, so it stops after earlier steps.
    const staging = NodePath.join(copy.state, "staging");
    NodeFS.mkdirSync(staging, { recursive: true });
    const needs = pullRequirements(plan);
    await pullFiles({
      client: copy.client,
      stagingRoot: staging,
      files: needs.files,
      directories: needs.directories,
    });
    const victim = plan.actions.filter((action) => action.kind === "write").at(-1)!;
    const victimStaged = NodePath.join(staging, victim.path);
    const held = `${victimStaged}.held`;
    NodeFS.renameSync(victimStaged, held);
    const applyInput = {
      operationId: copy.operationId,
      targetRoot: target,
      stagingRoot: staging,
      backupRoot: NodePath.join(copy.state, "backups"),
      journalFile: NodePath.join(copy.state, "journal.ndjson"),
      plan,
      sourceRepositories: copy.manifest.header.repositories,
      leftBehind: new Set([".env", "node_modules"]),
    };
    await expect(applyPlan(applyInput)).rejects.toThrow(/staged-missing/);
    NodeFS.renameSync(held, victimStaged);
    const result = await applyPlan(applyInput);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);

    expect(git(target, "rev-parse", "HEAD")).toBe(git(fixture.root, "rev-parse", "HEAD"));
    expect(NodeFS.readFileSync(NodePath.join(target, "docs/guide.md"), "utf8")).toBe(
      "guide v2 (uncommitted)\n",
    );
    expect(git(serviceB, "rev-parse", "main")).toBe(destinationHead);
    expect(git(serviceB, "rev-parse", "swc/from-M4MAX/main")).toBe(
      git(NodePath.join(fixture.root, "repositories/svc-b"), "rev-parse", "main"),
    );
    expect(git(serviceB, "rev-parse", "local-only")).toBe(
      git(NodePath.join(fixture.root, "repositories/svc-b"), "rev-parse", "local-only"),
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "work/session.log"), "utf8")).toBe(
      "destination work data\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "work/session.log.from-M4MAX"), "utf8")).toBe(
      "source work data\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "mine-only.txt"), "utf8")).toBe("kept\n");

    // The person edits one copied file after Apply; Undo keeps that edit and restores the rest.
    write(NodePath.join(target, "notes/todo.md"), "edited after the copy\n");
    const preview = await previewUndo({ targetRoot: target, journalFile: applyInput.journalFile });
    expect(
      preview.items.filter((item) => item.state === "edited").map((item) => item.path),
    ).toEqual(["notes/todo.md"]);
    const undo = await undoApply({
      targetRoot: target,
      backupRoot: applyInput.backupRoot,
      journalFile: applyInput.journalFile,
    });
    expect(undo.problems).toEqual([]);
    expect(undo.kept).toEqual(["notes/todo.md"]);
    const after = snapshot(target);
    const { "notes/todo.md": edited, ...rest } = after;
    expect(edited).toBeDefined();
    expect(rest).toEqual(before);
  }, 120_000);
});

describe("Apply safety and take-theirs", () => {
  it("moves a diverged branch to the source commit only by decision, keeps a backup ref, and Undo returns it", async () => {
    const target = NodePath.join(base, "take-theirs");
    git(base, "clone", "-q", NodePath.join(fixture.origins, "umbrella.git"), target);
    NodeFS.mkdirSync(NodePath.join(target, "repositories"), { recursive: true });
    git(
      NodePath.join(target, "repositories"),
      "clone",
      "-q",
      NodePath.join(fixture.origins, "svc-b.git"),
      "svc-b",
    );
    const serviceB = NodePath.join(target, "repositories/svc-b");
    git(serviceB, "commit", "-q", "--allow-empty", "-m", "destination-only");
    const mine = git(serviceB, "rev-parse", "HEAD");
    const copy = await prepareCopy(target);
    const decisions: Record<string, Choice> = { [repoRowId("repositories/svc-b")]: "take-theirs" };
    for (const row of copy.replan(decisions).rows)
      for (const conflict of row.conflicts) decisions[conflict.id] = "take-theirs";
    const plan = copy.replan(decisions);
    expect(planReady(plan)).toBe(true);
    const result = await transferAndApply(copy, target, plan);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    const theirs = git(NodePath.join(fixture.root, "repositories/svc-b"), "rev-parse", "HEAD");
    expect(git(serviceB, "rev-parse", "HEAD")).toBe(theirs);
    expect(git(serviceB, "rev-parse", `refs/swc-backup/${copy.operationId}/main`)).toBe(mine);

    const undo = await undoApply({
      targetRoot: target,
      backupRoot: NodePath.join(copy.state, "backups"),
      journalFile: NodePath.join(copy.state, "journal.ndjson"),
    });
    expect(undo.problems).toEqual([]);
    expect(git(serviceB, "rev-parse", "HEAD")).toBe(mine);
  }, 120_000);

  it("never writes through a destination folder that is a link to somewhere else", async () => {
    const elsewhere = NodePath.join(base, "elsewhere");
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    for (const choice of ["keep-mine", "take-theirs"] as const) {
      const target = NodePath.join(base, `linked-folder-${choice}`);
      NodeFS.mkdirSync(target, { recursive: true });
      NodeFS.symlinkSync(elsewhere, NodePath.join(target, "notes"));
      const copy = await prepareCopy(target);
      const plan = copy.replan({ "file:notes": choice });
      expect(planReady(plan)).toBe(true);
      const notes = plan.actions
        .filter((action) => action.path.startsWith("notes"))
        .map((action) => action.kind);
      expect(notes).toEqual(choice === "keep-mine" ? [] : ["mkdir", "write"]);
      await transferAndApply(copy, target, plan);
      expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
    }
    // A link that appears after the preview is refused at Apply time, before anything lands under it.
    const target = NodePath.join(base, "linked-later");
    NodeFS.mkdirSync(target, { recursive: true });
    const copy = await prepareCopy(target);
    NodeFS.symlinkSync(elsewhere, NodePath.join(target, "notes"));
    await expect(transferAndApply(copy, target, copy.plan)).rejects.toMatchObject({
      reason: "changed-since-preview",
    });
    expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
  }, 120_000);
});

describe("Apply while the source keeps committing", () => {
  it("restores files committed after the Git snapshot from the copied index, and Undo removes them", async () => {
    const source = NodePath.join(base, "live-source");
    NodeFS.mkdirSync(source, { recursive: true });
    git(source, "init", "-q");
    write(NodePath.join(source, ".gitattributes"), "big.bin filter=lfs\n");
    write(NodePath.join(source, "churn.txt"), "churn at snapshot\n");
    write(NodePath.join(source, "dirty.txt"), "dirty committed\n");
    write(NodePath.join(source, "big.bin"), "large at snapshot\n");
    write(NodePath.join(source, "gone.txt"), "gone at snapshot\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "initial");
    write(NodePath.join(source, "dirty.txt"), "dirty at snapshot\n");
    const target = NodePath.join(base, "scratch", "copy-live");
    const copy = await prepareCopy(target, {}, source, "copy-and-move");
    // Live-file coordinator moves retain their original refresh/restoration behavior.
    // Commits land after the snapshot, while the files are still to be read.
    write(NodePath.join(source, "churn.txt"), "churn committed later, longer\n");
    write(NodePath.join(source, "big.bin"), "large committed later, longer\n");
    NodeFS.rmSync(NodePath.join(source, "gone.txt"));
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "after the snapshot");
    write(NodePath.join(source, "dirty.txt"), "dirty edited later, longer\n");

    const result = await transferAndApply(copy, target, copy.plan);
    const read = (path: string) => NodeFS.readFileSync(NodePath.join(target, path), "utf8");
    expect(read("churn.txt")).toBe("churn at snapshot\n");
    expect(read("gone.txt")).toBe("gone at snapshot\n");
    // Dirty at the snapshot: left as transferred. Filtered (LFS): never touched.
    expect(read("dirty.txt")).toBe("dirty edited later, longer\n");
    expect(read("big.bin")).toBe("large committed later, longer\n");
    expect(result.checks).toEqual([
      {
        repo: ".",
        ok: false,
        problems: [
          "git status differs from the source.",
          "big.bin: M here, unchanged on the source.",
        ],
      },
    ]);
    expect(result.warnings).toEqual([
      "2 files changed on the source after copying started; the copy has them as they were when it started. Copy again to bring the newer versions. (churn.txt, gone.txt)",
    ]);
    expect(result.restored).toEqual(["churn.txt", "gone.txt"]);

    const undo = await undoApply({
      targetRoot: target,
      backupRoot: NodePath.join(copy.state, "backups"),
      journalFile: NodePath.join(copy.state, "journal.ndjson"),
    });
    expect(undo).toMatchObject({ kept: [], problems: [] });
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 120_000);
});

/** Every folder and file below `root` with its content: an empty folder left behind shows. */
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of NodeFS.readdirSync(directory)) {
      const absolute = NodePath.join(directory, name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      if (NodeFS.lstatSync(absolute).isDirectory()) {
        result[`${relative}/`] = "";
        walk(absolute);
      } else result[relative] = NodeFS.readFileSync(absolute, "utf8");
    }
  };
  walk(root);
  return result;
}

/**
 * A plan of `count` new files in nested folders, plus `replacing` files that
 * overwrite existing ones (sorted last). No repositories: only the file loop runs.
 */
function syntheticApply(name: string, count: number, replacing = 0) {
  const directory = NodePath.join(base, "synthetic", name);
  const staging = NodePath.join(directory, "staging");
  const target = NodePath.join(directory, "target");
  const actions: Array<FileAction> = [];
  const expected: Record<string, string> = {};
  const add = (path: string, body: string, replaces: boolean) => {
    write(NodePath.join(staging, ...path.split("/")), body);
    expected[path] = body;
    actions.push({
      path,
      kind: "write",
      entry: {
        path,
        type: "file",
        mode: 0o644,
        size: Buffer.byteLength(body),
        mtimeMs: 0,
        class: "untracked",
        repo: null,
        sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
      },
      replaces,
      localSource: null,
      row: "files",
      writePath: path,
    });
  };
  for (let index = 0; index < count; index += 1)
    add(`d${index % 20}/s${index % 3}/f${index}.txt`, `file ${index}\n`, false);
  for (let index = 0; index < replacing; index += 1) {
    write(NodePath.join(target, "zz", `old${index}.txt`), `original ${index}\n`);
    add(`zz/old${index}.txt`, `copied ${index}\n`, true);
  }
  const plan = {
    rows: [],
    actions,
    git: [],
    totals: { filesToMove: 0, bytesToMove: 0, bytesPresent: 0, decisionsNeeded: 0, replacing },
    warnings: [],
  } satisfies Plan;
  const input: ApplyInput = {
    operationId: `synthetic-${name}`,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(directory, "backups"),
    journalFile: NodePath.join(directory, "journal.ndjson"),
    plan,
    sourceRepositories: [],
    leftBehind: new Set(),
  };
  return { input, target, expected };
}

async function fileHandlePrototype() {
  const probe = NodePath.join(base, "probe");
  const handle = await NodeFSP.open(probe, "w");
  await handle.close();
  return Object.getPrototypeOf(handle) as NodeFSP.FileHandle;
}

/**
 * Runs Apply until sync number `at`, then simulates a power cut: journal lines
 * after the last completed sync are lost, while the file moves stay. `after`
 * lets that sync finish and stops Apply at its next staged file.
 */
async function applyWithCrash(input: ApplyInput, at: number, after: boolean) {
  const original = JsonLog.prototype.sync;
  let calls = 0;
  let durable = 0;
  let crashed = false;
  const away = `${input.stagingRoot}.away`;
  const spy = vi.spyOn(JsonLog.prototype, "sync").mockImplementation(async function (
    this: JsonLog<JournalEntry>,
  ) {
    // A previous timed-out test may still be finishing its own Undo. Its syncs
    // must not advance this fixture's crash checkpoint or be suppressed.
    if (this.file !== input.journalFile) return original.call(this);
    if (crashed) return;
    calls += 1;
    if (calls === at && !after) {
      crashed = true;
      throw new Error("simulated crash");
    }
    await original.call(this);
    durable = NodeFS.statSync(input.journalFile).size;
    if (calls === at) {
      crashed = true;
      NodeFS.renameSync(input.stagingRoot, away);
    }
  });
  try {
    await expect(applyPlan(input)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(crashed).toBe(true);
  if (after) NodeFS.renameSync(away, input.stagingRoot);
  NodeFS.truncateSync(input.journalFile, durable);
}

describe("Apply journal durability", () => {
  it("syncs the journal once per batch, not per file", async () => {
    const { input, target, expected } = syntheticApply("sync-count", 2000);
    const prototype = await fileHandlePrototype();
    const spy = vi.spyOn(prototype, "sync");
    try {
      await applyPlan(input);
    } finally {
      spy.mockRestore();
    }
    // root-created, four batches of intents, done: never three per file as before.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(8);
    expect(
      Object.fromEntries(Object.entries(tree(target)).filter(([path]) => !path.endsWith("/"))),
    ).toEqual(expected);
    const undo = await undoApply({
      targetRoot: target,
      backupRoot: input.backupRoot,
      journalFile: input.journalFile,
    });
    expect(undo.problems).toEqual([]);
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 60_000);

  it.each([
    ["intents synced, nothing written yet", 1, true],
    ["a batch written, its done marks lost", 2, false],
    ["a backup recorded, then stopped", 3, true],
    ["a backup moved, its write intent lost", 4, false],
  ] as const)(
    "a crash with %s replays to the full copy, and Undo restores the folder",
    async (_label, at, after) => {
      // Cross the real 512-file batch boundary once. The separate 2000-file
      // test above covers four batches; crash replay need not restore 2000 files
      // with two durable Undo syncs each on slow Windows disks.
      const { input, target, expected } = syntheticApply(`crash-${at}-${after}`, 513, 2);
      const before = tree(target);
      await applyWithCrash(input, at, after);
      const records = NodeFS.readFileSync(input.journalFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { t: string; path?: string });
      if (at <= 2) {
        expect(records.filter((entry) => entry.t === "write")).toHaveLength(512);
        expect(records.some((entry) => entry.t === "write-done")).toBe(false);
        const written = Object.keys(tree(target)).filter(
          (path) => path.startsWith("d") && !path.endsWith("/"),
        );
        expect(written).toHaveLength(at === 1 ? 0 : 512);
      } else {
        expect(
          NodeFS.readFileSync(NodePath.join(input.backupRoot, "files/zz/old0.txt"), "utf8"),
        ).toBe("original 0\n");
        expect(NodeFS.existsSync(NodePath.join(target, "zz/old0.txt"))).toBe(false);
        expect(records.some((entry) => entry.t === "backup" && entry.path === "zz/old0.txt")).toBe(
          true,
        );
        expect(records.some((entry) => entry.t === "write" && entry.path === "zz/old0.txt")).toBe(
          false,
        );
      }
      await applyPlan(input);
      const after_ = tree(target);
      for (const [path, body] of Object.entries(expected)) expect(after_[path]).toBe(body);
      expect(
        NodeFS.readFileSync(NodePath.join(input.backupRoot, "files/zz/old0.txt"), "utf8"),
      ).toBe("original 0\n");
      expect(
        NodeFS.readdirSync(input.stagingRoot, { recursive: true }).filter((name) =>
          String(name).endsWith(".txt"),
        ),
      ).toEqual([]);
      const preview = await previewUndo({ targetRoot: target, journalFile: input.journalFile });
      expect(preview.edited).toBe(0);
      const undo = await undoApply({
        targetRoot: target,
        backupRoot: input.backupRoot,
        journalFile: input.journalFile,
      });
      expect(undo.problems).toEqual([]);
      expect(undo.kept).toEqual([]);
      expect(tree(target)).toEqual(before);
    },
    60_000,
  );

  it("an intent recorded ahead of a stopped Apply is nothing to Undo", async () => {
    const { input, target } = syntheticApply("stopped-ahead", 600);
    // Stops at the first file, after the first batch's 512 intents are on disk.
    await applyWithCrash(input, 2, true);
    const preview = await previewUndo({ targetRoot: target, journalFile: input.journalFile });
    expect(preview.items).toEqual([]);
    const undo = await undoApply({
      targetRoot: target,
      backupRoot: input.backupRoot,
      journalFile: input.journalFile,
    });
    expect(undo).toMatchObject({ restored: 0, kept: [], problems: [] });
    expect(NodeFS.existsSync(target)).toBe(false);
  }, 60_000);

  it("keeps the original when a recorded backup never moved it", async () => {
    const { input, target } = syntheticApply("backup-unmoved", 3, 1);
    const backup = NodePath.join(input.backupRoot, "files", "zz", "old0.txt");
    // A crash between the synced backup record and the move.
    NodeFS.mkdirSync(NodePath.dirname(input.journalFile), { recursive: true });
    NodeFS.writeFileSync(
      input.journalFile,
      `${JSON.stringify({ t: "backup", path: "zz/old0.txt", backup })}\n`,
    );
    await applyPlan(input);
    expect(NodeFS.readFileSync(NodePath.join(target, "zz/old0.txt"), "utf8")).toBe("copied 0\n");
    expect(NodeFS.readFileSync(backup, "utf8")).toBe("original 0\n");
    const undo = await undoApply({
      targetRoot: target,
      backupRoot: input.backupRoot,
      journalFile: input.journalFile,
    });
    expect(undo.problems).toEqual([]);
    expect(tree(target)).toEqual({ "zz/": "", "zz/old0.txt": "original 0\n" });
  }, 60_000);
});
