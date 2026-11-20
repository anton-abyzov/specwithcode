import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { checkWorktreeRegistration } from "./worktreeRegistration.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-registration-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-reg-" }));
  const repo = path.join(root, "repo");
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  yield* fs.makeDirectory(repo);
  yield* run(repo, ["init", "-b", "main"]);
  yield* run(repo, ["config", "user.name", "Registration test"]);
  yield* run(repo, ["config", "user.email", "test@example.invalid"]);
  yield* fs.writeFileString(path.join(repo, "file.txt"), "committed\n");
  yield* run(repo, ["add", "."]);
  yield* run(repo, ["commit", "-m", "fixture"]);
  const addWorktree = (folder: string, branch: string) =>
    run(repo, ["worktree", "add", "-b", branch, folder]).pipe(Effect.as(folder));
  return { fs, path, run, root, repo, addWorktree };
});

describe("worktree registration", () => {
  it.layer(testLayer)("round trip", (it) => {
    it.effect("accepts a worktree whose registration names it back", () =>
      Effect.gen(function* () {
        const { fs, path, root, repo, addWorktree } = yield* fixture;
        const folder = yield* addWorktree(path.join(root, "worktrees", "feature"), "feature");
        const result = yield* checkWorktreeRegistration(folder);
        expect(result).toEqual({
          ok: true,
          gitDir: yield* fs.realPath(path.join(repo, ".git", "worktrees", "feature")),
          commonDir: yield* fs.realPath(path.join(repo, ".git")),
          repository: repo,
          locked: false,
        });
      }),
    );

    it.effect("accepts relative links in both directions and reports a locked worktree", () =>
      Effect.gen(function* () {
        const { fs, path, root, repo, run, addWorktree } = yield* fixture;
        const folder = yield* addWorktree(path.join(root, "worktrees", "relative"), "relative");
        const gitDir = path.join(repo, ".git", "worktrees", "relative");
        yield* fs.writeFileString(
          path.join(folder, ".git"),
          `gitdir: ${path.relative(folder, gitDir)}\n`,
        );
        yield* fs.writeFileString(
          path.join(gitDir, "gitdir"),
          `${path.relative(gitDir, path.join(folder, ".git"))}\n`,
        );
        yield* run(repo, ["worktree", "lock", folder]);
        const result = yield* checkWorktreeRegistration(folder);
        expect(result.ok && result.locked).toBe(true);
      }),
    );

    it.effect("rejects a folder whose registration Git reused for another folder", () =>
      Effect.gen(function* () {
        const { fs, path, root, repo, addWorktree } = yield* fixture;
        const stale = yield* addWorktree(path.join(root, "worktrees", "a", "work"), "first");
        // An outside script removed the registration and left the files.
        yield* fs.remove(path.join(repo, ".git", "worktrees", "work"), { recursive: true });
        // Git reuses the free id for the next worktree with the same folder name.
        const other = yield* addWorktree(path.join(root, "worktrees", "b", "work"), "second");
        expect(
          yield* fs.readFileString(path.join(repo, ".git", "worktrees", "work", "gitdir")),
        ).toContain(other);
        const result = yield* checkWorktreeRegistration(stale);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problem).toContain("another folder");
        expect((yield* checkWorktreeRegistration(other)).ok).toBe(true);
      }),
    );

    it.effect(
      "rejects a main checkout, a folder without .git, a gone registration and a link",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, repo, addWorktree } = yield* fixture;
          const plain = path.join(root, "plain");
          yield* fs.makeDirectory(plain);
          const gone = yield* addWorktree(path.join(root, "worktrees", "gone"), "gone");
          yield* fs.remove(path.join(repo, ".git", "worktrees", "gone"), { recursive: true });
          const linked = yield* addWorktree(path.join(root, "worktrees", "linked"), "linked");
          const realDotGit = path.join(root, "dot-git");
          yield* fs.rename(path.join(linked, ".git"), realDotGit);
          yield* fs.symlink(realDotGit, path.join(linked, ".git"));
          const notWorktree = path.join(root, "not-worktree");
          yield* fs.makeDirectory(notWorktree);
          yield* fs.writeFileString(path.join(notWorktree, ".git"), `gitdir: ${repo}/.git\n`);
          for (const folder of [repo, plain, gone, linked, notWorktree, path.join(root, "missing")])
            expect((yield* checkWorktreeRegistration(folder)).ok).toBe(false);
        }),
    );
  });
});
