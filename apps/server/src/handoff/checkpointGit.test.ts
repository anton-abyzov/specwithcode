// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { CheckpointError, handoffRef, writeCheckpoint } from "./checkpointGit.ts";

const temporary: Array<string> = [];
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

function directory(): string {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-checkpoint-test-")),
  );
  temporary.push(base);
  return base;
}

function repository(): string {
  const root = directory();
  git(root, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "build/\n");
  NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "one\n");
  NodeFS.writeFileSync(NodePath.join(root, "staged.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const files = (root: string, commit: string) =>
  git(root, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);

afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

describe("writeCheckpoint", () => {
  it("snapshots the worktree on a hidden ref without touching HEAD, the index or the files", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "two\n");
    NodeFS.writeFileSync(NodePath.join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    NodeFS.writeFileSync(NodePath.join(root, "new.ts"), "export {};\n");
    NodeFS.writeFileSync(NodePath.join(root, ".env"), "TOKEN=secret\n");
    NodeFS.mkdirSync(NodePath.join(root, "build"));
    NodeFS.writeFileSync(NodePath.join(root, "build", "out.js"), "ignored\n");

    const head = git(root, "rev-parse", "HEAD");
    const status = git(root, "status", "--porcelain=v1", "-uall");
    const cached = git(root, "diff", "--cached");

    const checkpoint = await writeCheckpoint({ cwd: root, threadId: "thread-1" });

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain=v1", "-uall")).toBe(status);
    expect(git(root, "diff", "--cached")).toBe(cached);
    expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");

    expect(checkpoint).toMatchObject({
      root,
      baseCommit: head,
      branch: "main",
      ref: "refs/specwithcode/handoff/thread-1",
      excludedSecretCount: 1,
      changed: true,
    });
    expect(git(root, "rev-parse", checkpoint.ref)).toBe(checkpoint.commit);
    expect(git(root, "rev-parse", `${checkpoint.commit}^1`)).toBe(head);
    expect(files(root, checkpoint.commit).toSorted()).toEqual([
      ".gitignore",
      "new.ts",
      "staged.txt",
      "tracked.txt",
    ]);
    expect(git(root, "show", `${checkpoint.commit}:tracked.txt`)).toBe("two");
    expect(git(root, "show", `${checkpoint.commit}:staged.txt`)).toBe("staged");
    expect(checkpoint.requiredSecretPaths).toEqual([".env"]);
  });

  it("lists ignored env files the destination needs, without their contents", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "build/\n.env.local\nnode_modules/\n");
    git(root, "commit", "-q", "-am", "ignore env");
    NodeFS.writeFileSync(NodePath.join(root, ".env.local"), "TOKEN=secret\n");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", "pkg", ".env"), "X=1\n");
    NodeFS.writeFileSync(NodePath.join(root, "notes.txt"), "plain\n");

    const checkpoint = await writeCheckpoint({ cwd: root, threadId: "thread-env" });

    expect(checkpoint.requiredSecretPaths).toEqual([".env.local"]);
    expect(checkpoint.excludedSecretCount).toBe(0);
    expect(files(root, checkpoint.commit)).not.toContain(".env.local");
  });

  it("keeps the previous checkpoint when nothing changed and writes a new one when it did", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "two\n");
    const first = await writeCheckpoint({ cwd: root, threadId: "thread-1" });
    const again = await writeCheckpoint({ cwd: root, threadId: "thread-1" });
    expect(again.changed).toBe(false);
    expect(again.commit).toBe(first.commit);

    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "three\n");
    const third = await writeCheckpoint({ cwd: root, threadId: "thread-1" });
    expect(third.changed).toBe(true);
    expect(third.commit).not.toBe(first.commit);
  });

  it("records a deleted tracked file as deleted", async () => {
    const root = repository();
    NodeFS.rmSync(NodePath.join(root, "staged.txt"));
    const checkpoint = await writeCheckpoint({ cwd: root, threadId: "thread-1" });
    expect(files(root, checkpoint.commit)).not.toContain("staged.txt");
    expect(git(root, "status", "--porcelain=v1")).toBe("D staged.txt");
  });

  it("records the commit on a detached HEAD without a branch", async () => {
    const root = repository();
    git(root, "checkout", "-q", "--detach");
    const checkpoint = await writeCheckpoint({ cwd: root, threadId: "thread-1" });
    expect(checkpoint.branch).toBeNull();
  });

  it("refuses a folder that is not a repository", async () => {
    const error = await writeCheckpoint({ cwd: directory(), threadId: "thread-1" }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(CheckpointError);
    expect((error as CheckpointError).code).toBe("not_a_repository");
  });

  it("refuses a repository without a commit", async () => {
    const root = directory();
    git(root, "init", "-q");
    const error = await writeCheckpoint({ cwd: root, threadId: "thread-1" }).catch(
      (cause: unknown) => cause,
    );
    expect((error as CheckpointError).code).toBe("no_commit");
  });
});

describe("handoffRef", () => {
  const validRef = (ref: string) =>
    NodeChildProcess.spawnSync("git", ["check-ref-format", ref]).status === 0;

  it("keeps a plain id and maps any other id to a valid, distinct ref", () => {
    expect(handoffRef("thread_1.a-b")).toBe("refs/specwithcode/handoff/thread_1.a-b");
    const real = [
      "thread:project:project%3A1:0b9f1c2e-7d4a-4c1e-9f61-2b0a7c8d9e10",
      "thread:project:project%3A1:0b9f1c2e-7d4a-4c1e-9f61-2b0a7c8d9e11",
      "../main",
      "..",
      "thread.lock",
      "a b",
      "x".repeat(300),
    ];
    const refs = real.map(handoffRef);
    for (const ref of refs) {
      expect(ref.startsWith("refs/specwithcode/handoff/")).toBe(true);
      expect(ref.slice("refs/specwithcode/handoff/".length)).not.toContain("/");
      expect(validRef(ref)).toBe(true);
    }
    expect(new Set(refs).size).toBe(refs.length);
    expect(handoffRef(real[0]!)).toBe(refs[0]);
  });
});
