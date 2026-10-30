// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { applyPlan } from "./apply.ts";
import { DEFAULT_SELECTION } from "./classify.ts";
import { repositoryRelations, scanDestination } from "./destinationScan.ts";
import { git, write } from "./folderFixture.testkit.ts";
import type { ManifestEntry, ManifestHeader } from "./manifest.ts";
import { finalPass, pullFiles } from "./pullWorker.ts";
import { planReconcile, pullRequirements, repoRowId, type Choice } from "./reconcile.ts";
import { SourceClient } from "./sourceClient.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let root: string;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;

const GITLINKS = [".repos/effect/submodules/distilled", ".repos/effect/submodules/floci"];

/**
 * An umbrella whose ignored `repositories/` holds a repository with two
 * uninitialized submodules: Git records them as gitlinks and leaves an empty
 * folder at each path.
 */
function makeFixture(folder: string) {
  write(NodePath.join(folder, "README.md"), "# Umbrella\n");
  write(NodePath.join(folder, ".gitignore"), "repositories/\n");
  git(folder, "init", "-q");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "initial");

  // A vendored project inside the repository keeps its submodules as gitlinks
  // of the outer repository, as `specweave-studio/.repos/alchemy-effect` does.
  const studio = NodePath.join(folder, "repositories/studio");
  write(NodePath.join(studio, "README.md"), "studio\n");
  write(NodePath.join(studio, ".repos/effect/README.md"), "effect\n");
  write(
    NodePath.join(studio, ".repos/effect/.gitmodules"),
    [
      '[submodule "submodules/distilled"]',
      "\tpath = submodules/distilled",
      "\turl = https://example.invalid/distilled.git",
      '[submodule "submodules/floci"]',
      "\tpath = submodules/floci",
      "\turl = https://example.invalid/floci.git",
      "",
    ].join("\n"),
  );
  git(studio, "init", "-q");
  git(studio, "add", "-A");
  git(studio, "commit", "-q", "-m", "initial");
  const commit = git(studio, "rev-parse", "HEAD");
  for (const path of GITLINKS) {
    git(studio, "update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
    NodeFS.mkdirSync(NodePath.join(studio, path), { recursive: true });
  }
  git(studio, "commit", "-q", "-m", "submodules");
  // An empty untracked folder travels too, so the copy looks like the source.
  NodeFS.mkdirSync(NodePath.join(studio, "empty/inside"), { recursive: true });
}

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-gitlink-")));
  root = NodePath.join(base, "umbrella");
  makeFixture(root);
  transfers = new SourceTransfers(NodePath.join(base, "source-state"));
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

let counter = 0;

async function copyInto(target: string, decisions: Record<string, Choice> = {}) {
  counter += 1;
  const operationId = `019a0000-0000-7000-8000-0000000003${String(counter).padStart(2, "0")}`;
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: root,
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
  const plan = planReconcile({
    sourceMachine: "M4MAX",
    repositories: manifest.header.repositories,
    entries: manifest.entries,
    targetRoot: target,
    destination,
    relations,
    caseInsensitive: destination.caseInsensitive,
    decisions,
  });
  const state = NodePath.join(base, `dest-state-${counter}`);
  const staging = NodePath.join(state, "staging");
  NodeFS.mkdirSync(staging, { recursive: true });
  const needs = pullRequirements(plan);
  await pullFiles({
    client,
    stagingRoot: staging,
    files: needs.files,
    directories: needs.directories,
  });
  await finalPass({ client, stagingRoot: staging, files: needs.files, links: [] });
  return applyPlan({
    operationId,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(state, "backups"),
    journalFile: NodePath.join(state, "journal.ndjson"),
    plan,
    sourceRepositories: manifest.header.repositories,
    leftBehind: new Set(),
    unstable: new Set(),
  });
}

describe("Apply with uninitialized submodules", () => {
  it("recreates the empty folders at gitlink paths, so git status matches the source", async () => {
    const studio = "repositories/studio";
    expect(git(NodePath.join(root, studio), "status", "--porcelain")).toBe("");
    const target = NodePath.join(base, "copy");
    const result = await copyInto(target);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    for (const path of GITLINKS)
      expect(NodeFS.statSync(NodePath.join(target, studio, path)).isDirectory()).toBe(true);
    expect(git(NodePath.join(target, studio), "status", "--porcelain")).toBe("");
    expect(NodeFS.statSync(NodePath.join(target, studio, "empty/inside")).isDirectory()).toBe(true);
  }, 120_000);

  it("recreates them when a repository folder already here is replaced by the source's", async () => {
    const studio = "repositories/studio";
    const target = NodePath.join(base, "replaced");
    expect((await copyInto(target)).checks.filter((check) => !check.ok)).toEqual([]);
    // The folder stays with its files but is no repository any more, and one
    // gitlink folder is gone, so only a real replace brings both back.
    NodeFS.rmSync(NodePath.join(target, studio, ".git"), { recursive: true });
    NodeFS.rmSync(NodePath.join(target, studio, GITLINKS[0]!), { recursive: true });
    const result = await copyInto(target, { [repoRowId(studio)]: "take-theirs" });
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.checks.filter((check) => check.repo === studio && check.ok)).toHaveLength(1);
    expect(NodeFS.statSync(NodePath.join(target, studio, ".git")).isDirectory()).toBe(true);
    for (const path of GITLINKS)
      expect(NodeFS.statSync(NodePath.join(target, studio, path)).isDirectory()).toBe(true);
    // Named Git folder and work tree, so status never falls back to the umbrella.
    const copied = NodePath.join(target, studio);
    expect(
      git(
        copied,
        `--git-dir=${NodePath.join(copied, ".git")}`,
        `--work-tree=${copied}`,
        "status",
        "--porcelain",
      ),
    ).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(target, studio, "README.md"), "utf8")).toBe(
      "studio\n",
    );
    expect(NodeFS.statSync(NodePath.join(target, studio, "empty/inside")).isDirectory()).toBe(true);
  }, 120_000);
});
