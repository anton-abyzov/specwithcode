// @effect-diagnostics nodeBuiltinImport:off - disposable folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { applyPlan, type ApplyInput } from "./apply.ts";
import { git } from "./folderFixture.testkit.ts";
import type { FileAction, GitStep, Plan } from "./reconcile.ts";
import { previewUndo } from "./undo.ts";

let base: string;
let counter = 0;

beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-unstable-")));
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

/**
 * The destination holds its own `repo/README.md` in a plain folder; the source's
 * `repo` is a repository whose README changed while copying, so it is unstable.
 */
async function applyUnstable(action: (path: string) => FileAction, ownFile: boolean) {
  const root = NodePath.join(base, `case-${(counter += 1)}`);
  const source = NodePath.join(root, "source");
  const target = NodePath.join(root, "target");
  NodeFS.mkdirSync(source, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(target, "repo"), { recursive: true });
  git(source, "init", "-q");
  git(source, "config", "user.email", "x@example.com");
  git(source, "config", "user.name", "x");
  NodeFS.writeFileSync(NodePath.join(source, "README.md"), "snapshot\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "c");
  const head = git(source, "rev-parse", "HEAD");
  NodeFS.cpSync(NodePath.join(source, ".git"), NodePath.join(target, "repo", ".git"), {
    recursive: true,
  });
  if (ownFile) NodeFS.writeFileSync(NodePath.join(target, "repo", "README.md"), "DESTINATION\n");
  const state = NodePath.join(root, "state");
  NodeFS.mkdirSync(NodePath.join(state, "staging"), { recursive: true });
  const step = {
    repo: "repo",
    row: "r",
    kind: "copy",
    sourceHead: head,
    sourceBranch: "main",
    identity: null,
    origin: null,
    sourceBranches: {},
    sourceStashCount: 0,
    fetch: false,
    moveHead: "none",
    stashDestination: false,
    importBranches: false,
    importPrefix: "",
  } as unknown as GitStep;
  const input: ApplyInput = {
    operationId: `op-${counter}`,
    targetRoot: target,
    stagingRoot: NodePath.join(state, "staging"),
    backupRoot: NodePath.join(state, "backups"),
    journalFile: NodePath.join(state, "journal.ndjson"),
    plan: { git: [step], actions: [action("repo/README.md")] } as unknown as Plan,
    sourceRepositories: [
      {
        path: "repo",
        kind: "main",
        head,
        branch: "main",
        branches: {},
        stash: [],
        stashCount: 0,
        status: [],
        worktrees: [],
        mainRepository: null,
      },
    ] as unknown as ApplyInput["sourceRepositories"],
    leftBehind: new Set(),
    unstable: new Set(["repo/README.md"]),
  };
  const result = await applyPlan(input);
  return { result, target, input };
}

const entry = { path: "repo/README.md", type: "file", size: 9, sha256: "x", class: "tracked" };

describe("Apply restores unstable files without touching the destination's own", () => {
  it("keeps the destination's own file under keep-both", async () => {
    const { result, target } = await applyUnstable(
      (path) =>
        ({
          path,
          kind: "keep-both",
          entry: { ...entry, repo: "repo" },
          replaces: false,
          localSource: null,
          row: "r",
          writePath: "repo/README.from-m4.md",
        }) as unknown as FileAction,
      true,
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "repo", "README.md"), "utf8")).toBe(
      "DESTINATION\n",
    );
    expect(result.restored).not.toContain("repo/README.md");
  });

  it("keeps the destination's own file under take-theirs, so Undo has nothing to remove", async () => {
    const { result, target, input } = await applyUnstable(
      (path) =>
        ({
          path,
          kind: "write",
          entry: { ...entry, repo: "repo" },
          replaces: true,
          localSource: null,
          row: "r",
          writePath: path,
        }) as unknown as FileAction,
      true,
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "repo", "README.md"), "utf8")).toBe(
      "DESTINATION\n",
    );
    expect(result.restored).not.toContain("repo/README.md");
    const preview = await previewUndo({ targetRoot: target, journalFile: input.journalFile });
    expect(preview.items.map((item) => item.path)).not.toContain("repo/README.md");
  });

  it("still restores the snapshot version where the destination had nothing", async () => {
    const { result, target } = await applyUnstable(
      (path) =>
        ({
          path,
          kind: "write",
          entry: { ...entry, repo: "repo" },
          replaces: false,
          localSource: null,
          row: "r",
          writePath: path,
        }) as unknown as FileAction,
      false,
    );
    expect(NodeFS.readFileSync(NodePath.join(target, "repo", "README.md"), "utf8")).toBe(
      "snapshot\n",
    );
    expect(result.restored).toContain("repo/README.md");
  });
});
