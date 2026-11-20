import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef } from "@specweave-studio/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGitRestore = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-git-restore-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "GitVcsDriver.restore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

const makeRepository = Effect.fn("makeRepository")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  yield* runGit(root, ["init"]);
  yield* runGit(root, ["config", "user.email", "test@example.com"]);
  yield* runGit(root, ["config", "user.name", "Test"]);
  // Assertions compare bytes, so the runner's line-ending settings must not apply.
  yield* runGit(root, ["config", "core.autocrlf", "false"]);
  return root;
});

// The driver runs `git -C <workspace>`, so cleaning an emptied nested workspace ends with
// Git removing "./" itself. That fails elsewhere, but Git for Windows removes the directory
// and lists it as "./". This wraps real Git to answer the same way on every platform.
const makeGitForWindowsCleanLayer = (cleanRuns: Array<ReadonlyArray<string>>) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.gen(function* () {
      const real = yield* VcsProcess.VcsProcess;
      const fileSystem = yield* FileSystem.FileSystem;
      return VcsProcess.VcsProcess.of({
        run: (input) =>
          real.run(input).pipe(
            Effect.flatMap((output) => {
              if (!input.args.includes("clean")) return Effect.succeed(output);
              cleanRuns.push(input.args);
              if (!output.stderr.includes("failed to remove ./")) return Effect.succeed(output);
              // Git lists a directory it removes whole on one line, without its children.
              return fileSystem.remove(input.cwd, { recursive: true }).pipe(
                Effect.orDie,
                Effect.as({
                  ...output,
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "Removing ./\n",
                  stderr: "",
                }),
              );
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(VcsProcess.layer), Layer.provideMerge(NodeServices.layer));

const stagedPaths = (cwd: string) =>
  runGit(cwd, ["diff", "--cached", "--name-only"]).pipe(
    Effect.map((result) => result.stdout.trim()),
  );

it.effect("restoring a checkpoint removes files hidden by a .gitignore the turn created", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* makeRepository("studio-restore-ignored-");
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      // Ignored before the turn: by a tracked .gitignore and by info/exclude.
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "build.log\n");
      yield* fileSystem.writeFileString(path.join(cwd, "tracked.txt"), "original\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* fileSystem.writeFileString(path.join(root, ".git", "info", "exclude"), "local.env\n");
      yield* fileSystem.writeFileString(path.join(cwd, "build.log"), "keep\n");
      yield* fileSystem.writeFileString(path.join(cwd, "local.env"), "keep\n");
      const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/ignored");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // The turn adds a directory whose own .gitignore hides one of its files.
      yield* fileSystem.writeFileString(path.join(cwd, "tracked.txt"), "changed\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "generated"));
      yield* fileSystem.writeFileString(path.join(cwd, "generated", ".gitignore"), "hidden.txt\n");
      yield* fileSystem.writeFileString(path.join(cwd, "generated", "hidden.txt"), "remove\n");
      yield* fileSystem.writeFileString(path.join(cwd, "generated", "visible.txt"), "remove\n");

      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(cwd, "tracked.txt")),
        "original\n",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "generated")));
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "build.log")), "keep\n");
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "local.env")), "keep\n");
      assert.strictEqual(yield* stagedPaths(root), "");
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a checkpoint before the first commit unstages only what it staged", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* makeRepository("studio-restore-unborn-");
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "staged\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "original\n");
      // Staged by the user before the turn: Revert keeps it staged.
      yield* fileSystem.writeFileString(path.join(cwd, "draft.txt"), "draft\n");
      yield* runGit(cwd, ["add", "draft.txt"]);
      const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/unborn");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
      yield* fileSystem.writeFileString(path.join(cwd, "added.txt"), "new\n");

      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
        "original\n",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "added.txt")));
      assert.strictEqual(
        yield* stagedPaths(root),
        nested ? "nested/draft.txt\noutside.txt" : "draft.txt",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a checkpoint removes a chain of .gitignore files the turn created", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const depth of [2, 6]) {
      const root = yield* makeRepository("studio-restore-chain-");
      yield* fileSystem.writeFileString(path.join(root, "tracked.txt"), "original\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/chain");
      yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });

      // Each level's .gitignore hides the next level, so every clean pass peels one level.
      let level = root;
      for (let index = 1; index <= depth; index++) {
        level = path.join(level, `level${index}`);
        yield* fileSystem.makeDirectory(level);
        if (index < depth) {
          yield* fileSystem.writeFileString(path.join(level, ".gitignore"), `level${index + 1}/\n`);
        }
      }
      yield* fileSystem.writeFileString(path.join(level, "data.txt"), "remove\n");

      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({
          cwd: root,
          checkpointRef,
          fallbackToHead: false,
        }),
      );

      assert.isFalse(yield* fileSystem.exists(path.join(root, "level1")));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, "tracked.txt")),
        "original\n",
      );
      assert.strictEqual(yield* stagedPaths(root), "");
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a checkpoint keeps a nested repository the turn created", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const root = yield* makeRepository("studio-restore-nested-repo-");
    yield* fileSystem.writeFileString(path.join(root, "tracked.txt"), "original\n");
    yield* runGit(root, ["add", "."]);
    yield* runGit(root, ["commit", "-m", "initial"]);
    const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/nested-repo");
    yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });

    // A single -f never removes another repository, so its files stay and the restore succeeds.
    const nestedRepository = path.join(root, "vendor");
    yield* fileSystem.makeDirectory(nestedRepository);
    yield* runGit(nestedRepository, ["init"]);
    yield* fileSystem.writeFileString(path.join(nestedRepository, "work.txt"), "keep\n");
    yield* fileSystem.writeFileString(path.join(root, "added.txt"), "remove\n");

    assert.isTrue(
      yield* driver.checkpoints.restoreCheckpoint({
        cwd: root,
        checkpointRef,
        fallbackToHead: false,
      }),
    );

    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(nestedRepository, "work.txt")),
      "keep\n",
    );
    assert.isFalse(yield* fileSystem.exists(path.join(root, "added.txt")));
    assert.strictEqual(yield* stagedPaths(root), "");
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a checkpoint removes a directory whose new .gitignore ignores itself", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const root = yield* makeRepository("studio-restore-self-ignored-");
    yield* fileSystem.writeFileString(path.join(root, "tracked.txt"), "original\n");
    yield* runGit(root, ["add", "."]);
    yield* runGit(root, ["commit", "-m", "initial"]);
    // A cache that ignored itself before the turn belongs to the user.
    const cache = path.join(root, ".cache");
    yield* fileSystem.makeDirectory(cache);
    yield* fileSystem.writeFileString(path.join(cache, ".gitignore"), "*\n");
    yield* fileSystem.writeFileString(path.join(cache, "entry.bin"), "keep\n");
    const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/self-ignored");
    yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });

    const generated = path.join(root, "generated");
    yield* fileSystem.makeDirectory(generated);
    yield* fileSystem.writeFileString(path.join(generated, ".gitignore"), "*\n");
    yield* fileSystem.writeFileString(path.join(generated, "data.txt"), "remove\n");
    yield* fileSystem.writeFileString(path.join(cache, "turn.bin"), "kept with its cache\n");
    yield* fileSystem.writeFileString(path.join(root, "tracked.txt"), "changed\n");

    assert.isTrue(
      yield* driver.checkpoints.restoreCheckpoint({
        cwd: root,
        checkpointRef,
        fallbackToHead: false,
      }),
    );

    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(root, "tracked.txt")),
      "original\n",
    );
    assert.isFalse(yield* fileSystem.exists(generated));
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cache, ".gitignore")), "*\n");
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cache, "entry.bin")), "keep\n");
    assert.strictEqual(yield* stagedPaths(root), "");
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a checkpoint keeps ignored files a turn's negation exposed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const recorded of [true, false]) {
      const root = yield* makeRepository("studio-restore-negation-");
      yield* fileSystem.writeFileString(path.join(root, ".gitignore"), "*.log\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      // An ignored .gitignore hides a secret; a tracked rule hides a log.
      yield* fileSystem.writeFileString(
        path.join(root, ".git", "info", "exclude"),
        "/local/.gitignore\n",
      );
      const local = path.join(root, "local");
      yield* fileSystem.makeDirectory(local);
      yield* fileSystem.writeFileString(path.join(local, ".gitignore"), "secret.txt\n");
      yield* fileSystem.writeFileString(path.join(local, "secret.txt"), "keep\n");
      const sub = path.join(root, "sub");
      yield* fileSystem.makeDirectory(sub);
      yield* fileSystem.writeFileString(path.join(sub, "x.log"), "keep\n");
      const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/negation");
      yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });
      if (!recorded) {
        // A checkpoint written before ignored paths were recorded.
        const tree = yield* runGit(root, ["rev-parse", `${checkpointRef}^{tree}`]);
        const commit = yield* runGit(root, [
          "commit-tree",
          tree.stdout.trim(),
          "-m",
          `specweave-studio checkpoint ref=${checkpointRef}`,
        ]);
        yield* runGit(root, ["update-ref", checkpointRef, commit.stdout.trim()]);
      }

      // The turn un-ignores the ignore file itself and the log.
      yield* fileSystem.writeFileString(
        path.join(local, ".gitignore"),
        "secret.txt\n!.gitignore\n",
      );
      yield* fileSystem.writeFileString(path.join(sub, ".gitignore"), "!x.log\n");
      const restore = driver.checkpoints.restoreCheckpoint({
        cwd: root,
        checkpointRef,
        fallbackToHead: false,
      });

      if (recorded) {
        assert.isTrue(yield* restore);
        assert.isFalse(yield* fileSystem.exists(path.join(sub, ".gitignore")));
        assert.isTrue(yield* fileSystem.exists(path.join(local, ".gitignore")));
        assert.strictEqual(yield* fileSystem.readFileString(path.join(sub, "x.log")), "keep\n");
      } else {
        // Without the record one pass runs, and what it exposes is reported, not deleted.
        // (That pass still removes the log the turn un-ignored, as Revert always has.)
        const error = yield* restore.pipe(Effect.flip);
        assert.include(error.message, "untracked files remain");
      }
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(local, "secret.txt")),
        "keep\n",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "restoring reports the cleanup failure when unstaging fails too",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const root = yield* makeRepository("studio-restore-locked-");
      yield* runGit(root, ["commit", "--allow-empty", "-m", "initial"]);
      const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/locked");
      yield* driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef });

      const locked = path.join(root, "locked");
      yield* fileSystem.makeDirectory(locked);
      yield* fileSystem.writeFileString(path.join(locked, "residual.txt"), "stays\n");
      yield* fileSystem.chmod(locked, 0o555);
      // Another Git process holds the index.
      yield* fileSystem.writeFileString(path.join(root, ".git", "index.lock"), "");
      const error = yield* driver.checkpoints
        .restoreCheckpoint({ cwd: root, checkpointRef, fallbackToHead: false })
        .pipe(Effect.flip, Effect.ensuring(fileSystem.chmod(locked, 0o755).pipe(Effect.ignore)));

      assert.include(error.message, "locked/residual.txt");
      assert.include(error.message, "Unstaging the restored files also failed");
    }).pipe(Effect.scoped, Effect.provide(layerGitRestore)),
);

it.effect("restoring a nested workspace that git clean removes whole cleans it once", () => {
  const cleanRuns: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      driver.execute({ operation: "GitVcsDriver.restore.test.git", cwd, args });
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-restore-whole-" });
    yield* git(root, ["init"]);
    yield* git(root, ["config", "user.email", "test@example.com"]);
    yield* git(root, ["config", "user.name", "Test"]);
    yield* git(root, ["commit", "--allow-empty", "-m", "initial"]);
    const cwd = path.join(root, "nested");
    yield* fileSystem.makeDirectory(cwd);
    const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/whole");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    const restore = driver.checkpoints.restoreCheckpoint({
      cwd,
      checkpointRef,
      fallbackToHead: false,
    });
    const cleanPasses = () => cleanRuns.filter((args) => args.includes("-fd")).length;

    // Already empty: the only thing Git removes is the workspace directory itself.
    assert.isTrue(yield* restore);
    assert.isTrue(yield* fileSystem.exists(cwd));
    assert.strictEqual(cleanPasses(), 1);

    cleanRuns.length = 0;
    yield* fileSystem.writeFileString(path.join(cwd, "added.txt"), "new\n");
    assert.isTrue(yield* restore);
    assert.deepStrictEqual(yield* fileSystem.readDirectory(cwd), []);
    assert.strictEqual(cleanPasses(), 1);

    // A .gitignore the turn created: one pass removes it, the next removes all the rest.
    cleanRuns.length = 0;
    yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "hidden.txt\n");
    yield* fileSystem.writeFileString(path.join(cwd, "hidden.txt"), "remove\n");
    assert.isTrue(yield* restore);
    assert.deepStrictEqual(yield* fileSystem.readDirectory(cwd), []);
    assert.strictEqual(cleanPasses(), 2);
    assert.isFalse(cleanRuns.some((args) => args.includes("-dn")));
    assert.strictEqual((yield* git(root, ["status", "--porcelain"])).stdout, "");
  }).pipe(Effect.scoped, Effect.provide(makeGitForWindowsCleanLayer(cleanRuns)));
});

it.effect("restoring fails when clean never finishes and untracked files remain", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      driver.execute({ operation: "GitVcsDriver.restore.test.git", cwd, args });
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-restore-runaway-" });
    yield* git(root, ["init"]);
    yield* git(root, ["config", "user.email", "test@example.com"]);
    yield* git(root, ["config", "user.name", "Test"]);
    yield* git(root, ["commit", "--allow-empty", "-m", "initial"]);
    const cwd = path.join(root, "nested");
    yield* fileSystem.makeDirectory(cwd);
    const checkpointRef = CheckpointRef.make("refs/studio/checkpoints/runaway");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    const restore = driver.checkpoints.restoreCheckpoint({
      cwd,
      checkpointRef,
      fallbackToHead: false,
    });

    // Git lists this workspace as "./" alone in the dry run, with the file still in it.
    yield* fileSystem.writeFileString(path.join(cwd, "stubborn.txt"), "stays\n");
    const error = yield* restore.pipe(Effect.flip);
    assert.include(error.message, "untracked files remain");
    assert.isTrue(yield* fileSystem.exists(path.join(cwd, "stubborn.txt")));

    // The same dry-run line for an empty workspace is the directory itself: nothing remains.
    yield* fileSystem.remove(path.join(cwd, "stubborn.txt"));
    assert.isTrue(yield* restore);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      // Every real clean pass claims to remove a file and removes nothing.
      Layer.effect(
        VcsProcess.VcsProcess,
        Effect.gen(function* () {
          const real = yield* VcsProcess.VcsProcess;
          return VcsProcess.VcsProcess.of({
            run: (input) =>
              input.args.includes("clean") && input.args.includes("-fd")
                ? Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "Removing ./stubborn.txt\n",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  })
                : real.run(input),
          });
        }),
      ).pipe(Layer.provide(VcsProcess.layer), Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it("does not count the workspace directory itself in git clean output", () => {
  const lists = GitVcsDriver.gitCleanListsWorkspacePath;
  // Git for Windows, cleaning an emptied nested workspace.
  assert.isFalse(lists("Removing ./\n", "Removing"));
  assert.isFalse(lists("Removing ./\r\n", "Removing"));
  assert.isFalse(lists("Would remove ./\n", "Would remove"));
  assert.isFalse(lists("", "Removing"));
  assert.isFalse(lists("Would remove ./added.txt\n", "Removing"));
  assert.isTrue(lists("Removing ./added.txt\n", "Removing"));
  assert.isTrue(lists("Removing .gitignore\nRemoving ./\n", "Removing"));
  assert.isTrue(lists("Removing ./.config/\n", "Removing"));
  assert.isTrue(lists("Would remove ./\nWould remove generated/\n", "Would remove"));
});
