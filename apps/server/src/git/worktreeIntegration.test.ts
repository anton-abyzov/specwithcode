// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real Git and native index bytes are the independent integration-test oracle.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { nodePath as NodePath } from "../nodePath.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real Git and native index bytes are the independent integration-test oracle.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { worktreeHasNoAdditionalChanges } from "./worktreeIntegration.ts";

type Executor = Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">;
const scratch: string[] = [];
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const executor: Executor = {
  execute: (input) =>
    Effect.sync(() => {
      const result = NodeChildProcess.spawnSync("git", input.args, {
        cwd: input.cwd,
        env: gitEnv,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return {
        exitCode: ChildProcessSpawner.ExitCode(result.status ?? 128),
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }),
};
function commit(cwd: string, name: string, content: string) {
  NodeFS.writeFileSync(NodePath.join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", `update ${name}`);
  return git(cwd, "rev-parse", "HEAD");
}
function repo() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-integration-"));
  scratch.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Integration Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "core.hooksPath", "/dev/null");
  commit(cwd, "base.txt", "base\n");
  git(cwd, "checkout", "-b", "feature");
  commit(cwd, "feature.txt", "first\n");
  const head = commit(cwd, "feature.txt", "second\n");
  git(cwd, "checkout", "main");
  return { cwd, head };
}
function check(cwd: string, head: string, base = git(cwd, "rev-parse", "main")) {
  return worktreeHasNoAdditionalChanges(executor, cwd, head, base);
}
afterEach(() => {
  for (const cwd of scratch.splice(0)) NodeFS.rmSync(cwd, { recursive: true, force: true });
});

describe("worktree integration proof with real Git", () => {
  it.effect(
    "recognizes squash integration after unrelated default-branch changes without changing checkout or index",
    () =>
      Effect.gen(function* () {
        const { cwd, head } = repo();
        git(cwd, "merge", "--squash", "feature");
        git(cwd, "commit", "-m", "squash feature");
        commit(cwd, "later.txt", "later\n");
        const base = git(cwd, "rev-parse", "HEAD");
        expect(
          NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", head, base], { cwd })
            .status,
        ).toBe(1);
        git(cwd, "checkout", "feature");
        const index = NodeFS.readFileSync(NodePath.join(cwd, ".git", "index"));
        expect(yield* check(cwd, head, base)).toBe(true);
        expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
        expect(NodeFS.readFileSync(NodePath.join(cwd, ".git", "index"))).toEqual(index);
        expect(NodeFS.readFileSync(NodePath.join(cwd, "feature.txt"), "utf8")).toBe("second\n");
        expect(git(cwd, "status", "--porcelain")).toBe("");
      }),
  );

  it.effect("recognizes rebase/cherry-pick integration with different commit identities", () =>
    Effect.gen(function* () {
      const { cwd, head } = repo();
      const first = git(cwd, "rev-parse", "feature~1");
      commit(cwd, "main-only.txt", "main\n");
      git(cwd, "cherry-pick", first, head);
      expect(yield* check(cwd, head)).toBe(true);
    }),
  );

  it.effect("retains a branch with new work after the squash merge", () =>
    Effect.gen(function* () {
      const { cwd } = repo();
      git(cwd, "merge", "--squash", "feature");
      git(cwd, "commit", "-m", "squash feature");
      git(cwd, "checkout", "feature");
      const head = commit(cwd, "new-work.txt", "not integrated\n");
      expect(yield* check(cwd, head)).toBe(false);
    }),
  );

  it.effect("retains an unmerged branch and does not accept only part of its changes", () =>
    Effect.gen(function* () {
      const { cwd, head } = repo();
      expect(yield* check(cwd, head)).toBe(false);
      git(cwd, "cherry-pick", "feature~1");
      expect(yield* check(cwd, head)).toBe(false);
    }),
  );

  it.effect(
    "retains conflict and reverted content rather than inferring integration from a past PR",
    () =>
      Effect.gen(function* () {
        const { cwd, head } = repo();
        commit(cwd, "feature.txt", "different implementation\n");
        expect(yield* check(cwd, head)).toBe(false);
      }),
  );

  it.effect("retains content removed again after a squash merge", () =>
    Effect.gen(function* () {
      const { cwd, head } = repo();
      git(cwd, "merge", "--squash", "feature");
      git(cwd, "commit", "-m", "squash feature");
      git(cwd, "revert", "--no-edit", "HEAD");
      expect(yield* check(cwd, head)).toBe(false);
    }),
  );

  it.effect("retains post-merge work when a custom driver could falsely report integration", () =>
    Effect.gen(function* () {
      const { cwd } = repo();
      git(cwd, "checkout", "feature");
      commit(cwd, ".gitattributes", "feature.txt merge=keep\n");
      git(cwd, "checkout", "main");
      git(cwd, "merge", "--squash", "feature");
      git(cwd, "commit", "-m", "squash feature");
      commit(cwd, "feature.txt", "later main work\n");
      git(cwd, "checkout", "feature");
      const head = commit(cwd, "feature.txt", "new unmerged work\n");
      git(cwd, "config", "merge.keep.driver", "true");
      const executed: string[][] = [];
      const watched: Executor = {
        execute: (input) => {
          executed.push([...input.args]);
          return executor.execute(input);
        },
      };
      expect(
        yield* worktreeHasNoAdditionalChanges(watched, cwd, head, git(cwd, "rev-parse", "main")),
      ).toBe(false);
      expect(executed.some((args) => args.includes("merge-tree"))).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(cwd, "feature.txt"), "utf8")).toBe(
        "new unmerged work\n",
      );
    }),
  );

  it.effect("fails closed for missing commits", () =>
    Effect.gen(function* () {
      const { cwd, head } = repo();
      expect(yield* check(cwd, head, "deadbeef")).toBe(false);
      expect(yield* check(cwd, "deadbeef")).toBe(false);
    }),
  );

  it.effect("fails closed for unsupported merge-tree and truncated output", () =>
    Effect.gen(function* () {
      const { cwd, head } = repo();
      const unsupported: Executor = {
        execute: (input) =>
          input.args.includes("merge-tree")
            ? Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(129),
                stdout: "",
                stderr: "unsupported",
                stdoutTruncated: false,
                stderrTruncated: false,
              })
            : executor.execute(input),
      };
      expect(yield* worktreeHasNoAdditionalChanges(unsupported, cwd, head, "main")).toBe(false);
      const truncated: Executor = {
        execute: (input) =>
          executor
            .execute(input)
            .pipe(Effect.map((result) => ({ ...result, stdoutTruncated: true }))),
      };
      expect(yield* worktreeHasNoAdditionalChanges(truncated, cwd, head, "main")).toBe(false);
    }),
  );
});
