// @effect-diagnostics nodeBuiltinImport:off - disposable real folders and Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { git, write } from "./folderFixture.testkit.ts";
import { FolderScanError, isScanStopped, scanFolder } from "./manifest.ts";

// Pass-through spies: the rebuildable test proves no file below the folder is stat'ed.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const tempRoot = (prefix: string) => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  roots.push(root);
  return root;
};

const calledBelow = (spy: unknown, folder: string) =>
  (spy as { mock: { calls: Array<Array<unknown>> } }).mock.calls
    .map((call) => String(call[0]))
    .filter((path) => path.startsWith(`${folder}${NodePath.sep}`));

describe("rebuildable folders", () => {
  it("records a folder of 5000 dependency files without listing or stat'ing them", async () => {
    const root = tempRoot("swc-scan-rebuildable-");
    write(NodePath.join(root, "src/index.ts"), "export {};\n");
    const modules = NodePath.join(root, "node_modules");
    for (let pkg = 0; pkg < 50; pkg += 1)
      for (let file = 0; file < 100; file += 1)
        write(NodePath.join(modules, `pkg-${pkg}`, `file-${file}.js`), "module.exports = 1;\n");
    vi.mocked(NodeFSP.lstat).mockClear();
    vi.mocked(NodeFSP.readdir).mockClear();

    const scan = await scanFolder(root);

    // Only the probe for a nested repository's `.git` looks inside the folder.
    expect(calledBelow(NodeFSP.lstat, modules)).toEqual([NodePath.join(modules, ".git")]);
    expect(calledBelow(NodeFSP.readdir, modules)).toEqual([]);
    expect(vi.mocked(NodeFSP.readdir).mock.calls.map((call) => String(call[0]))).not.toContain(
      modules,
    );
    expect(scan.entries.find((entry) => entry.path === "node_modules")).toMatchObject({
      type: "directory",
      class: "rebuildable",
      size: 0,
      collapsed: { files: 0 },
    });
    expect(scan.entries.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
    expect(scan.totals.rebuildable).toEqual({ files: 0, bytes: 0 });
    expect(scan.skipped).toEqual({ rebuildableFolders: 1, worktrees: [] });

    // Selecting rebuildable files still lists every one of them.
    const exact = await scanFolder(root, { expandRebuildable: true });
    expect(exact.totals.rebuildable.files).toBe(5000);
    expect(exact.skipped?.rebuildableFolders).toBe(0);
  }, 60_000);
});

/**
 * root/
 *   a-sibling/            worktree of b-main, walked before it
 *   b-main/               main repository
 *     .worktrees/one/     worktree inside the main checkout, not ignored there
 * outside/                worktree of b-main outside root
 */
function worktreeFixture() {
  const base = tempRoot("swc-scan-worktrees-");
  const root = NodePath.join(base, "root");
  const main = NodePath.join(root, "b-main");
  NodeFS.mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  write(NodePath.join(main, "file.txt"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-qb", "nested", NodePath.join(main, ".worktrees/one"));
  git(main, "worktree", "add", "-qb", "sibling", NodePath.join(root, "a-sibling"));
  git(main, "worktree", "add", "-qb", "elsewhere", NodePath.join(base, "outside"));
  for (const tree of [NodePath.join(main, ".worktrees/one"), NodePath.join(root, "a-sibling")]) {
    write(NodePath.join(tree, "file.txt"), "uncommitted\n");
    write(NodePath.join(tree, "new.txt"), "untracked\n");
  }
  write(NodePath.join(NodePath.join(root, "a-sibling"), "branch.txt"), "committed\n");
  git(NodePath.join(root, "a-sibling"), "add", "branch.txt");
  git(NodePath.join(root, "a-sibling"), "commit", "-qm", "sibling work");
  return { base, root, main };
}

describe("linked worktrees inside the folder", () => {
  it("skips worktrees of a repository inside the folder and drops their registrations", async () => {
    const { root, main } = worktreeFixture();
    // Unignored, the main checkout's own status names its worktree folder.
    expect(git(main, "status", "--porcelain")).toContain(".worktrees/");

    const scan = await scanFolder(root);

    expect(scan.repositories.map((repo) => repo.path)).toEqual(["b-main"]);
    expect(scan.skipped?.worktrees).toEqual(["a-sibling", "b-main/.worktrees/one"]);
    for (const skipped of ["a-sibling", "b-main/.worktrees/one"])
      expect(
        scan.entries.filter(
          (entry) => entry.path === skipped || entry.path.startsWith(`${skipped}/`),
        ),
      ).toEqual([]);
    const repository = scan.repositories[0]!;
    // Their branches travel with the main repository's refs.
    expect(repository.branches.nested).toBe(git(main, "rev-parse", "nested"));
    expect(repository.branches.sibling).toBe(git(main, "rev-parse", "sibling"));
    expect(
      scan.entries.find((entry) => entry.path === "b-main/.git/refs/heads/sibling"),
    ).toBeDefined();
    // No registration of a skipped worktree reaches the destination; the one
    // outside the folder keeps today's handling (dropped when the snapshot is made).
    const registrations = scan.entries
      .filter((entry) => /^b-main\/\.git\/worktrees\/[^/]+$/.test(entry.path))
      .map((entry) => entry.path);
    expect(registrations).toEqual(["b-main/.git/worktrees/outside"]);
    expect(repository.worktrees).toEqual([{ path: null, name: "outside" }]);
    expect(repository.status.some((line) => line.includes(".worktrees"))).toBe(false);
    const notices = scan.notices?.join("\n") ?? "";
    expect(notices).toContain(
      "2 linked worktree(s) inside this folder are not copied: a-sibling, b-main/.worktrees/one.",
    );
    expect(notices).toContain("uncommitted changes in them stay on this machine");
    expect(notices).toContain("outside this folder are not copied: outside");
    // Both skipped worktrees hold uncommitted work; the notice says so, first.
    expect(scan.skipped?.dirtyWorktrees).toEqual(["a-sibling", "b-main/.worktrees/one"]);
    expect(scan.skipped?.uncheckedWorktrees).toEqual([]);
    expect(scan.notices?.[0]).toContain(
      "2 of them have uncommitted changes that stay on this machine: a-sibling, b-main/.worktrees/one.",
    );
  });

  it("reports clean worktrees as clean and a check that cannot run as unchecked", async () => {
    const { root, main } = worktreeFixture();
    git(NodePath.join(root, "a-sibling"), "checkout", "-q", "--", "file.txt");
    NodeFS.rmSync(NodePath.join(root, "a-sibling", "new.txt"));
    const scan = await scanFolder(root);
    expect(scan.skipped?.dirtyWorktrees).toEqual(["b-main/.worktrees/one"]);
    expect(scan.notices?.[0]).toContain(
      "1 of them have uncommitted changes that stay on this machine: b-main/.worktrees/one.",
    );
    // A corrupt index makes `git status` fail: unknown, never reported clean.
    NodeFS.writeFileSync(NodePath.join(main, ".git/worktrees/a-sibling/index"), "not an index");
    const failing = await scanFolder(root);
    expect(failing.skipped?.dirtyWorktrees).toEqual(["b-main/.worktrees/one"]);
    expect(failing.skipped?.uncheckedWorktrees).toEqual(["a-sibling"]);
    expect(failing.notices?.[0]).toContain(
      "1 could not be checked for uncommitted changes and may hold some: a-sibling.",
    );
  });

  it("flags skipped worktrees whose commits are on no branch or mid-rebase as stranded", async () => {
    const { root, main } = worktreeFixture();
    expect((await scanFolder(root)).skipped?.strandedWorktrees).toEqual([]);
    // Detached at a commit a branch contains: it travels with the branch.
    const sibling = NodePath.join(root, "a-sibling");
    git(sibling, "checkout", "-q", "--", "file.txt");
    NodeFS.rmSync(NodePath.join(sibling, "new.txt"));
    git(sibling, "checkout", "-q", "--detach");
    expect((await scanFolder(root)).skipped?.strandedWorktrees).toEqual([]);
    // A commit made on the detached HEAD is on no branch.
    write(NodePath.join(sibling, "detached.txt"), "detached\n");
    git(sibling, "add", "detached.txt");
    git(sibling, "commit", "-qm", "detached work");
    // A merge in progress in the other worktree.
    NodeFS.writeFileSync(
      NodePath.join(main, ".git/worktrees/one/MERGE_HEAD"),
      `${git(main, "rev-parse", "HEAD")}\n`,
    );
    const scan = await scanFolder(root);
    expect(scan.skipped?.strandedWorktrees).toEqual(["a-sibling", "b-main/.worktrees/one"]);
    expect(scan.notices?.[0]).toContain(
      "2 have commits on no branch that would not travel: a-sibling, b-main/.worktrees/one.",
    );
  });

  it.skipIf(process.platform === "win32")(
    "gives the stranded check's Git commands one shared deadline",
    async () => {
      const { root } = worktreeFixture();
      const sibling = NodePath.join(root, "a-sibling");
      git(sibling, "checkout", "-q", "--", "file.txt");
      NodeFS.rmSync(NodePath.join(sibling, "new.txt"));
      git(sibling, "checkout", "-q", "--detach");
      write(NodePath.join(sibling, "detached.txt"), "detached\n");
      git(sibling, "add", "detached.txt");
      git(sibling, "commit", "-qm", "detached work");
      // A Git whose HEAD lookups take 0.6 s: two of them fit one 1 s limit each, not one shared.
      const realGit = NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();
      const bin = tempRoot("swc-slow-git-");
      NodeFS.writeFileSync(
        NodePath.join(bin, "git"),
        `#!/bin/sh\ncase "$*" in *symbolic-ref*|*--contains*) sleep 0.6;; esac\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      const path = process.env.PATH;
      process.env.PATH = `${bin}${NodePath.delimiter}${path ?? ""}`;
      try {
        const scan = await scanFolder(root, { worktreeStatusTimeoutMs: 1_000 });
        expect(scan.skipped?.strandedWorktrees).toEqual([]);
        expect(scan.skipped?.uncheckedWorktrees).toEqual(["a-sibling"]);
      } finally {
        process.env.PATH = path;
      }
    },
    20_000,
  );

  it("keeps today's handling for a worktree whose main repository is outside the folder", async () => {
    const { root } = worktreeFixture();
    const scan = await scanFolder(NodePath.join(root, "a-sibling"));
    expect(scan.repositories).toHaveLength(1);
    expect(scan.repositories[0]).toMatchObject({
      path: ".",
      kind: "linked",
      branch: "sibling",
      mainRepository: null,
    });
    expect(scan.skipped?.worktrees).toEqual([]);
    expect(scan.entries.find((entry) => entry.path === "new.txt")?.class).toBe("untracked");
    expect(scan.entries.find((entry) => entry.path === ".git")?.class).toBe("repository");
  });
});

describe("progress and stopping", () => {
  it("reports files and bytes listed", async () => {
    const root = tempRoot("swc-scan-progress-");
    for (let index = 0; index < 30; index += 1)
      write(NodePath.join(root, `dir-${index % 3}`, `file-${index}.txt`), "x".repeat(index));
    const reports: Array<{ files: number; bytes: number }> = [];
    const scan = await scanFolder(root, { onProgress: (progress) => reports.push(progress) });
    expect(reports.length).toBeGreaterThan(0);
    const files = scan.entries.filter((entry) => entry.type === "file");
    expect(reports.at(-1)).toEqual({
      files: files.length,
      bytes: files.reduce((sum, entry) => sum + entry.size, 0),
    });
  });

  it("stops at the next folder once asked", async () => {
    const root = tempRoot("swc-scan-stop-");
    for (let index = 0; index < 20; index += 1)
      write(NodePath.join(root, `dir-${index}`, "nested", "file.txt"), "x\n");
    await expect(scanFolder(root, { shouldStop: () => true })).rejects.toSatisfy(isScanStopped);
    let checks = 0;
    const stopped = await scanFolder(root, {
      shouldStop: () => {
        checks += 1;
        return checks > 3;
      },
    }).catch((cause: unknown) => cause);
    expect(stopped).toBeInstanceOf(FolderScanError);
    expect((stopped as FolderScanError).reason).toBe("stopped");
    expect(checks).toBe(4);
  });
});
