// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  applyBundle,
  applyCheckpointToWorktree,
  availableBranch,
  BundleError,
  copyRequiredFiles,
  createBundle,
  incomingRef,
  knownCommits,
  missingFiles,
  negotiationCandidates,
  pinCommit,
  repositoryPathFor,
  resolveRepositoryPath,
} from "./bundleGit.ts";
import { writeCheckpoint } from "./checkpointGit.ts";

const temporary: Array<string> = [];
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
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
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

function directory(): string {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-bundle-test-")),
  );
  temporary.push(base);
  return base;
}

/** A source repository and a destination clone of it, sharing history. */
function pair() {
  const source = directory();
  git(source, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(source, ".gitignore"), ".env.local\n");
  NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 1;\n");
  NodeFS.writeFileSync(NodePath.join(source, "gone.ts"), "old\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "one");
  const destination = NodePath.join(directory(), "dest");
  git(NodePath.dirname(destination), "clone", "-q", source, destination);
  NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 2;\n");
  git(source, "commit", "-q", "-am", "two");
  return { source, destination };
}

afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

describe("bundleGit", () => {
  it("replicates only what the destination lacks and materializes the checkpoint as changes", async () => {
    const { source, destination } = pair();
    NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 3;\n");
    NodeFS.writeFileSync(NodePath.join(source, "new.ts"), "export {};\n");
    NodeFS.rmSync(NodePath.join(source, "gone.ts"));
    NodeFS.writeFileSync(NodePath.join(source, ".env.local"), "TOKEN=source\n");
    const checkpoint = await writeCheckpoint({ cwd: source, threadId: "thread-a" });

    const candidates = await negotiationCandidates(source, checkpoint.baseCommit);
    expect(candidates[0]).toBe(checkpoint.baseCommit);
    const known = await knownCommits(destination, [checkpoint.commit, ...candidates]);
    expect(known).not.toContain(checkpoint.commit);
    expect(known).not.toContain(checkpoint.baseCommit);
    expect(known.length).toBeGreaterThan(0);

    const bundle = await createBundle({
      root: source,
      ref: checkpoint.ref,
      commit: checkpoint.commit,
      exclude: known,
    });
    const target = incomingRef("env-source", "thread-a");
    try {
      await applyBundle({
        root: destination,
        bundlePath: bundle.path,
        commit: checkpoint.commit,
        targetRef: target,
      });
    } finally {
      await bundle.dispose();
    }
    expect(git(destination, "rev-parse", target)).toBe(checkpoint.commit);
    expect(NodeFS.existsSync(bundle.path)).toBe(false);

    NodeFS.writeFileSync(NodePath.join(destination, ".env.local"), "TOKEN=destination\n");
    expect(await missingFiles(destination, [".env.local", "../escape", ".git/config"])).toEqual([
      "../escape",
      ".git/config",
    ]);
    const branch = await availableBranch({
      root: destination,
      branch: checkpoint.branch,
      sourceLabel: "Anton's MacBook Pro",
      sourceThreadId: "thread-a",
    });
    expect(branch).toBe("main-from-anton-s-macbook-pro");
    const worktree = NodePath.join(directory(), "wt");
    git(destination, "worktree", "add", "-q", "-b", branch, worktree, checkpoint.baseCommit);
    await applyCheckpointToWorktree({
      worktreePath: worktree,
      baseCommit: checkpoint.baseCommit,
      checkpointCommit: checkpoint.commit,
    });
    const copied = await copyRequiredFiles({
      fromRoot: destination,
      toRoot: worktree,
      paths: [".env.local", "missing.env"],
    });

    expect(copied).toEqual({ copied: [".env.local"], missing: ["missing.env"] });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(checkpoint.baseCommit);
    expect(NodeFS.readFileSync(NodePath.join(worktree, "app.ts"), "utf8")).toBe(
      "export const a = 3;\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(worktree, ".env.local"), "utf8")).toBe(
      "TOKEN=destination\n",
    );
    const status = NodeChildProcess.execFileSync(
      "git",
      ["-C", worktree, "status", "--porcelain=v1"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(status.split("\n").filter(Boolean).toSorted()).toEqual([
      " D gone.ts",
      " M app.ts",
      "?? new.ts",
    ]);
    expect(git(worktree, "diff", "--cached")).toBe("");
  });

  it("refuses a bundle whose base the destination lacks and pins a commit it already has", async () => {
    const { source, destination } = pair();
    NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 4;\n");
    const checkpoint = await writeCheckpoint({ cwd: source, threadId: "thread-b" });
    const lean = await createBundle({
      root: source,
      ref: checkpoint.ref,
      commit: checkpoint.commit,
      exclude: [checkpoint.baseCommit],
    });
    const target = incomingRef("env-source", "thread-b");
    try {
      await expect(
        applyBundle({
          root: destination,
          bundlePath: lean.path,
          commit: checkpoint.commit,
          targetRef: target,
        }),
      ).rejects.toMatchObject({ code: "missing_prerequisites" });
    } finally {
      await lean.dispose();
    }

    await expect(
      pinCommit({ root: destination, commit: checkpoint.commit, targetRef: target }),
    ).rejects.toBeInstanceOf(BundleError);
    await pinCommit({ root: source, commit: checkpoint.commit, targetRef: target });
    expect(git(source, "rev-parse", target)).toBe(checkpoint.commit);
  });

  it("caps the bundle size and never names a taken branch", async () => {
    const { source } = pair();
    const checkpoint = await writeCheckpoint({ cwd: source, threadId: "thread-c" });
    await expect(
      createBundle({
        root: source,
        ref: checkpoint.ref,
        commit: checkpoint.commit,
        exclude: [],
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      createBundle({ root: source, ref: checkpoint.ref, commit: "0".repeat(40), exclude: [] }),
    ).rejects.toMatchObject({ code: "mismatch" });

    git(source, "branch", "feature");
    git(source, "branch", "feature-from-mini");
    expect(
      await availableBranch({
        root: source,
        branch: "feature",
        sourceLabel: "Mini",
        sourceThreadId: "t",
      }),
    ).toBe("feature-from-mini-2");
    expect(
      await availableBranch({
        root: source,
        branch: "fresh",
        sourceLabel: "Mini",
        sourceThreadId: "t",
      }),
    ).toBe("fresh");
    expect(
      await availableBranch({
        root: source,
        branch: null,
        sourceLabel: "Mini",
        sourceThreadId: "t-9",
      }),
    ).toBe("handoff/t-9-from-mini");
    const ref = incomingRef("env/../x", "thread:project:p:1");
    expect(ref.split("/")).toHaveLength(5);
    expect(NodeChildProcess.spawnSync("git", ["check-ref-format", ref]).status).toBe(0);
  });

  it("maps a thread's repository, worktree or nested checkout, under its project folder", async () => {
    const umbrella = directory();
    const nested = NodePath.join(umbrella, "repositories", "app");
    NodeFS.mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(nested, "a.ts"), "1\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-q", "-m", "one");
    const worktree = NodePath.join(directory(), "wt");
    git(nested, "worktree", "add", "-q", "-b", "feature", worktree);

    expect(await repositoryPathFor(nested, nested)).toBe("");
    expect(await repositoryPathFor(nested, worktree)).toBe("");
    expect(await repositoryPathFor(umbrella, worktree)).toBe("repositories/app");
    const inside = NodePath.join(nested, "packages");
    NodeFS.mkdirSync(inside);
    expect(await repositoryPathFor(inside, nested)).toBe("..");
    const elsewhere = directory();
    await expect(repositoryPathFor(elsewhere, nested)).rejects.toThrow(
      "outside its project folder",
    );

    expect(await resolveRepositoryPath(umbrella, "repositories/app")).toBe(nested);
    expect(await resolveRepositoryPath(inside, "..")).toBe(nested);
    for (const bad of ["../x", "/etc", "repositories/../..", "repositories/app/.git"]) {
      await expect(resolveRepositoryPath(umbrella, bad)).rejects.toBeInstanceOf(BundleError);
    }
    await expect(resolveRepositoryPath(umbrella, "repositories")).rejects.toThrow(
      "not a Git repository",
    );
  });
});
