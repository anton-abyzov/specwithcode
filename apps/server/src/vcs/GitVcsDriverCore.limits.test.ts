import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-git-vcs-driver-limits-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (prefix = "git-vcs-driver-limits-test-") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    return { initialBranch: yield* git(cwd, ["branch", "--show-current"]) };
  });

it.layer(layerTest)("GitVcsDriver output and naming limits", (it) => {
  it.effect(
    "keeps large change sets available for status and commit preparation",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        const files = Array.from(
          { length: 6_000 },
          (_, index) => `file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
        );
        yield* Effect.forEach(
          files,
          (file) => fs.writeFileString(path.join(cwd, file), "before\n"),
          { concurrency: 16, discard: true },
        );
        yield* git(cwd, ["add", "."]);
        const unborn = yield* driver.statusDetailsLocal(cwd);
        assert.lengthOf(unborn.workingTree.files, files.length);
        assert.equal(unborn.workingTree.insertions, files.length);
        const initial = yield* driver.commit(cwd, "initial", "");
        assert.match(initial.commitSha, /^[a-f0-9]{40}$/);
        assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasWorkingTreeChanges);
        yield* Effect.forEach(
          files,
          (file) => fs.writeFileString(path.join(cwd, file), "after\n"),
          { concurrency: 16, discard: true },
        );
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.isTrue(status.hasWorkingTreeChanges);
        assert.lengthOf(status.workingTree.files, files.length);
        assert.equal(status.workingTree.insertions, files.length);
        assert.equal(status.workingTree.deletions, files.length);
        const context = yield* driver.prepareCommitContext(cwd);
        assert.isNotNull(context);
        assert.isAbove(context!.stagedSummary.length, 1_000_000);
        assert.lengthOf(context!.stagedSummary.split("\n"), files.length);
      }),
    { timeout: 120_000 },
  );

  it.effect("keeps generated worktree folders short without changing long branch names", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const folders = new Set<string>();
      const branches = [
        `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}`,
        `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"d".repeat(90)}`,
        `feature/${"a".repeat(40)}/5fac`,
        `feature/${"a".repeat(40)}/18828`,
        `${"a".repeat(22)}😀/${"b".repeat(30)}`,
        "z".repeat(40),
        "z".repeat(41),
      ];
      for (const branch of branches) {
        const created = yield* driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: branch },
          { worktreesDirectory },
        );
        const folder = pathService.basename(created.worktree.path);
        assert.isAtMost(folder.length, 40);
        if (branch.length <= 40) assert.equal(folder, branch);
        assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), branch);
        // Git lists the resolved path (macOS temp folders sit behind /private) with
        // forward slashes, Windows included.
        const listed = yield* git(cwd, [
          "-c",
          "core.quotePath=false",
          "worktree",
          "list",
          "--porcelain",
        ]);
        const resolved = yield* fileSystem.realPath(created.worktree.path);
        assert.include(listed.replaceAll("\\", "/"), `worktree ${resolved.replaceAll("\\", "/")}`);
        folders.add(folder);
      }
      assert.equal(folders.size, branches.length);
    }),
  );

  it.effect("reads the current branch by name when a tag shares it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "release"]);
      yield* git(cwd, ["tag", "release"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
      assert.equal(remoteStatus.branch, "release");
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const branchRange = preview.sources.find((source) => source.kind === "branch-range");
      assert.equal(branchRange?.headRef, "release");
    }),
  );
});
