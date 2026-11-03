// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fetchOrigin,
  foldersOverlap,
  leftBehindOf,
  projectRepositories,
  repositoriesOf,
  repositorySyncNotice,
  syncRepositories,
  syncRepository,
  startCatchUp,
} from "./repositorySync.ts";

let base: string;
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const write = (cwd: string, name: string, text: string) =>
  NodeFS.writeFileSync(NodePath.join(cwd, name), text);
const free = async () => false;

/** A bare origin with one commit, a clone to sync, and a second clone that pushes more. */
function repository(name = "repo") {
  const origin = NodePath.join(base, `${name}.git`);
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const clone = NodePath.join(base, name);
  git(base, "clone", "--quiet", origin, clone);
  git(clone, "switch", "--quiet", "-c", "main");
  write(clone, "a.txt", "one\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "first");
  git(clone, "push", "--quiet", "-u", "origin", "main");
  const other = NodePath.join(base, `${name}-other`);
  git(base, "clone", "--quiet", origin, other);
  return {
    origin,
    clone,
    push: (text = "two\n") => {
      write(other, "b.txt", text);
      git(other, "add", ".");
      git(other, "commit", "--quiet", "-m", "more");
      git(other, "push", "--quiet", "origin", "main");
    },
  };
}

beforeEach(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-repo-sync-")));
});
afterEach(() => NodeFS.rmSync(base, { recursive: true, force: true }));

it("fetches a clean checkout without changing its branch, index or files", async () => {
  const { clone, push } = repository();
  const before = git(clone, "rev-parse", "HEAD");
  const index = git(clone, "write-tree");
  push();
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({
    kind: "behind",
    commits: 1,
  });
  expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  expect(git(clone, "write-tree")).toBe(index);
  expect(NodeFS.existsSync(NodePath.join(clone, "b.txt"))).toBe(false);
  expect(git(clone, "rev-list", "--count", "HEAD..origin/main")).toBe("1");
});

it("says nothing when the checkout is already current", async () => {
  const { clone } = repository();
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({ kind: "current" });
  expect(
    repositorySyncNotice([{ path: clone, name: "repo", outcome: { kind: "current" } }]),
  ).toBeNull();
});

it("fetches a dirty checkout but leaves its files, HEAD and index alone", async () => {
  const { clone, push } = repository();
  push();
  write(clone, "a.txt", "my edit\n");
  write(clone, "new.txt", "untracked\n");
  const head = git(clone, "rev-parse", "HEAD");
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({
    kind: "uncommitted",
    changes: 2,
  });
  expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  expect(NodeFS.readFileSync(NodePath.join(clone, "a.txt"), "utf8")).toBe("my edit\n");
  expect(NodeFS.existsSync(NodePath.join(clone, "b.txt"))).toBe(false);
  // The fetch itself still happened, so a new worktree can start from fresh origin.
  expect(git(clone, "rev-list", "--count", "HEAD..origin/main")).toBe("1");
});

it("leaves another branch alone and names it", async () => {
  const { clone, push } = repository();
  git(clone, "switch", "--quiet", "-c", "feature");
  push();
  const head = git(clone, "rev-parse", "HEAD");
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({
    kind: "other-branch",
    branch: "feature",
    main: "main",
  });
  expect(git(clone, "rev-parse", "HEAD")).toBe(head);
});

it("never merges diverged work", async () => {
  const { clone, push } = repository();
  push();
  write(clone, "mine.txt", "local\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "mine");
  const head = git(clone, "rev-parse", "HEAD");
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({
    kind: "diverged",
    ahead: 1,
    behind: 1,
  });
  expect(git(clone, "rev-parse", "HEAD")).toBe(head);
});

it("leaves a checkout another running thread works in", async () => {
  const { clone, push } = repository();
  push();
  const head = git(clone, "rev-parse", "HEAD");
  expect(await syncRepository({ path: clone, inUse: async () => true })).toEqual({
    kind: "in-use",
  });
  expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  expect(await foldersOverlap(clone, [NodePath.join(clone, "sub")])).toBe(true);
  expect(await foldersOverlap(clone, [base])).toBe(true);
  expect(await foldersOverlap(clone, [NodePath.join(base, "elsewhere")])).toBe(false);
});

it("reports an unreachable origin instead of failing", async () => {
  const { clone } = repository();
  git(clone, "remote", "set-url", "origin", NodePath.join(base, "gone.git"));
  expect(await syncRepository({ path: clone, inUse: free })).toEqual({ kind: "unreachable" });
  expect(await fetchOrigin(clone)).toBeNull();
});

it("keeps quiet about a repository with no remote", async () => {
  const folder = NodePath.join(base, "plain");
  NodeFS.mkdirSync(folder);
  git(folder, "init", "--quiet");
  expect(await syncRepository({ path: folder, inUse: free })).toEqual({ kind: "no-remote" });
});

it("finds nested repositories, skips linked worktrees, and shares a recent fetch", async () => {
  const first = repository("one");
  const nested = NodePath.join(first.clone, "repositories", "owner", "two");
  NodeFS.mkdirSync(NodePath.dirname(nested), { recursive: true });
  const second = repository("two");
  git(base, "clone", "--quiet", second.origin, nested);
  const linked = NodePath.join(base, "linked");
  git(second.clone, "worktree", "add", "--quiet", "-b", "side", linked);
  const found = await repositoriesOf(first.clone, [second.clone, linked]);
  expect([...found].sort()).toEqual([first.clone, nested, second.clone].sort());

  second.push();
  const results = await syncRepositories({ paths: [nested], inUse: free });
  expect(results[0]?.outcome).toEqual({ kind: "behind", commits: 1 });
  second.push("three\n");
  // Moments later a second thread reuses that fetch.
  const again = await syncRepositories({ paths: [nested], inUse: free });
  expect(again[0]?.outcome).toEqual({ kind: "behind", commits: 1 });
});

it("writes one short plain line per thing it did", () => {
  const notice = repositorySyncNotice([
    { path: "/a", name: "a", outcome: { kind: "behind", commits: 3 } },
    { path: "/b", name: "b", outcome: { kind: "uncommitted", changes: 2 } },
    { path: "/c", name: "c", outcome: { kind: "other-branch", branch: "fix/x", main: "main" } },
    { path: "/d", name: "d", outcome: { kind: "unreachable" } },
    { path: "/e", name: "e", outcome: { kind: "current" } },
  ]);
  expect(notice?.message).toBe(
    [
      "Didn't update a: origin has 3 new commits. Pull when you are ready.",
      "Didn't update b: it has 2 uncommitted changes.",
      "Didn't update c: it's on fix/x, not main.",
      "Didn't update d: this machine can't reach its origin.",
    ].join("\n"),
  );
});

it("lists what would stay on this machine, without the network", async () => {
  const { clone, origin } = repository();
  git(clone, "switch", "--quiet", "-c", "local-only");
  git(clone, "switch", "--quiet", "main");
  write(clone, "mine.txt", "local\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "mine");
  write(clone, "edit.txt", "dirty\n");
  NodeFS.rmSync(origin, { recursive: true, force: true });
  expect(await leftBehindOf([clone])).toEqual([
    {
      name: "repo",
      path: clone,
      branch: "main",
      unpushedCommits: 1,
      uncommittedChanges: 1,
      branchesAhead: 0,
      branchesWithoutUpstream: 1,
    },
  ]);
});

it("omits a repository with nothing left behind", async () => {
  const { clone } = repository();
  expect(await leftBehindOf([clone])).toEqual([]);
});

it("leaves both branch tips alone when another Git client switches during sync", async () => {
  const { clone, push } = repository();
  git(clone, "branch", "feature");
  const before = git(clone, "rev-parse", "main");
  push();
  await syncRepository({
    path: clone,
    inUse: async () => {
      git(clone, "switch", "feature");
      return false;
    },
  });
  expect(git(clone, "branch", "--show-current")).toBe("feature");
  expect(git(clone, "rev-parse", "main")).toBe(before);
  expect(git(clone, "rev-parse", "feature")).toBe(before);
  expect(git(clone, "status", "--porcelain")).toBe("");
});

it("ignores a configured fetch mapping into a local branch", async () => {
  const { clone, push } = repository();
  git(clone, "branch", "feature");
  const before = git(clone, "rev-parse", "feature");
  git(clone, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/feature");
  push();
  expect(await fetchOrigin(clone)).not.toBeNull();
  expect(git(clone, "rev-parse", "feature")).toBe(before);
  expect(git(clone, "rev-list", "--count", "HEAD..origin/main")).toBe("1");
});

it("lists uncommitted work in a worktree, which a move would leave behind", async () => {
  const { clone } = repository();
  const worktree = NodePath.join(base, "worker");
  git(clone, "worktree", "add", "--quiet", "-b", "worker", worktree);
  write(worktree, "note.txt", "unsaved\n");
  const found = await leftBehindOf([clone]);
  expect(found.find((entry) => entry.name === "repo worktree worker")).toMatchObject({
    uncommittedChanges: 1,
  });
});

it("still reads the rest when a worktree's folder is gone", async () => {
  const { clone } = repository();
  const gone = NodePath.join(base, "gone");
  git(clone, "worktree", "add", "--quiet", "-b", "gone", gone);
  NodeFS.rmSync(gone, { recursive: true });
  write(clone, "note.txt", "unsaved\n");
  const found = await leftBehindOf([clone]);
  expect(found.map((entry) => entry.name)).toEqual(["repo"]);
});

it("keeps a clean worktree off the list when the repository has local branches", async () => {
  const { clone } = repository();
  const worktree = NodePath.join(base, "tidy");
  git(clone, "worktree", "add", "--quiet", "--detach", worktree);
  git(worktree, "switch", "--quiet", "-c", "tidy", "--track", "origin/main");
  git(clone, "branch", "local-only");
  const names = (await leftBehindOf([clone])).map((entry) => entry.name);
  expect(names).not.toContain("repo worktree tidy");
  expect(names).toContain("repo");
});

it("finds an environment repository kept in the project's own managed folder", async () => {
  const { clone, origin } = repository();
  const managed = NodePath.join(clone, ".studio-repositories", "extra");
  NodeFS.mkdirSync(NodePath.dirname(managed));
  git(base, "clone", "--quiet", origin, managed);
  const found = await projectRepositories({
    workspaceRoot: clone,
    workspaceSettings: { environment: { repositories: [{ id: "extra", localPath: null }] } },
  });
  expect(found).toContain(managed);
  // The folder of managed clones isn't uncommitted work in the checkout holding it.
  expect(await leftBehindOf([clone])).toEqual([]);
});

it("doesn't call a detached checkout unpushed when origin has its commit", async () => {
  const { clone } = repository();
  git(clone, "switch", "--quiet", "--detach");
  expect(await leftBehindOf([clone])).toEqual([]);
});

it("counts a worktree's unpushed branch on its row, not again on the repository's", async () => {
  const { clone } = repository();
  git(clone, "worktree", "add", "--quiet", "-b", "worker", NodePath.join(base, "worker"));
  const found = await leftBehindOf([clone]);
  expect(found.map((entry) => entry.name)).toEqual(["repo worktree worker"]);
});

it("falls back to the HTTPS address when an SSH origin fails, without changing the remote", async () => {
  const { clone, origin } = repository();
  const ssh = "git@example.invalid:owner/repo.git";
  git(clone, "remote", "set-url", "origin", ssh);
  const before = git(clone, "rev-parse", "origin/main");
  const other = NodePath.join(base, "pusher");
  git(base, "clone", "--quiet", origin, other);
  write(other, "c.txt", "three\n");
  git(other, "add", ".");
  git(other, "commit", "--quiet", "-m", "more");
  git(other, "push", "--quiet", "origin", "main");
  const saved = { ...process.env };
  // The HTTPS form of the origin resolves to the local bare repository here.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${origin}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://example.invalid/owner/repo.git";
  process.env.GIT_SSH_COMMAND = "false";
  try {
    await fetchOrigin(clone);
  } finally {
    for (const key of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_SSH_COMMAND",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
  expect(git(clone, "rev-parse", "origin/main")).not.toBe(before);
  expect(git(clone, "remote", "get-url", "origin")).toBe(ssh);
});

describe("startCatchUp", () => {
  const path = "/repositories/too-large";
  it("runs one fetch at a time, and waits after a failure before another", async () => {
    let at = 1_000;
    const now = () => at;
    const finish: Array<(address: string | null) => void> = [];
    const fetch = vi.fn(() => new Promise<string | null>((resolve) => void finish.push(resolve)));
    startCatchUp(path, now, fetch);
    startCatchUp(path, now, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish[0]!(null);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    startCatchUp(path, now, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    at += 11 * 60_000;
    startCatchUp(path, now, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish[1]!("origin");
  });
});
