// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { applyPlan } from "./apply.ts";
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
  type Plan,
} from "./reconcile.ts";
import { SourceClient } from "./sourceClient.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";
import { previewUndo, undoApply } from "./undo.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let counter = 0;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-apply-")));
  fixture = makeUmbrella(base);
  transfers = new SourceTransfers(NodePath.join(base, "source-state"));
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

async function prepareCopy(target: string, decisions: Record<string, Choice> = {}) {
  counter += 1;
  const operationId = `019a0000-0000-7000-8000-0000000001${String(counter).padStart(2, "0")}`;
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode: "copy-only",
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
  await pullFiles({
    client: copy.client,
    stagingRoot: staging,
    files: needs.files,
    directories: needs.directories,
  });
  await finalPass({ client: copy.client, stagingRoot: staging, files: needs.files, links: [] });
  const leftBehind = new Set(
    copy.manifest.header.repositories.length ? [".env", "node_modules"] : [],
  );
  return applyPlan({
    operationId: copy.operationId,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(copy.state, "backups"),
    journalFile: NodePath.join(copy.state, "journal.ndjson"),
    plan,
    sourceRepositories: copy.manifest.header.repositories,
    leftBehind,
  });
}

describe("Apply into a new empty folder", () => {
  it("produces a working copy: history, branches, stashes, status, worktrees, links and modes", async () => {
    const target = NodePath.join(base, "scratch", "copy-new");
    const copy = await prepareCopy(target);
    expect(copy.plan.rows.every((row) => row.status === "new" && !row.needsDecision)).toBe(true);
    const result = await transferAndApply(copy, target, copy.plan);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.checks.map((check) => check.repo).sort()).toEqual([
      ".",
      "repositories/svc-a",
      "repositories/svc-a-wt-feature",
      "repositories/svc-b",
    ]);
    // Worktree works at its new home and the main repository knows where it is.
    expect(
      git(NodePath.join(target, "repositories/svc-a-wt-feature"), "status", "--porcelain"),
    ).toBe("M src/a.ts");
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
    expect(worktrees).toContain(NodePath.join(target, "repositories/svc-a-wt-feature"));
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
