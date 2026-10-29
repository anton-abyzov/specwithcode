// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  ReviewDiffPreviewInput,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@specweave-studio/contracts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceSensitivePaths from "../workspace/WorkspaceSensitivePaths.ts";
import { gitCommandDuration } from "../observability/Metrics.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  lastGitFatalLine,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-git-vcs-driver-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

// Releases the lock as soon as a matching git command fails on it, before the driver retries.
const makeDriverReleasingLock = (
  matches: (args: ReadonlyArray<string>) => boolean,
  lockPath: string,
) =>
  Effect.gen(function* () {
    const failures = yield* Ref.make(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const handle = yield* delegate.spawn(command);
        if (!ChildProcess.isStandardCommand(command) || !matches(command.args)) return handle;
        return ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: handle.exitCode.pipe(
            Effect.tap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Ref.update(failures, (count) => count + 1).pipe(
                    Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                    Effect.orDie,
                  ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    return { driver, failures };
  });

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

// Git runs GIT_SSH_COMMAND through sh, which eats unquoted Windows backslashes.
const sshCommandFor = (scriptPath: string) => `'${scriptPath.replaceAll("\\", "/")}'`;

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

describe("lastGitFatalLine", () => {
  it("returns the last fatal line without URL credentials", () => {
    assert.equal(
      lastGitFatalLine(
        "Preparing worktree\nfatal: first\nfatal: unable to access 'https://user:tok3n@example.invalid/r.git/'\n",
      ),
      "fatal: unable to access 'https://example.invalid/r.git/'",
    );
    assert.isNull(lastGitFatalLine("warning: nothing fatal here\n"));
  });
});

it.effect("bounds Git bursts across drivers without timing out queued commands", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const starts = yield* Queue.unbounded<number>();
    let active = 0;
    let peak = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          peak = Math.max(peak, ++active);
          yield* Queue.offer(starts, active);
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulHandle("ok"),
            exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          });
        }),
        () => Effect.sync(() => active--),
      ),
    );
    const drivers = yield* Effect.all(
      Array.from({ length: 16 }, () =>
        makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    const burst = yield* Effect.forEach(
      drivers,
      (driver, index) =>
        driver.execute({
          operation: "test.gitBurst",
          cwd: "/repo",
          args: ["rev-parse", "HEAD"],
          ...(index < 4 ? {} : { timeoutMs: index < 8 ? 30_000 : 1_000 }),
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("2 seconds");
    assert.equal(yield* Queue.size(starts), 8);
    assert.equal(peak, 8);
    yield* Deferred.succeed(gate, undefined);
    const results = yield* Fiber.join(burst);
    assert.equal(results.length, 16);
    assert.isTrue(results.every((result) => result.stdout === "ok" && result.exitCode === 0));
    assert.equal(peak, 8);
    assert.equal(active, 0);
    const duration = yield* Metric.value(
      Metric.withAttributes(gitCommandDuration, [["operation", "test.gitBurst"]]),
    );
    assert.equal(duration.count, 16);
    assert.equal(duration.sum, 16_000);
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect.each([{ timeoutMs: null }, { timeoutMs: 30_001 }])(
  "keeps all Git slots available with a pending command whose timeout is $timeoutMs",
  ({ timeoutMs }) =>
    Effect.gen(function* () {
      const slowGate = yield* Deferred.make<void>();
      const fastGate = yield* Deferred.make<void>();
      const starts = yield* Queue.unbounded<void>();
      let active = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            active++;
            yield* Queue.offer(starts, undefined);
            const gate =
              ChildProcess.isStandardCommand(command) && command.args[0] === "push"
                ? slowGate
                : fastGate;
            return ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle("ok"),
              exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
          () => Effect.sync(() => active--),
        ),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const slow = yield* driver
        .execute({ operation: "test.slowGit", cwd: "/repo", args: ["push"], timeoutMs })
        .pipe(Effect.forkChild);
      yield* Queue.take(starts);
      const burst = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          driver.execute({ operation: "test.fastGit", cwd: "/repo", args: ["status"] }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("0 seconds");
      assert.equal(yield* Queue.size(starts), 8);
      assert.equal(active, 9);
      yield* Deferred.succeed(fastGate, undefined);
      assert.equal((yield* Fiber.join(burst)).length, 8);
      assert.equal(active, 1);
      yield* Deferred.succeed(slowGate, undefined);
      assert.equal((yield* Fiber.join(slow)).stdout, "ok");
      assert.equal(active, 0);
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect.each(["root", "nested", "worktree"] as const)(
  "skips clean filters while the %s index is locked and resumes after unlock",
  (location) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* makeTmpDir();
      yield* initRepoWithCommit(repository);
      const cwd = location === "worktree" ? yield* makeTmpDir() : repository;
      if (location === "worktree") {
        yield* git(repository, ["worktree", "add", "--detach", cwd]);
      }
      yield* git(cwd, ["config", "filter.probe.clean", "echo clean >> .filter-runs; cat"]);
      yield* writeTextFile(cwd, ".gitattributes", "asset.bin filter=probe\n");
      yield* writeTextFile(cwd, ".gitignore", ".filter-runs\n");
      yield* writeTextFile(cwd, "asset.bin", "original\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "filtered asset"]);
      NodeFS.utimesSync(path.join(cwd, "asset.bin"), 1, 1);
      const runsPath = path.join(cwd, ".filter-runs");
      yield* fs.remove(runsPath, { force: true });
      const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const lockPath = `${path.resolve(cwd, indexPath)}.lock`;
      yield* fs.writeFileString(lockPath, "");
      const statusCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
      yield* fs.makeDirectory(statusCwd, { recursive: true });

      for (let poll = 0; poll < 3; poll++) {
        const result = yield* driver.statusDetailsLocal(statusCwd).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(result.failure.detail, "index is locked");
      }
      assert.isFalse(yield* fs.exists(runsPath));
      assert.isTrue(yield* fs.exists(lockPath));

      yield* fs.remove(lockPath);
      const status = yield* driver.statusDetailsLocal(statusCwd);
      assert.isFalse(status.hasWorkingTreeChanges);
      assert.include(yield* fs.readFileString(runsPath), "clean");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("uses stable diagnostics for every parsed non-repository command", () => {
  const commands: Array<{ readonly args: ReadonlyArray<string>; readonly lcAll?: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        return assert.fail("expected a standard Git command");
      }
      commands.push({
        args: command.args,
        ...(command.options.env?.LC_ALL ? { lcAll: command.options.env.LC_ALL } : {}),
      });
      return makeNonRepositoryHandle();
    }),
  );
  const layerNodeServices = Layer.merge(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(layerServerConfig),
    Layer.provideMerge(layerNodeServices),
  );

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = "/repo";

    yield* driver.statusDetailsLocal(cwd);
    yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
    yield* driver.listRefs({ cwd });

    assert.deepStrictEqual(commands, [
      { args: ["rev-parse", "--git-path", "index"], lcAll: "C" },
      { args: ["status", "--porcelain=2", "--branch"], lcAll: "C" },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], lcAll: "C" },
      { args: ["rev-parse", "--git-common-dir"], lcAll: "C" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("invalidates origin remote cache when a driver mutation adds origin", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    const before = yield* driver.statusDetailsLocal(cwd);
    assert.equal(before.hasOriginRemote, false);

    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });

    const after = yield* driver.statusDetailsLocal(cwd);
    assert.equal(after.hasOriginRemote, true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("re-reads origin remote status after cache TTL expiry and bypassed invalidation", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    // First call caches hasOriginRemote = false (5-min TTL)
    assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);

    // Add origin via raw git (bypasses invalidation hook)
    yield* git(cwd, ["remote", "add", "origin", remote]);

    // Cache still has the stale false (TTL not yet expired)
    const stillCached = yield* driver.statusDetailsLocal(cwd);
    assert.equal(stillCached.hasOriginRemote, false);

    // Advance past the 5-minute TTL so the cache entry expires
    yield* TestClock.adjust("6 minutes");

    // After expiry, the next call re-executes and picks up the remote
    const afterExpiry = yield* driver.statusDetailsLocal(cwd);
    assert.equal(afterExpiry.hasOriginRemote, true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("coalesces concurrent ref pages into one repository snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const remoteNamesScanCompleted = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          yield* Ref.update(spawnedArgs, (current) => [...current, command.args]);
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          const shouldDelay =
            isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false));
          if (shouldDelay) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Effect.sleep("8 seconds");
          }
          const handle = yield* delegate.spawn(command);
          const isRemoteNamesScan =
            command.args.length === 3 &&
            command.args[0] === "--git-dir" &&
            command.args[2] === "remote";
          return isRemoteNamesScan
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(remoteNamesScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const cwd = yield* makeTmpDir();
      const runGit = (args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.coalescedListRefs",
          cwd,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(["config", "user.email", "test@test.com"]);
      yield* runGit(["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(["add", "."]);
      yield* runGit(["commit", "-m", "initial commit"]);
      yield* Ref.set(spawnedArgs, []);

      const initialRequest = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(remoteNamesScanCompleted);
      yield* TestClock.adjust("6 seconds");
      const laterRequests = yield* Effect.all(
        Array.from({ length: 30 }, (_, index) =>
          driver.listRefs({
            cwd,
            refresh: true,
            query: `missing-${index}`,
            limit: 100,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(initialRequest);
      yield* Fiber.join(laterRequests);
      yield* driver.listRefs({ cwd, cursor: 1, limit: 100 });

      const firstSnapshotCommands = yield* Ref.get(spawnedArgs);
      const snapshotRefScans = firstSnapshotCommands.filter(
        (args) =>
          args.includes("for-each-ref") &&
          args.includes("refs/heads") &&
          args.includes("refs/remotes"),
      );
      const worktreeScans = firstSnapshotCommands.filter(
        (args) => args.includes("worktree") && args.includes("--porcelain"),
      );
      assert.equal(snapshotRefScans.length, 1);
      assert.equal(worktreeScans.length, 1);

      yield* driver.createRef({ cwd, refName: "feature/cache-invalidation" });
      const refreshed = yield* driver.listRefs({ cwd, limit: 100 });
      assert.equal(
        refreshed.refs.some((ref) => ref.name === "feature/cache-invalidation"),
        true,
      );
      const allCommands = yield* Ref.get(spawnedArgs);
      assert.equal(
        allCommands.filter(
          (args) =>
            args.includes("for-each-ref") &&
            args.includes("refs/heads") &&
            args.includes("refs/remotes"),
        ).length,
        2,
      );
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args[1] === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("fails a ref snapshot when for-each-ref exits unsuccessfully", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const snapshotAttempts = yield* Ref.make(0);
      const failingSnapshotSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("for-each-ref")) {
            yield* Ref.update(snapshotAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSnapshotSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const error = yield* driver.listRefs({ cwd, refresh: true }).pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.listRefs.snapshotRefs",
        detail: "Git ref snapshot enumeration failed.",
        exitCode: 128,
      });
      assert.equal(yield* Ref.get(snapshotAttempts), 1);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("refreshes the current branch after an external checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "external-checkout"]);

      const initialRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(initialRefs.refs.find((ref) => ref.name === initialBranch)?.current);

      // Raw execute intentionally bypasses the driver's mutation invalidation,
      // matching a checkout performed by another process.
      yield* driver.execute({
        operation: "GitVcsDriver.test.externalCheckout",
        cwd,
        args: ["checkout", "external-checkout"],
        timeoutMs: 10_000,
      });
      yield* TestClock.adjust("6 seconds");

      const refreshedRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(refreshedRefs.refs.find((ref) => ref.name === "external-checkout")?.current);
      assert.isFalse(refreshedRefs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("backs off and logs failed fetch attempts across linked worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchAttempts = yield* Ref.make(0);
      const failingFetchSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("fetch") && command.args.includes("--quiet")) {
            yield* Ref.update(fetchAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingFetchSpawner),
      );
      const warnings: string[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        warnings.push(String(message));
      });
      const readRemoteStatus = (workingDirectory: string) =>
        driver
          .statusDetailsRemote(workingDirectory)
          .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(worktreesRoot, "linked");
      const runGit = (workingDirectory: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.upstreamRefreshBackoff",
          cwd: workingDirectory,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "initial commit"]);
      const initialBranch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      yield* runGit(remote, ["init", "--bare"]);
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", initialBranch]);
      yield* runGit(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* runGit(worktreePath, [
        "branch",
        "--set-upstream-to",
        `origin/${initialBranch}`,
        "feature/linked",
      ]);
      const rootCommonDir = (yield* runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
      const linkedCommonDir = (yield* runGit(worktreePath, [
        "rev-parse",
        "--git-common-dir",
      ])).stdout.trim();
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      assert.equal(
        NodeFS.realpathSync.native(pathService.resolve(cwd, rootCommonDir)),
        NodeFS.realpathSync.native(pathService.resolve(worktreePath, linkedCommonDir)),
      );
      yield* Ref.set(fetchAttempts, 0);

      yield* readRemoteStatus(cwd);
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);
      assert.lengthOf(warnings, 1);
      assert.include(warnings[0], "Background Git fetch failed");

      yield* TestClock.adjust("29 seconds");
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);
      assert.lengthOf(warnings, 1);

      yield* TestClock.adjust("1 second");
      yield* readRemoteStatus(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 2);
      assert.lengthOf(warnings, 2);

      yield* TestClock.adjust("59 seconds");
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 2);
      assert.lengthOf(warnings, 2);

      yield* TestClock.adjust("1 second");
      yield* readRemoteStatus(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 3);
      assert.lengthOf(warnings, 3);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect.each([
  {
    name: "HTTPS credentials",
    stderr: "fatal: Authentication failed for",
    expected: "could not authenticate",
  },
  {
    name: "SSH credentials",
    stderr: "git@example.com: Permission denied (publickey).",
    expected: "could not authenticate",
  },
  {
    name: "disabled prompts",
    stderr: "fatal: could not read Username: terminal prompts disabled",
    expected: "could not authenticate",
  },
  {
    name: "DNS failure",
    stderr: "fatal: Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "connection failure",
    stderr: "ssh: connect to host example.com port 22: Connection refused",
    expected: "could not reach the remote",
  },
  {
    name: "missing remote",
    stderr: "remote: Repository not found.",
    expected: "could not access the remote repository",
  },
  {
    name: "invalid remote",
    stderr: "fatal: remote does not appear to be a git repository",
    expected: "could not access the remote repository",
  },
  {
    name: "reference lock",
    stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
    expected: "could not update a local reference",
  },
  {
    name: "lock file",
    stderr: "fatal: Unable to create '/repo/.git/FETCH_HEAD.lock': File exists.",
    expected: "could not update a local reference",
  },
  {
    name: "unrelated remote chatter",
    stderr:
      "remote: Help: authentication failed, connection refused, cannot lock ref\nremote: unrelated service error",
    expected: "git fetch origin failed",
  },
  {
    name: "HTTPS DNS failure",
    stderr:
      "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "unknown failure",
    stderr: "fatal: unexpected remote failure",
    expected: "git fetch origin failed",
  },
] as const)("reports $name during fetch without retaining remote output", (scenario) =>
  Effect.gen(function* () {
    const secret = "secret-fetch-token";
    const stderr = `${scenario.stderr}\nhttps://user:${secret}@example.com/private?token=${secret}`;
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        assert.deepEqual(command.args, ["fetch", "--quiet", "origin"]);
        assert.equal(command.options.env?.LC_ALL, "C");
        assert.equal(command.options.env?.GIT_TERMINAL_PROMPT, "0");
        yield* Ref.update(attempts, (count) => count + 1);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(secret)),
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
    assert.include(error.detail, scenario.expected);
    assert.equal(error.exitCode, 128);
    assert.equal(error.stderrLength, stderr.length);
    assert.equal(error.stdoutLength, secret.length);
    assert.notInclude(error.message, secret);
    assert.notInclude(yield* encodeGitCommandError(error), secret);
    assert.notProperty(error, "stderr");
    assert.notProperty(error, "args");
    assert.equal(yield* Ref.get(attempts), 1);
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("process environment", () => {
    it.effect("preserves the caller locale for general Git subprocesses", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();

        const locale = yield* git(
          cwd,
          ["-c", 'alias.print-locale=!printf "%s" "$LC_ALL"', "print-locale"],
          { LC_ALL: "zh_CN.UTF-8" },
        );

        assert.equal(locale, "zh_CN.UTF-8");
      }),
    );
  });

  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
        assert.notProperty(error, "reason");
      }),
    );

    it.effect("names the branch conflict behind a failed worktree add", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        const firstWorktree = pathService.join(parent, "first");
        yield* git(cwd, ["worktree", "add", firstWorktree, "-b", "shared-branch"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.worktreeAddConflict",
            cwd,
            args: ["worktree", "add", pathService.join(parent, "second"), "shared-branch"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.worktreeAddConflict",
          reason: "branch_checked_out_in_worktree",
        });
        assert.include(error.message, "(branch_checked_out_in_worktree)");
        assert.notInclude(error.message, firstWorktree);
      }),
    );

    it.effect("names a missing repository behind a failed command", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.notARepository",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.notARepository",
          reason: "not_a_repository",
        });
        assert.include(error.message, "(not_a_repository)");
      }),
    );

    it.effect("appends the reason tag to a caller-supplied detail", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, [
          "worktree",
          "add",
          pathService.join(parent, "taken"),
          "-b",
          "taken-branch",
        ]);

        const error = yield* driver
          .createWorktree({
            cwd,
            refName: "taken-branch",
            path: pathService.join(parent, "second"),
          })
          .pipe(Effect.flip);

        assert.match(error.detail, /^git worktree add failed: fatal: .*taken-branch/);
        assert.include(error.message, "(branch_checked_out_in_worktree)");
      }),
    );

    it.effect("tags a worktree base branch the repository lacks as invalid_reference", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);

        const error = yield* driver
          .createWorktree({
            cwd,
            refName: "develop",
            newRefName: "feature",
            path: pathService.join(parent, "feature"),
          })
          .pipe(Effect.flip);

        assert.equal(error.reason, "invalid_reference");
        // The branch is created before the checkout, so `git branch` names the missing ref.
        assert.equal(
          error.detail,
          "git worktree add failed: fatal: not a valid object name: 'develop'",
        );
        assert.include(
          error.message,
          "fatal: not a valid object name: 'develop' (invalid_reference)",
        );
        assert.equal(
          yield* git(cwd, ["branch", "--list", "feature"]),
          "",
          "a failed launch leaves no branch behind",
        );
      }),
    );

    it.effect.each([
      {
        label: "a refused key",
        sshMessage: "git@example.invalid: Permission denied (publickey).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused key among several methods",
        sshMessage: "git@example.invalid: Permission denied (publickey,password).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused keyboard-interactive attempt",
        sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a rejected password",
        sshMessage: "Permission denied, please try again.",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "an untrusted host key",
        sshMessage: "Host key verification failed.",
        expectedReason: "host_key_unverified" as const,
        expectedText: "(host_key_unverified)",
      },
    ])(
      "names $label rather than an unreachable remote",
      ({ sshMessage, expectedReason, expectedText }) =>
        Effect.gen(function* () {
          const parent = yield* makeTmpDir();
          const pathService = yield* Path.Path;
          const cwd = pathService.join(parent, "repo");
          const fileSystem = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* fileSystem.makeDirectory(cwd);
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
          // Stands in for ssh, which prints its refusal unprefixed and leaves
          // git to add only a generic "could not read" line after it.
          const fakeSsh = pathService.join(parent, "fake-ssh");
          yield* writeTextFile(
            parent,
            "fake-ssh",
            `#!/bin/sh\necho "${sshMessage}" >&2\nexit 255\n`,
          );
          yield* fileSystem.chmod(fakeSsh, 0o755);

          const error = yield* driver
            .execute({
              operation: "GitVcsDriver.test.sshRefusal",
              cwd,
              args: ["fetch", "origin"],
              env: { LC_ALL: "C", GIT_SSH_COMMAND: sshCommandFor(fakeSsh) },
            })
            .pipe(Effect.flip);

          assert.deepInclude(error, { reason: expectedReason });
          assert.include(error.message, expectedText);
        }),
    );

    it.effect("does not read a filesystem permission error as an ssh refusal", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
        const fakeSsh = pathService.join(parent, "fake-ssh");
        yield* writeTextFile(
          parent,
          "fake-ssh",
          '#!/bin/sh\necho "fatal: cannot open backup file: Permission denied (os error 13)" >&2\nexit 255\n',
        );
        yield* fileSystem.chmod(fakeSsh, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.osPermission",
            cwd,
            args: ["fetch", "origin"],
            env: { LC_ALL: "C", GIT_SSH_COMMAND: sshCommandFor(fakeSsh) },
          })
          .pipe(Effect.flip);

        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("does not read remote hook output as a git failure reason", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        // Git prefixes everything the server says with `remote:`, so a remote
        // hook can put arbitrary text in front of the classifier.
        const preReceive = pathService.join(remote, "hooks", "pre-receive");
        // A user's global core.hooksPath would bypass the repository's own hooks.
        yield* git(remote, ["config", "core.hooksPath", pathService.join(remote, "hooks")]);
        yield* writeTextFile(
          remote,
          "hooks/pre-receive",
          '#!/bin/sh\necho "authentication failed" >&2\necho "Permission denied (publickey)." >&2\necho "Host key verification failed." >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(preReceive, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.remoteHookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("does not read hook output as a git failure reason", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        // A user's global core.hooksPath would bypass the repository's own hooks.
        yield* git(cwd, ["config", "core.hooksPath", pathService.join(cwd, ".git", "hooks")]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/pre-push",
          '#!/bin/sh\necho "authentication failed" >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(pathService.join(cwd, ".git/hooks/pre-push"), 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.hookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("leaves a tag collision unclassified rather than calling it a path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["tag", "v1"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.tagCollision",
            cwd,
            args: ["tag", "v1"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(path_already_exists)");
      }),
    );

    it.effect("keeps line callbacks flowing past the output cap when asked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // 4 KiB of multi-byte lines, well past a 512-byte cap; the last line
        // is the one a failure surface would need.
        const lines: Array<string> = [];
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.callbacksPastCap",
          cwd,
          args: [
            "-c",
            'alias.spew=!for i in $(seq 1 128); do printf "é%03d\\n" $i >&2; done; echo fatal: last line >&2',
            "spew",
          ],
          maxOutputBytes: 512,
          appendTruncationMarker: true,
          keepLineCallbacksAfterTruncation: true,
          progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
        });

        assert.isTrue(result.stderrTruncated);
        assert.isAtMost(result.stderr.length, 600);
        assert.equal(lines.length, 129);
        assert.equal(lines[0], "é001");
        assert.equal(lines[127], "é128");
        assert.equal(lines.at(-1), "fatal: last line");
        // No replacement characters: the cap landing inside "é" is invisible to callbacks.
        assert.isFalse(lines.some((line) => line.includes("\uFFFD")));
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const notAWorktree = pathService.join(cwd, "not-a-worktree");
        yield* fileSystem.makeDirectory(notAWorktree);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver.removeWorktree({ cwd, path: notAWorktree }).pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 3,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notProperty(error, "stderr");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("loads repository-relative files from a nested project directory", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/nested"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "committed\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "changed\n");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const nestedCwd = path.join(cwd, "nested");
        const preview = yield* driver.getReviewDiffPreview({
          cwd: nestedCwd,
          baseRef: initialBranch,
        });
        assert.equal(
          preview.sources.find((source) => source.kind === "working-tree")!.files!.length,
          2,
        );
        for (const source of preview.sources) {
          for (const file of source.files ?? []) {
            const scoped = yield* driver.getReviewDiffPreview({
              cwd: nestedCwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = scoped.sources.find((item) => item.kind === source.kind)!;
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
          }
        }
      }),
    );

    it.effect("reads complete tracked and untracked manifests beyond 1 MB", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const mergeBase = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked content\n");
        const paths = Array.from({ length: 5000 }, (_, index) => `${"a".repeat(220)}-${index}.txt`);
        const stats = paths.map((path) => `1\t0\t${path}\0`).join("");
        const untracked = [...paths, "untracked.txt"].join("\0") + "\0";
        assert.isAbove(stats.length, 1024 * 1024);
        assert.isAbove(untracked.length, 1024 * 1024);
        let readLargeUntracked = false;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            if (command.args.includes("--numstat") && command.args.includes(mergeBase)) {
              return Effect.succeed(makeSuccessfulHandle(stats));
            }
            if (command.args.includes("ls-files") && command.args.includes("--others")) {
              return Effect.succeed(makeSuccessfulHandle(readLargeUntracked ? untracked : ""));
            }
          }
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const branch = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const files = branch.sources.find((source) => source.kind === "branch-range")!.files!;
        assert.equal(files.length, paths.length);
        assert.equal(files.at(-1)?.path, paths.at(-1));
        assert.equal(
          files.reduce((total, file) => total + file.additions, 0),
          paths.length,
        );
        readLargeUntracked = true;
        const dirty = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
        });
        const source = dirty.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(source.diff, "+untracked content");
      }),
    );

    it.effect("propagates patch failures instead of reporting an empty complete diff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "changed\n");
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--patch")
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const result = yield* driver.getReviewDiffPreview({ cwd }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.getReviewDiffPreview.patch");
        }
      }),
    );

    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.deepStrictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.files,
          [],
        );
        assert.deepStrictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.files,
          [],
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.noprefix", "true"]);
        yield* git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(cwd, ["checkout", "-b", "feature/noprefix"]);
        yield* writeTextFile(cwd, "README.md", "# committed change\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "committed change"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });

        const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
        const branchRange = preview.sources.find((source) => source.kind === "branch-range")?.diff;
        assert.include(workingTree, "diff --git a/README.md b/README.md");
        assert.include(workingTree, "+++ b/untracked.txt");
        assert.include(branchRange, "diff --git a/README.md b/README.md");
      }),
    );

    it.effect.each([
      // Windows filenames cannot contain ':', so long-form magic exists only elsewhere.
      ...(HostProcessPlatform.defaultValue() === "win32" ? [] : [":(exclude)after.ts"]),
      "[o]rdinary.ts",
    ])("keeps untracked filename %s with pathspec magic in the review", (magicName) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, magicName, "literal pathspec contents\n");
        yield* writeTextFile(cwd, "ordinary.ts", "ordinary contents\n");
        const indexBefore = yield* git(cwd, ["ls-files", "--stage"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "+literal pathspec contents");
        assert.include(diff, "+ordinary contents");
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: {
            path: magicName,
            previousPath: null,
            sourceKind: "working-tree",
          },
        });
        const scopedSource = scoped.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, [
          { path: magicName, previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(scopedSource.diff, "+literal pathspec contents");
        assert.notInclude(scopedSource.diff, "ordinary.ts");
        assert.strictEqual(yield* git(cwd, ["ls-files", "--stage"]), indexBefore);
      }),
    );

    it.effect("detects an unstaged rename with edits without mutating a split index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "before.ts", "one\ntwo\nthree\nfour\nfive\n");
        yield* git(cwd, ["add", "before.ts"]);
        yield* git(cwd, ["commit", "-m", "add source file"]);
        yield* git(cwd, ["config", "core.splitIndex", "true"]);
        yield* git(cwd, ["config", "splitIndex.sharedIndexExpire", "now"]);
        yield* git(cwd, ["update-index", "--split-index"]);
        const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
        const indexHashBefore = yield* git(cwd, ["hash-object", indexPath]);
        const gitDirValue = yield* git(cwd, ["rev-parse", "--git-dir"]);
        const gitDir = pathService.isAbsolute(gitDirValue)
          ? gitDirValue
          : pathService.resolve(cwd, gitDirValue);
        const sharedIndexesBefore = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();
        yield* fileSystem.rename(
          pathService.join(cwd, "before.ts"),
          pathService.join(cwd, "after.ts"),
        );
        yield* writeTextFile(cwd, "after.ts", "one\ntwo\nTHREE\nfour\nfive\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";
        const indexHashAfter = yield* git(cwd, ["hash-object", indexPath]);
        const sharedIndexesAfter = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();

        const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "after.ts", previousPath: "before.ts", additions: 1, deletions: 1 },
        ]);
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "after.ts", previousPath: "before.ts", sourceKind: "working-tree" },
        });
        const scopedSource = scoped.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, source.files);
        assert.equal(scopedSource.diff, diff);
        assert.include(diff, "rename from before.ts");
        assert.include(diff, "rename to after.ts");
        assert.include(diff, "-three");
        assert.include(diff, "+THREE");
        assert.strictEqual(diff.match(/^diff --git /gm)?.length, 1);
        assert.strictEqual(indexHashAfter, indexHashBefore);
        assert.deepStrictEqual(sharedIndexesAfter, sharedIndexesBefore);
      }),
    );

    it.effect("keeps tracked changes visible when untracked discovery fails", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const failingLsFilesSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("expected a standard Git command");
          }
          return command.args[0] === "ls-files" && command.args[1] === "--others"
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingLsFilesSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
        );
        yield* writeTextFile(cwd, "README.md", "# tracked change\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "-# test");
        assert.include(diff, "+# tracked change");
      }),
    );

    it.effect("preserves a staged deletion when the removed path still exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "removed.txt", "remove me\n");
        yield* git(cwd, ["add", "removed.txt"]);
        yield* git(cwd, ["commit", "-m", "add removable file"]);
        yield* git(cwd, ["rm", "--cached", "removed.txt"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "deleted file mode");
        assert.include(diff, "-remove me");
        assert.notInclude(diff, "new file mode");
      }),
    );

    it.effect("keeps untracked files visible before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* writeTextFile(cwd, "untracked.txt", "visible before HEAD\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

        assert.include(source?.diff, "visible before HEAD");
        assert.equal(source?.truncated, false);
      }),
    );

    it.effect.each([false, true])(
      "keeps the preceding second cached in review previews (split: %s)",
      (splitIndex) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".gitattributes", "stable.txt filter=probe\n");
          yield* writeTextFile(cwd, "stable.txt", "unchanged\n");
          yield* writeTextFile(
            cwd,
            ".git/filter.cjs",
            'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
          );
          yield* git(cwd, ["config", "filter.probe.clean", "node .git/filter.cjs"]);
          yield* fs.utimes(path.join(cwd, "stable.txt"), 1_699_999_999.5, 1_699_999_999.5);
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "cache stable file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          const indexPath = path.join(cwd, ".git", "index");
          yield* fs.utimes(indexPath, 1_700_000_000, 1_700_000_000);
          const originalIndex = yield* fs.readFile(indexPath);
          const originalMtime = (yield* fs.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, ".git/filter-runs", "");
          yield* writeTextFile(cwd, "untracked.txt", "new\n");
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "working-tree")!.files,
            [{ path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
          assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/filter-runs")), "");
          assert.deepStrictEqual(yield* fs.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fs.stat(indexPath)).mtime, originalMtime);
        }),
    );

    it.effect.each([
      [1_700_000_000, false],
      [1_700_000_000.9999, false],
      [1_700_000_000, true],
      [1_700_000_000.9999, true],
    ] as const)(
      "preserves same-size edits with a racy review index (%s, split: %s)",
      ([timestamp, splitIndex]) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const filePath = path.join(cwd, "tracked.txt");
          const indexPath = path.join(cwd, ".git", "index");
          // Reproduce a same-timestamp edit without relying on filesystem clock resolution.
          yield* git(cwd, ["config", "core.trustctime", "false"]);
          yield* writeTextFile(cwd, "tracked.txt", "before\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* git(cwd, ["add", "tracked.txt"]);
          yield* git(cwd, ["commit", "-m", "record racy file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          yield* fileSystem.utimes(indexPath, timestamp, timestamp);
          const originalIndex = yield* fileSystem.readFile(indexPath);
          const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, "tracked.txt", "after!\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* writeTextFile(cwd, "untracked.txt", "new\n");

          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
          assert.deepStrictEqual(dirty.files, [
            { path: "tracked.txt", previousPath: null, additions: 1, deletions: 1 },
            { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
          ]);
          assert.include(dirty.diff, "-before");
          assert.include(dirty.diff, "+after!");
          assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
        }),
    );

    it.effect("keeps complete stats for files beyond the combined patch limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const largeContents = "a long line of changed content for the diff preview\n".repeat(4000);
        yield* git(cwd, ["checkout", "-b", "feature/large"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents);
        yield* writeTextFile(cwd, "z-last.txt", "last file\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "large change"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents.replaceAll("changed", "updated"));
        yield* writeTextFile(cwd, "z-last.txt", "last file updated\n");
        yield* writeTextFile(cwd, "untracked.txt", largeContents);

        const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.isTrue(branch.truncated);
        assert.isTrue(dirty.truncated);
        assert.notInclude(branch.diff, "z-last.txt");
        for (const source of [branch, dirty]) {
          for (const file of source.files ?? []) {
            const individual = yield* driver.getReviewDiffPreview({
              cwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = individual.sources.find((candidate) => candidate.kind === source.kind)!;
            assert.isFalse(patch.truncated);
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
            assert.isEmpty(
              individual.sources.find((candidate) => candidate.kind !== source.kind)!.diff,
            );
          }
        }

        assert.deepStrictEqual(branch.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.deepStrictEqual(dirty.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 4000 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("preserves renames, unusual paths, modes, and binary statistics", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "mode-only.sh", "echo unchanged\n");
        yield* git(cwd, ["add", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "add executable candidate"]);
        yield* git(cwd, ["checkout", "-b", "feature/paths"]);
        yield* git(cwd, ["mv", "README.md", "renamed.md"]);
        yield* writeTextFile(cwd, "[literal].txt", "literal\n");
        yield* writeTextFile(cwd, " leading.txt", "whitespace path\n");
        yield* writeTextFile(cwd, "l.txt", "other\n");
        yield* writeTextFile(cwd, "binary.dat", "binary\0data");
        if ((yield* HostProcessPlatform) !== "win32") {
          yield* writeTextFile(cwd, "tab\tand\nnewline.txt", "unusual path\n");
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["update-index", "--chmod=+x", "mode-only.sh"]);
        // The preview compares against the working tree, so its mode must match the index.
        if ((yield* HostProcessPlatform) !== "win32") {
          yield* (yield* FileSystem.FileSystem).chmod(
            (yield* Path.Path).join(cwd, "mode-only.sh"),
            0o755,
          );
        }
        yield* git(cwd, ["commit", "-m", "rename and add files"]);
        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        for (const path of ["renamed.md", "[literal].txt", " leading.txt", "mode-only.sh"]) {
          const stat = branch.files!.find((file) => file.path === path)!;
          const request = yield* Schema.decodeEffect(ReviewDiffPreviewInput)({
            cwd,
            baseRef: initialBranch,
            file: { path, previousPath: stat.previousPath, sourceKind: "branch-range" },
          });
          const result = yield* driver.getReviewDiffPreview(request);
          const scoped = result.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scoped.files, [stat]);
          assert.notInclude(scoped.diff, "b/l.txt");
          if (path === "renamed.md") assert.include(scoped.diff, "rename from README.md");
          if (path === "mode-only.sh") {
            assert.include(scoped.diff, "old mode 100644");
            assert.include(scoped.diff, "new mode 100755");
          }
        }
        assert.include(branch.diff, "rename from README.md");
        assert.include(branch.diff, "rename to renamed.md");
        assert.deepInclude(branch.files ?? [], {
          path: "renamed.md",
          previousPath: "README.md",
          additions: 0,
          deletions: 0,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "binary.dat",
          previousPath: null,
          additions: 0,
          deletions: 0,
        });
        if ((yield* HostProcessPlatform) !== "win32") {
          assert.deepInclude(branch.files ?? [], {
            path: "tab\tand\nnewline.txt",
            previousPath: null,
            additions: 1,
            deletions: 0,
          });
        }
      }),
    );

    it.effect("reports staged and untracked changes before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(dirty.files, [
          { path: "staged.txt", previousPath: null, additions: 1, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(dirty.diff, "b/staged.txt");
        assert.include(dirty.diff, "b/untracked.txt");
      }),
    );

    it.effect("loads full file contents for working-tree diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "nested/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
      }),
    );

    it.effect("refuses diff expansion inside an app state folder", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        // A repository in an instance home's state folder, as a worker might make in
        // a checkout: neither side of the diff may be read back.
        const cwd = pathService.join(yield* makeTmpDir(), ".specwithcode", "userdata", "repo");
        yield* writeTextFile(cwd, ".keep", "");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "sk-test-working-tree\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(makeReviewDiffFileContentsInput(cwd))
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitCommandError");
        assert.strictEqual(error.detail, "Could not read diff file 'README.md'.");
        assert.notInclude(JSON.stringify(error), "sk-test-working-tree");
      }),
    );

    it.effect("keeps protected files out of review diff previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        // A repository can track app state (or a dotfiles repository the home).
        yield* writeTextFile(cwd, ".specwithcode/userdata/settings.json", "{}\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "track state"]);
        yield* writeTextFile(
          cwd,
          ".specwithcode/userdata/settings.json",
          '{"k":"sk-test-tracked"}\n',
        );
        yield* writeTextFile(cwd, ".specwithcode/userdata/secrets/k.txt", "sk-test-untracked\n");
        yield* writeTextFile(cwd, "README.md", "# changed\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        for (const source of preview.sources) {
          assert.notInclude(source.diff, "sk-test-");
          assert.notInclude(source.diff, ".specwithcode/userdata");
          assert.deepStrictEqual(
            (source.files ?? []).map((file) => file.path),
            ["README.md"],
          );
        }

        for (const filePath of [
          ".specwithcode/userdata/settings.json",
          ".specwithcode/userdata/secrets/k.txt",
        ]) {
          const request = yield* Schema.decodeEffect(ReviewDiffPreviewInput)({
            cwd,
            file: { path: filePath, previousPath: null, sourceKind: "working-tree" },
          });
          const error = yield* driver.getReviewDiffPreview(request).pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.notInclude(JSON.stringify(error), "sk-test-");
        }
      }),
    );

    it.effect("leaves out both sides of a rename that touches a protected file", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const protectedPath = ".specwithcode/userdata/settings.json";
        const contents = Array.from({ length: 12 }, (_, line) => `"k${line}": "sk-test-${line}"`);
        for (const [from, to] of [
          [protectedPath, "notes.json"],
          ["plain.json", protectedPath],
        ] as const) {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, from, `${contents.join("\n")}\n`);
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "track"]);
          NodeFS.mkdirSync(pathService.dirname(pathService.join(cwd, to)), { recursive: true });
          yield* git(cwd, ["mv", from, to]);
          yield* writeTextFile(cwd, "README.md", "# changed\n");
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const preview = yield* driver.getReviewDiffPreview({ cwd });
          for (const source of preview.sources) {
            // The patch and the file list agree: neither side of the rename appears.
            assert.deepStrictEqual(
              (source.files ?? []).map((file) => file.path),
              ["README.md"],
            );
            assert.notInclude(source.diff, "sk-test-");
            assert.notInclude(source.diff, from);
            assert.notInclude(source.diff, to);
            assert.include(source.diff, "README.md");
          }
        }
      }),
    );

    it.effect("reads the old side from the repository top, never git's working folder", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const repo = yield* makeTmpDir();
        yield* initRepoWithCommit(repo);
        yield* writeTextFile(repo, ".specwithcode/userdata/settings.json", '{"k":"sk-test-top"}\n');
        yield* writeTextFile(repo, ".specwithcode/userdata/sub/.keep", "");
        yield* git(repo, ["add", "."]);
        yield* git(repo, ["commit", "-m", "track state"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const state = pathService.join(repo, ".specwithcode", "userdata");

        for (const [cwd, oldPath] of [
          [state, "./settings.json"],
          [pathService.join(state, "sub"), "../settings.json"],
          [repo, "./.specwithcode/userdata/settings.json"],
          [repo, ".specwithcode//userdata/settings.json"],
          [repo, "docs/../.specwithcode/userdata/settings.json"],
        ] as const) {
          const error = yield* driver
            .getReviewDiffFileContents(
              makeReviewDiffFileContentsInput(cwd, {
                sourceKind: "working-tree",
                baseRef: null,
                changeType: "deleted",
                oldPath,
                newPath: oldPath,
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.notInclude(JSON.stringify(error), "sk-test-top");
        }

        // A plain path still reads from the top, whatever folder the request names.
        const readme = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(state, "sub"), {
            baseRef: null,
            changeType: "deleted",
          }),
        );
        assert.strictEqual(readme.oldContents, "# test\n");

        // A per-file preview refuses the same shapes.
        for (const filePath of ["./README.md", "../README.md", "a/./README.md"]) {
          const request = yield* Schema.decodeEffect(ReviewDiffPreviewInput)({
            cwd: repo,
            file: { path: filePath, previousPath: null, sourceKind: "working-tree" },
          });
          const error = yield* driver.getReviewDiffPreview(request).pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
        }
      }),
    );

    it.effect("leaves protected files out of the Changes totals", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".specwithcode/userdata/settings.json", "{}\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "track state"]);
        yield* writeTextFile(cwd, ".specwithcode/userdata/settings.json", "a\nb\nc\nd\n");
        yield* writeTextFile(cwd, "README.md", "# test\nmore\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: 1,
          deletions: 0,
        });
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(
          (changes.files ?? []).map((file) => [file.path, file.additions, file.deletions]),
          [["README.md", 1, 0]],
        );
      }),
    );

    it.effect("shows a patch with more protected files than one command line holds", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const state = Array.from(
          { length: 210 },
          (_, index) => `.specwithcode/userdata/s${index}.txt`,
        );
        const allowed = Array.from({ length: 250 }, (_, index) => `src/a${index}.txt`);
        for (const filePath of [...state, ...allowed]) yield* writeTextFile(cwd, filePath, "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "many"]);
        for (const filePath of state) yield* writeTextFile(cwd, filePath, "sk-test-state\n");
        for (const filePath of allowed) yield* writeTextFile(cwd, filePath, "two\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.notInclude(dirty.diff, "sk-test-state");
        assert.strictEqual(dirty.truncated, false);
        assert.strictEqual(dirty.diff.match(/^diff --git /gm)?.length, allowed.length);
        assert.deepStrictEqual(
          (dirty.files ?? []).map((file) => file.path).toSorted(),
          allowed.toSorted(),
        );
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: allowed.length,
          deletions: allowed.length,
        });
      }),
    );

    it.effect("fails closed on review paths that cannot be resolved", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "gone.txt", "deleted\n");
        NodeFS.mkdirSync(pathService.join(cwd, "locked"));
        yield* writeTextFile(cwd, "locked/secret.txt", "before\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "more"]);
        NodeFS.rmSync(pathService.join(cwd, "gone.txt"));
        yield* writeTextFile(cwd, "locked/secret.txt", "sk-test-locked\n");
        yield* writeTextFile(cwd, "README.md", "# changed\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const failing =
          (fails: (target: string) => boolean) =>
          (target: string): Promise<string> =>
            fails(target)
              ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
              : WorkspaceSensitivePaths.realpathNative(target);
        const filesOf = (preview: {
          readonly sources: ReadonlyArray<{
            readonly files?: ReadonlyArray<{ readonly path: string }>;
          }>;
        }) =>
          preview.sources.map((source) => (source.files ?? []).map((file) => file.path).toSorted());

        // A deleted file still resolves through its folder; a file whose folder
        // cannot be resolved is left out.
        const preview = yield* driver.getReviewDiffPreview({ cwd }).pipe(
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsRealpath,
            failing((target) => pathService.basename(target) === "locked"),
          ),
        );
        assert.deepStrictEqual(filesOf(preview), [
          ["README.md", "gone.txt"],
          ["README.md", "gone.txt"],
        ]);
        for (const source of preview.sources) assert.notInclude(source.diff, "sk-test-locked");

        // A root that cannot be resolved shows nothing.
        const rootName = pathService.basename(cwd);
        const unresolvedRoot = yield* driver.getReviewDiffPreview({ cwd }).pipe(
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsRealpath,
            failing((target) => pathService.basename(target) === rootName),
          ),
        );
        assert.deepStrictEqual(filesOf(unresolvedRoot), [[], []]);
        for (const source of unresolvedRoot.sources) assert.strictEqual(source.diff, "");
      }),
    );

    it.effect("never runs a repository's fsmonitor program", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        if ((yield* HostProcessPlatform) === "win32") return;
        const marker = pathService.join(yield* makeTmpDir(), "fsmonitor-ran");
        const hook = pathService.join(yield* makeTmpDir(), "fsmonitor.sh");
        NodeFS.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
        // A planted .git/config names a program that git status and git diff run.
        yield* git(cwd, ["config", "core.fsmonitor", hook]);
        yield* writeTextFile(cwd, "README.md", "# changed\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.getReviewDiffPreview({ cwd });
        yield* driver.status({ cwd }).pipe(Effect.ignore);

        assert.isFalse(NodeFS.existsSync(marker));
      }),
    );

    it.effect("refuses diff expansion when the state folder is spelled another way", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const tmp = yield* makeTmpDir();
        const cwd = pathService.join(tmp, ".specwithcode", "userdata", "repo");
        yield* writeTextFile(cwd, ".keep", "");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "sk-test-spelled-tree\n");
        // APFS treats `S` and `\u017f` (long s) as `s`; skip where the file system does not.
        const spelled = pathService.join(tmp, ".\u017fpecwithcode", "USERDATA", "repo");
        if (!NodeFS.existsSync(spelled)) return;
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(makeReviewDiffFileContentsInput(spelled))
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitCommandError");
        assert.strictEqual(error.detail, "Could not read diff file 'README.md'.");
        assert.notInclude(JSON.stringify(error), "sk-test-spelled-tree");
      }),
    );

    it.effect("refuses a diff path naming an app home in another spelling", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".specwithcode/userdata/settings.json", '{"k":"sk-test-home"}');
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // `\u017f` (long s) and upper case name the same folder on APFS; the
        // guard folds them on macOS and Windows whatever the file system.
        for (const newPath of [
          ".\u017fpecwithcode/userdata/settings.json",
          ".SPECWITHCODE/USERDATA/settings.json",
        ]) {
          const error = yield* driver
            .getReviewDiffFileContents(
              makeReviewDiffFileContentsInput(cwd, {
                changeType: "new",
                oldPath: newPath,
                newPath,
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.notInclude(JSON.stringify(error), "sk-test-home");
        }
      }),
    );

    it.effect("never passes a client ref to git as an option", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const outside = pathService.join(yield* makeTmpDir(), "written-by-git-show");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        for (const sourceKind of ["working-tree", "branch-range"] as const) {
          const error = yield* driver
            .getReviewDiffFileContents(
              makeReviewDiffFileContentsInput(cwd, { sourceKind, baseRef: `--output=${outside}` }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.include(error.detail, "is not a branch or commit");
        }
        // The review base goes to git merge-base, which gets no --end-of-options
        // (older git lacks it): the leading dash alone refuses it.
        for (const baseRef of [`--output=${outside}`, "-p", "--all"]) {
          const error = yield* driver.getReviewDiffPreview({ cwd, baseRef }).pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.include(error.detail, "is not a branch or commit");
        }
        assert.isFalse(NodeFS.existsSync(outside));

        // A ref that names no commit is refused before git show reads it.
        const missing = yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { baseRef: "no-such-branch" }),
          )
          .pipe(Effect.flip);
        assert.include(missing.detail, "'no-such-branch' is not a branch or commit.");
      }),
    );

    it.effect("attributes working-tree filesystem failures to the failing operation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "missing.ts",
              newPath: "missing.ts",
            }),
          )
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
          command: "fs.realPath",
          cwd,
          detail: "Could not resolve diff file 'missing.ts'.",
        });
      }),
    );

    it.effect("loads new and deleted files without reading their missing side", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
        yield* fileSystem.remove(pathService.join(cwd, "README.md"));

        const [added, deleted] = yield* Effect.all([
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "added.ts",
              newPath: "added.ts",
            }),
          ),
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
          ),
        ]);

        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "export const added = true;\n",
        });
        assert.deepStrictEqual(deleted, {
          oldContents: "# test\n",
          newContents: "",
        });
      }),
    );

    it.effect("loads merge-base and disk contents for Changes expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/context"]);
        yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change readme"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: initialBranch,
            headRef: "feature/context",
          }),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# dirty change\nunchanged context\n");
      }),
    );

    it.effect("Changes combines commits, uncommitted edits, and untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const sourceFiles = (
          preview: ReviewDiffPreviewResult,
          kind: "working-tree" | "branch-range",
        ) => preview.sources.find((source) => source.kind === kind)!.files;
        yield* git(cwd, ["checkout", "-b", "feature/combined"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);

        // A fully committed branch has no uncommitted work, but Changes still shows it.
        const clean = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(sourceFiles(clean, "working-tree"), []);
        assert.deepStrictEqual(sourceFiles(clean, "branch-range"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
        ]);

        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\ndirty\n");
        yield* writeTextFile(cwd, "new.txt", "new\n");
        const dirty = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const changes = dirty.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "README.md", previousPath: null, additions: 2, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.strictEqual(changes.diff.match(/^diff --git a\/README\.md /gm)?.length, 1);
        assert.include(changes.diff, "+dirty");
        assert.deepStrictEqual(sourceFiles(dirty, "working-tree"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("Changes on the default branch compares with its remote copy", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* writeTextFile(cwd, "unpushed.txt", "unpushed\n");
        yield* git(cwd, ["add", "unpushed.txt"]);
        yield* git(cwd, ["commit", "-m", "unpushed"]);

        // Without a remote there is no base, so Changes equals Uncommitted.
        const local = yield* driver.getReviewDiffPreview({ cwd });
        const localChanges = local.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(localChanges.baseRef);
        assert.deepStrictEqual(localChanges.files, []);

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]);
        yield* git(cwd, ["fetch", "origin"]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "origin/main");
        assert.deepStrictEqual(changes.files, [
          { path: "unpushed.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("Changes accepts an explicit base on a detached HEAD and rejects a bad one", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "--detach"]);
        yield* writeTextFile(cwd, "detached.txt", "detached\n");
        yield* git(cwd, ["add", "detached.txt"]);
        yield* git(cwd, ["commit", "-m", "detached work"]);

        const explicit = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(
          explicit.sources.find((source) => source.kind === "branch-range")!.files,
          [{ path: "detached.txt", previousPath: null, additions: 1, deletions: 0 }],
        );
        const implicit = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(
          implicit.sources.find((source) => source.kind === "branch-range")!.files,
          [],
        );
        const error = yield* driver
          .getReviewDiffPreview({ cwd, baseRef: "missing-base" })
          .pipe(Effect.flip);
        assert.strictEqual(error.operation, "GitVcsDriver.resolveReviewMergeBase");
      }),
    );

    it.effect("Changes compares with the empty tree before the first commit", () =>
      Effect.gen(function* () {
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(upstream);
        yield* git(upstream, ["branch", "-M", "main"]);
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // An unborn main whose remote copy exists must not fail on merge-base.
        yield* git(cwd, ["init", "-b", "main"]);
        yield* git(cwd, ["remote", "add", "origin", upstream]);
        yield* git(cwd, ["fetch", "origin"]);
        yield* writeTextFile(cwd, "new.txt", "one\ntwo\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(changes.baseRef);
        assert.deepStrictEqual(changes.files, [
          { path: "new.txt", previousPath: null, additions: 2, deletions: 0 },
        ]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: 2,
          deletions: 0,
        });
      }),
    );

    it.effect("Changes does not show newer base commits as deletions", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/rebased"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "base moves"]);
        yield* git(cwd, ["checkout", "feature/rebased"]);

        for (const rebase of [false, true]) {
          if (rebase) yield* git(cwd, ["rebase", initialBranch]);
          const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "branch-range")!.files,
            [{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
        }
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reads Changes totals with untracked files when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);
        yield* writeTextFile(cwd, "nested/untracked.txt", "one\ntwo\n");

        const status = yield* driver.statusDetailsLocal(pathService.join(cwd, "nested"), {
          includeBranchChanges: true,
        });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "main",
          insertions: 3,
          deletions: 0,
        });
        assert.isUndefined((yield* driver.statusDetailsLocal(cwd)).branchChanges);
      }),
    );

    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports changes to a file named HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "HEAD", "first line\n");
        yield* git(cwd, ["add", "HEAD"]);
        yield* git(cwd, ["commit", "-m", "add HEAD file"]);
        yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "HEAD",
          insertions: 1,
          deletions: 0,
        });
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("ignores a recorded base that shares no history with the branch", () =>
      Effect.gen(function* () {
        // A worktree started from `main` and then reset onto an unrelated `develop`
        // keeps `gh-merge-base main`; it has nothing of its own to propose.
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", initialBranch, "main"]);
        yield* git(cwd, ["checkout", "--orphan", "develop"]);
        yield* writeTextFile(cwd, "develop.txt", "develop\n");
        yield* git(cwd, ["add", "develop.txt"]);
        yield* git(cwd, ["commit", "-m", "develop root"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "main", "develop"]);
        yield* git(cwd, ["remote", "set-head", "origin", "develop"]);
        yield* git(cwd, ["checkout", "-b", "ops/watch", "main"]);
        yield* git(cwd, ["config", "branch.ops/watch.gh-merge-base", "main"]);
        yield* git(cwd, ["checkout", "-B", "ops/watch", "--track", "origin/develop"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(cwd);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);

        const error = yield* driver.readRangeContext(cwd, "origin/main").pipe(Effect.flip);
        assert.include(error.message, "no merge base");
      }),
    );

    it.effect("keeps a recorded base whose common commit a shallow clone cut off", () =>
      Effect.gen(function* () {
        const source = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(source);
        yield* git(source, ["branch", "-M", initialBranch, "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "origin", "main"]);
        const cwd = yield* makeTmpDir("git-vcs-driver-shallow-");
        yield* git(cwd, ["clone", "--depth", "1", `file://${remote}`, "."]);
        yield* git(cwd, ["config", "user.email", "test@example.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* git(cwd, ["checkout", "-b", "feature/shallow"]);
        yield* git(cwd, ["config", "branch.feature/shallow.gh-merge-base", "main"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature"]);
        yield* writeTextFile(source, "base.txt", "base\n");
        yield* git(source, ["add", "base.txt"]);
        yield* git(source, ["commit", "-m", "base advances"]);
        yield* git(source, ["push", "origin", "main"]);
        yield* git(cwd, ["fetch", "--depth", "1", "origin", "+main:refs/remotes/origin/main"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
        assert.isAbove(status.aheadOfDefaultCount, 0);
      }),
    );

    it.effect("can read local files without traversing revision history", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/local-only"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\nlocal edit\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: ReadonlyArray<string>[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            commands.push(command.args);
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        for (const hasUpstream of [false, true]) {
          if (hasUpstream) {
            yield* git(cwd, ["push", "-u", "origin", "feature/local-only"]);
          }
          commands.length = 0;
          const local = yield* driver.statusDetailsLocal(cwd, { includeDivergence: false });
          assert.isFalse(commands.some((args) => args.includes("rev-list")));
          assert.isTrue(commands.some((args) => args.includes("--no-ahead-behind")));
          assert.equal(local.hasUpstream, hasUpstream);
          assert.isTrue(local.hasWorkingTreeChanges);
          assert.deepEqual(local.workingTree.files, [
            { path: "feature.txt", insertions: 1, deletions: 0 },
            { path: "untracked.txt", insertions: 0, deletions: 0 },
          ]);

          commands.length = 0;
          const full = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(commands.some((args) => args.includes("rev-list")));
          assert.equal(full.aheadCount, hasUpstream ? 0 : 1);
          assert.equal(full.aheadOfDefaultCount, 1);
          assert.deepEqual(local, {
            ...full,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          });
        }
      }),
    );

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("reports remote status on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("does not start Git auto-maintenance from background upstream fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["repack", "-d"]);
        yield* writeTextFile(cwd, "second.txt", "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "second commit"]);
        yield* git(cwd, ["push"]);
        yield* git(cwd, ["repack", "-d"]);
        // Two packs make `git gc --auto` due, and without detaching it would run inside the fetch.
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        const packCount = git(cwd, ["count-objects", "-v"]).pipe(
          Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
        );
        assert.equal(yield* packCount, "2");

        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(yield* packCount, "2");
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = yield* pathService.fromFileUrl(
          new URL("./testing/GitVcsDriverCore.fixture.sh", import.meta.url),
        );
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "STUDIO_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.STUDIO_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports combined staged and unstaged edits to the same file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* git(cwd, ["commit", "-m", "add feature"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        const file = status.workingTree.files.find((f) => f.path === "feature.ts");
        assert.ok(file);
        // HEAD has 1 line. Staged has 2 lines (+1). Unstaged has 3 lines (+2 from HEAD).
        // Combined net from HEAD: +2 insertions.
        assert.equal(file.insertions, 2);
        assert.equal(file.deletions, 0);
      }),
    );

    it.effect("reports staged file counts on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.ts", "// first file\n");
        yield* git(cwd, ["add", "initial.ts"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.workingTree.files.length, 1);
        const file = status.workingTree.files[0];
        if (file) {
          assert.equal(file.path, "initial.ts");
          assert.equal(file.insertions, 1);
        }
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("marks the origin default ref as default when no local copy exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
        yield* git(cwd, ["branch", "-D", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
        assert.equal(remoteDefault?.isRemote, true);
        assert.equal(remoteDefault?.isDefault, true);
      }),
    );

    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("preserves exact custom names and refuses collisions without a suffix", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createRef({ cwd, refName: "Alice/ABC-123" });
        const failed = yield* driver
          .renameBranch({
            cwd,
            oldBranch: initialBranch,
            newBranch: "Alice/ABC-123",
            exactName: true,
          })
          .pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: initialBranch,
          newBranch: "Alice/ABC-124.v2",
          exactName: true,
        });
        assert.equal(renamed.branch, "Alice/ABC-124.v2");
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );

    it.effect("rejects a missing branch without restoring a matching dirty file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "obsolete-branch", "original\n");
        yield* git(cwd, ["add", "obsolete-branch"]);
        yield* git(cwd, ["commit", "-m", "tracked file"]);
        yield* git(cwd, ["branch", "obsolete-branch"]);
        yield* git(cwd, ["branch", "-D", "obsolete-branch"]);
        yield* writeTextFile(cwd, "obsolete-branch", "uncommitted work\n");

        const result = yield* driver
          .switchRef({ cwd, refName: "obsolete-branch" })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "obsolete-branch")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
    );

    it.effect("still creates and reuses remote tracking branches and allows detached refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/remote-only"]);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = yield* driver.switchRef({ cwd, refName: "origin/remote-only" });
          assert.equal(result.refName, "remote-only");
          assert.equal(
            yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/remote-only",
          );
          yield* driver.switchRef({ cwd, refName: initialBranch });
        }
        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        const detached = yield* driver.switchRef({ cwd, refName: commit });
        assert.equal(detached.refName, null);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), commit);
      }),
    );
  });

  describe("shared .git/config lock", () => {
    const initRepoWithRemote = (cwd: string) =>
      Effect.gen(function* () {
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        return { initialBranch };
      });

    it.effect("creates parallel worktrees in one repository without racing on its config", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithRemote(cwd);
        const path = yield* Path.Path;
        const worktrees = yield* makeTmpDir("git-worktrees-");

        // Git has no lock timeout for .git/config, which every worktree shares: a writer that
        // overlaps another fails, and a branch can then be left without its worktree.
        let configWriters = 0;
        let peakConfigWriters = 0;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const countingSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args : [];
            const writesConfig =
              (args.includes("worktree") && args.includes("add") && args.includes("-b")) ||
              (args[0] === "branch" &&
                (args[1] === "-m" || args[1]?.startsWith("--set-upstream-to"))) ||
              (args[0] === "config" && !args[1]?.startsWith("-"));
            if (!writesConfig) return yield* delegate.spawn(command);
            configWriters += 1;
            peakConfigWriters = Math.max(peakConfigWriters, configWriters);
            const handle = yield* delegate.spawn(command);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.ensuring(Effect.sync(() => (configWriters -= 1))),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
          Effect.provide(layerServerConfig),
        );
        const branches = Array.from({ length: 8 }, (_, index) => `feature/parallel-${index}`);

        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.createWorktree({
              cwd,
              path: path.join(worktrees, branch.replace("/", "-")),
              refName: `origin/${initialBranch}`,
              newRefName: branch,
              baseRefName: `origin/${initialBranch}`,
            }),
          { concurrency: "unbounded" },
        );
        // Launches rename their temporary branch from inside the new worktree.
        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.renameBranch({
              cwd: path.join(worktrees, branch.replace("/", "-")),
              oldBranch: branch,
              newBranch: `${branch}-renamed`,
              exactName: true,
            }),
          { concurrency: "unbounded" },
        );

        assert.equal(peakConfigWriters, 1);
        for (const branch of branches) {
          const renamed = `${branch}-renamed`;
          assert.equal(yield* git(cwd, ["config", `branch.${renamed}.remote`]), "origin");
          assert.equal(
            yield* git(cwd, ["config", `branch.${renamed}.gh-merge-base`]),
            initialBranch,
          );
        }
      }),
    );

    it.effect("retries the base-branch write while another process holds the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const lockPath = path.join(cwd, ".git", "config.lock");
        // Another process takes the lock right after the checkout and releases it
        // once the base write has failed on it.
        const failures = yield* Ref.make(0);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command)) return handle;
            const args = command.args;
            if (args.includes("worktree")) {
              return ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => fileSystem.writeFileString(lockPath, "").pipe(Effect.orDie)),
                ),
              });
            }
            if (args[0] !== "config" || !args[1]?.endsWith(".gh-merge-base")) return handle;
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap((exitCode) =>
                  exitCode === 0
                    ? Effect.void
                    : Ref.update(failures, (count) => count + 1).pipe(
                        Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                        Effect.orDie,
                      ),
                ),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        // The retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "based"),
            refName: initialBranch,
            newRefName: "feature/based",
            baseRefName: initialBranch,
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/based.gh-merge-base"),
          initialBranch,
        );
      }),
    );

    it.effect("still creates the worktree when the base-branch config stays locked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const lockPath = path.join(cwd, ".git", "config.lock");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "locked");
        // Lock the config only once the checkout is done, so just the base write meets it.
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || !command.args.includes("worktree")) {
              return handle;
            }
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap(() => fileSystem.writeFileString(lockPath, "").pipe(Effect.orDie)),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        // The base write retries on the real clock before giving up.
        const created = yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/locked-config",
            baseRefName: initialBranch,
          }),
        );
        yield* fileSystem.remove(lockPath, { force: true });

        assert.deepEqual(created.worktree, {
          path: worktreePath,
          refName: "feature/locked-config",
        });
        assert.equal(
          yield* git(worktreePath, ["branch", "--show-current"]),
          "feature/locked-config",
        );
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/locked-config.gh-merge-base"),
          null,
        );
      }),
    );

    it.effect("tracks a remote start point once another process releases the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithRemote(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = path.join(cwd, ".git", "config.lock");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );
        // `git branch --no-track` writes no config, so only the tracking write meets the lock.
        yield* fileSystem.writeFileString(lockPath, "");

        // The upstream retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "tracked"),
            refName: `origin/${initialBranch}`,
            newRefName: "feature/tracked",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/tracked@{upstream}"]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("fetches a remote branch into a tracking branch past another process's lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/pr-head`]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        yield* TestClock.withLive(
          driver.fetchRemoteBranch({
            cwd,
            remoteName: "origin",
            remoteBranch: "pr-head",
            localBranch: "review/pr-head",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "review/pr-head@{upstream}"]),
          "origin/pr-head",
        );
      }),
    );

    it.effect("creates a PR checkout branch past another process's config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/pr-head`]);
        yield* git(cwd, ["fetch", "origin"]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        yield* TestClock.withLive(
          driver.createBranch({ cwd, branch: "review/pr-head", startPoint: "origin/pr-head" }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "review/pr-head@{upstream}"]),
          "origin/pr-head",
        );
      }),
    );

    it.effect("ensureRemote returns the remote a parallel call added for the same URL", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        // Hold the first add until both calls have listed remotes, so both decide to add.
        let listings = 0;
        const bothListed = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args : [];
            if (args[0] === "remote" && args[1] === "-v") {
              listings += 1;
              if (listings === 2) yield* Deferred.succeed(bothListed, undefined);
            }
            if (args[0] === "remote" && args[1] === "add") yield* Deferred.await(bothListed);
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const input = { cwd, preferredName: "fork", url: "https://github.com/fork/studio.git" };

        const names = yield* Effect.all([driver.ensureRemote(input), driver.ensureRemote(input)], {
          concurrency: "unbounded",
        });

        assert.deepEqual(names, ["fork", "fork"]);
      }),
    );

    it.effect("rebases a pushed branch's pulls when branch.autoSetupRebase asks for it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["config", "branch.autoSetupRebase", "always"]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/rebase"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), { setUpstream: true });
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/rebase.rebase"), "true");
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/rebase",
        );
      }),
    );

    it.effect("reports a push whose upstream could not be recorded", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/locked"]);
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // Recording the upstream retries on the real clock before giving up.
        const pushed = yield* TestClock.withLive(driver.pushCurrentBranch(cwd, null));

        assert.deepInclude(pushed, { status: "pushed", setUpstream: false });
        assert.include(
          yield* git(cwd, ["ls-remote", "origin", "refs/heads/feature/locked"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/locked.remote"), null);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("uses parallel checkout without skipping filters or hooks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "filter.test.smudge", "sed s/original/filtered/g"]);
        yield* writeTextFile(cwd, ".gitattributes", "asset.txt filter=test\n");
        yield* writeTextFile(cwd, "asset.txt", "original\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "filtered asset"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\ngit config checkout.workers > checkout-workers\nexit 0\n",
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        // A user's global core.hooksPath would bypass the repository's own hooks.
        yield* git(cwd, ["config", "core.hooksPath", path.join(cwd, ".git", "hooks")]);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "parallel");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/parallel",
          baseRefName: initialBranch,
        });

        assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "locked");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "checkout-workers")), "0\n");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "asset.txt")), "filtered\n");
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(
          yield* git(cwd, ["config", "branch.feature/parallel.gh-merge-base"]),
          initialBranch,
        );
        for (const [configured, expected] of [
          ["1", "1"],
          ["", "0"],
        ] as const) {
          yield* git(cwd, ["config", "checkout.workers", configured]);
          const configuredPath = path.join(yield* makeTmpDir("git-worktrees-"), "configured");
          yield* driver.createWorktree({
            cwd,
            path: configuredPath,
            refName: initialBranch,
            newRefName: `feature/configured-${expected}`,
          });
          assert.equal(
            yield* fs.readFileString(path.join(configuredPath, "checkout-workers")),
            `${expected}\n`,
          );
        }
      }),
    );
    it("parses checkout progress lines from git's stderr", () => {
      assert.deepStrictEqual(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)"), {
        percent: 78,
        completed: 2104,
        total: 2700,
      });
      // Progress lines arrive carriage-return separated and end with a done marker.
      assert.deepStrictEqual(
        parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done."),
        { percent: 100, completed: 2700, total: 2700 },
      );
      assert.strictEqual(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')"), null);
    });

    // NTFS rejects a newline in a file name, so there is nothing to preserve there.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "preserves newline characters in worktree paths when listing refs",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
          const pathService = yield* Path.Path;
          const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
          const driver = yield* GitVcsDriver.GitVcsDriver;

          yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

          const refs = yield* driver.listRefs({ cwd, refresh: true });
          const listedPath = refs.refs.find(
            (ref) => ref.name === "feature/newline-path",
          )?.worktreePath;

          if (typeof listedPath !== "string") {
            return assert.fail("expected the linked branch to include its worktree path");
          }
          assert.equal(
            NodeFS.realpathSync.native(listedPath),
            NodeFS.realpathSync.native(worktreePath),
          );
        }),
    );

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git refuses `file:` submodule transports by default (CVE-2022-39253)
        // and ignores repo-level config for it, so a local fixture needs the
        // env allowance. Real submodules are https/ssh and need none of this.
        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // A real submodule: `git worktree add` leaves these empty, which is
        // what silently strips shared tooling out of every new worktree.
        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        // Points at a repository that does not exist, so the checkout fails the
        // way an unreachable private remote would. Creation must still succeed.
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

    for (const interruptedStage of ["tracking", "checkout"] as const) {
      it.effect(`removes the new branch when cancelled during ${interruptedStage}`, () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const remote = yield* makeTmpDir("git-remote-");
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "origin", initialBranch]);
          const path = yield* Path.Path;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "cancelled");
          const reached = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              const handle = yield* delegate.spawn(command);
              if (!ChildProcess.isStandardCommand(command)) return handle;
              const matching =
                interruptedStage === "tracking"
                  ? command.args.some((arg) => arg.startsWith("--set-upstream-to"))
                  : command.args.includes("worktree") && command.args.includes("add");
              if (!matching) return handle;
              return ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(reached, undefined)),
                  Effect.tap(() => Deferred.await(resume)),
                ),
              });
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const launch = yield* driver
            .createWorktree({
              cwd,
              path: worktreePath,
              refName: `origin/${initialBranch}`,
              newRefName: "feature/cancelled",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          const interrupt = yield* Fiber.interrupt(launch).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          // Tracking is a bounded atomic step; release it after cancellation was requested.
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(interrupt);
          assert.notInclude(yield* git(cwd, ["branch", "--list"]), "feature/cancelled");
          assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), worktreePath);
        }),
      );
    }

    it.effect("creates worktrees under the configured worktrees directory", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" },
          { worktreesDirectory },
        );
        const expected = pathService.join(
          worktreesDirectory,
          pathService.basename(cwd),
          "feature-custom-dir",
        );
        assert.equal(created.worktree.path, expected);
        assert.equal(yield* fileSystem.exists(expected), true);
        assert.equal(
          yield* fileSystem.exists(
            pathService.join(worktreesDirectory, ServerConfig.SPOTLIGHT_NEVER_INDEX_FILE),
          ),
          (yield* HostProcessPlatform) === "darwin",
        );

        const error = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/relative-dir" },
            { worktreesDirectory: "relative/worktrees" },
          )
          .pipe(Effect.flip);
        assert.match(error.detail, /must be an absolute folder on this machine/);

        const rootError = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/root-dir" },
            { worktreesDirectory: "/" },
          )
          .pipe(Effect.flip);
        assert.match(rootError.detail, /not a drive root/);
      }),
    );

    it.effect(
      "creates project-local worktrees with private exclusions and rejects nested custom roots",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const exclude = path.join(cwd, ".git", "info", "exclude");
          yield* fs.writeFileString(exclude, "# keep local exclusions\n/private-draft\n");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const created = yield* driver.createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/project-local" },
            { worktreeLocationMode: "project" },
          );
          assert.isTrue(
            created.worktree.path.startsWith(
              path.join(yield* fs.realPath(cwd), ".specwithcode", "worktrees") + path.sep,
            ),
          );
          assert.equal(
            yield* fs.readFileString(exclude),
            "# keep local exclusions\n/private-draft\n/.specwithcode/worktrees/\n",
          );
          const status = yield* git(cwd, ["status", "--porcelain"]);
          assert.equal(status.trim(), "");
          for (const custom of [cwd, path.dirname(cwd), path.join(cwd, "nested")]) {
            const error = yield* driver
              .createWorktree(
                { cwd, path: null, refName: initialBranch, newRefName: "feature/unsafe" },
                { worktreeLocationMode: "custom", worktreesDirectory: custom },
              )
              .pipe(Effect.flip);
            assert.match(error.detail, /worktree location/);
          }
        }),
    );

    it.effect("resolves the submodule mode from the option, then specweave-studio.json", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // inner -> nested, so a recursive init populates nested/NESTED.md and
        // a top-level init leaves it empty.
        const nestedRepo = yield* makeTmpDir("git-nested-");
        yield* initRepoWithCommit(nestedRepo);
        yield* writeTextFile(nestedRepo, "NESTED.md", "# nested\n");
        yield* git(nestedRepo, ["add", "."]);
        yield* git(nestedRepo, ["commit", "-m", "nested"]);
        const innerRepo = yield* makeTmpDir("git-inner-");
        yield* initRepoWithCommit(innerRepo);
        yield* writeTextFile(innerRepo, "INNER.md", "# inner\n");
        yield* git(innerRepo, ["submodule", "add", nestedRepo, "nested"]);
        yield* git(innerRepo, ["add", "."]);
        yield* git(innerRepo, ["commit", "-m", "inner"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", innerRepo, "inner"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreesDir = yield* makeTmpDir("git-worktrees-");

        const createWithMode = Effect.fn(function* (
          fileMode: WorktreeSubmodules,
          branch: string,
          submodules: WorktreeSubmodules | null = null,
        ) {
          yield* writeTextFile(
            cwd,
            "specweave-studio.json",
            `{ "worktreeSubmodules": "${fileMode}" }`,
          );
          yield* git(cwd, ["add", "specweave-studio.json"]);
          // Consecutive cases may reuse a file mode to test the option alone.
          yield* git(cwd, ["commit", "--allow-empty", "-m", `submodules: ${fileMode}`]);
          const worktreePath = pathService.join(worktreesDir, branch);
          const disabled = yield* Ref.make<"settings" | "specweave-studio.json" | false>(false);
          yield* driver.createWorktree(
            { cwd, path: worktreePath, refName: initialBranch, newRefName: branch },
            {
              submodules,
              progress: { onSubmodulesDisabled: ({ source }) => Ref.set(disabled, source) },
            },
          );
          return {
            disabled: yield* Ref.get(disabled),
            inner: yield* fileSystem.exists(pathService.join(worktreePath, "inner", "INNER.md")),
            nested: yield* fileSystem.exists(
              pathService.join(worktreePath, "inner", "nested", "NESTED.md"),
            ),
          };
        });

        assert.deepEqual(yield* createWithMode("recursive", "recursive"), {
          disabled: false,
          inner: true,
          nested: true,
        });
        assert.deepEqual(yield* createWithMode("top-level", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        // A resolved setting outranks the file in both directions.
        assert.deepEqual(yield* createWithMode("recursive", "setting-none", "none"), {
          disabled: "settings",
          inner: false,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "setting-wins", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "none"), {
          disabled: "specweave-studio.json",
          inner: false,
          nested: false,
        });
      }),
    );

    it.effect("reports checkout progress during parallel worktree creation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        for (let index = 0; index < 200; index += 1) {
          yield* writeTextFile(cwd, `file-${index}.txt`, `${index}\n`);
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add files"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "progress-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const seen = yield* Ref.make<Array<{ percent: number; completed: number; total: number }>>(
          [],
        );
        const claimed = yield* Ref.make<{ path: string; existed: boolean } | null>(null);

        yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/progress" },
          {
            progress: {
              onWorktreeClaimed: (path) =>
                Ref.set(claimed, { path, existed: NodeFS.existsSync(path) }),
              onCheckoutProgress: (update) => Ref.update(seen, (all) => [...all, update]),
            },
          },
        );
        // Claimed only once git has registered the directory.
        assert.deepEqual(yield* Ref.get(claimed), { path: worktreePath, existed: true });

        // Git separates live progress updates with `\r`, so the driver must
        // surface every intermediate percentage, not just the final line.
        const updates = yield* Ref.get(seen);
        assert.isAbove(updates.length, 1);
        assert.equal(updates.at(-1)?.percent, 100);
        assert.equal(updates.at(-1)?.total, 201);
        const completed = updates.map((update) => update.completed);
        assert.deepEqual(
          completed,
          completed.toSorted((a, b) => a - b),
        );
      }),
    );

    it.effect("creates and removes a worktree and its new local branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.deleteLocalBranch({
          cwd,
          refName: "feature/worktree",
          force: true,
        });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
        assert.notInclude(yield* driver.listLocalBranchNames(cwd), "feature/worktree");
      }),
    );

    it.effect("allows worktree removal to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const removalStarted = yield* Deferred.make<void>();
        const delayedRemovalSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args[0] === "worktree" &&
              command.args[1] === "remove"
            ) {
              yield* Deferred.succeed(removalStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedRemovalSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "slow-removal");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/slow-removal",
        });

        const removal = yield* driver
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(removalStarted);
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(removal);

        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("removes the same worktree path twice without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "shared");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/shared",
        });

        // Two threads can record the same worktree path; the second delete
        // must be a no-op instead of exit 128.
        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.removeWorktree({ cwd, path: worktreePath });
      }),
    );

    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        // Delete the directory behind git's back so the registration goes stale.
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("ensureRemote reuses a partial clone remote and avoids its name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* git(cwd, [
          "remote",
          "add",
          "origin",
          "https://github.com/anton-abyzov/specwithcode.git",
        ]);
        yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
        yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
        assert.include(yield* git(cwd, ["remote", "-v"]), "(fetch) [blob:none]");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const reused = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "git@github.com:anton-abyzov/specwithcode.git",
        });
        assert.equal(reused, "origin");
        const added = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "https://github.com/another-owner/specwithcode.git",
        });
        assert.equal(added, "origin-1");
      }),
    );

    it.effect("explains a real fetch failure for a missing local remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const missingRemote = `${cwd}/private-missing-remote`;
        yield* git(cwd, ["remote", "add", "origin", missingRemote]);
        const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
        assert.include(error.detail, "could not access the remote repository");
        assert.equal(error.exitCode, 128);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, missingRemote);
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, [
          "remote",
          "add",
          "origin",
          "https://github.com/anton-abyzov/specwithcode.git",
        ]);

        const reusedForSsh = yield* driver.ensureRemote({
          cwd,
          preferredName: "anton-abyzov",
          url: "git@github.com:anton-abyzov/specwithcode.git",
        });
        assert.equal(reusedForSsh, "origin");

        const reusedForSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "anton-abyzov",
          url: "ssh://git@github.com/anton-abyzov/specwithcode",
        });
        assert.equal(reusedForSshScheme, "origin");

        const reusedForBareSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "anton-abyzov",
          url: "ssh://github.com/anton-abyzov/specwithcode",
        });
        assert.equal(reusedForBareSshScheme, "origin");

        const reusedForSshPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "anton-abyzov",
          url: "ssh://git@github.com:22/anton-abyzov/specwithcode",
        });
        assert.equal(reusedForSshPort, "origin");

        const reusedForSshWithPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "anton-abyzov",
          url: "ssh://git@github.com:22/anton-abyzov/specwithcode.git",
        });
        assert.equal(reusedForSshWithPort, "origin");

        const addedForFork = yield* driver.ensureRemote({
          cwd,
          preferredName: "octocat",
          url: "git@github.com:octocat/studio.git",
        });
        assert.equal(addedForFork, "octocat");
        assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
      }),
    );
  });

  describe("commit context", () => {
    it.effect("prepares selected files without staging and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");

        const commit = yield* driver.commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } });
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        const context = yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.include(context?.stagedSummary ?? "", "selected[1].txt");
        assert.notInclude(context?.stagedSummary ?? "", "selected1.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
        yield* driver.commit(cwd, "Add literal path", "", {
          stage: { filePaths: ["selected[1].txt"] },
        });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
          "selected[1].txt",
        );

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );

    it.effect.each([false, true])(
      "preserves partial staging and split-index files (split: %s)",
      (split) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          if (split) yield* git(cwd, ["config", "core.splitIndex", "true"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\n");
          yield* git(cwd, ["add", "README.md"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\nunstaged\n");
          yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
          yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
          yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
          const before = NodeFS.readFileSync(`${cwd}/.git/index`);
          const shared = NodeFS.readdirSync(`${cwd}/.git`).filter((name) =>
            name.startsWith("sharedindex."),
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;
          for (const paths of [undefined, ["README.md"]]) {
            const context = yield* driver.prepareCommitContext(cwd, paths);
            assert.include(context?.stagedPatch ?? "", "unstaged");
            assert.notInclude(context?.stagedSummary ?? "", "ignored.txt");
            assert.deepEqual(NodeFS.readFileSync(`${cwd}/.git/index`), before);
            assert.deepEqual(
              NodeFS.readdirSync(`${cwd}/.git`).filter((name) => name.startsWith("sharedindex.")),
              shared,
            );
          }
        }),
    );

    it.effect("prepares an unborn repository without creating a real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.txt", "initial\n");
        for (const paths of [undefined, ["initial.txt"]]) {
          const context = yield* driver.prepareCommitContext(cwd, paths);
          assert.include(context?.stagedSummary ?? "", "initial.txt");
          assert.isFalse(NodeFS.existsSync(`${cwd}/.git/index`));
        }
        yield* driver.commit(cwd, "Initial", "", { stage: { filePaths: ["initial.txt"] } });
        assert.equal(yield* git(cwd, ["show", "HEAD:initial.txt"]), "initial");
      }),
    );

    it.effect("preserves merge metadata while preparing selected and all files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["merge", "--no-commit", "--no-ff", "feature"]);
        yield* writeTextFile(cwd, "README.md", "# test\nmerge edit\n");
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`));
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const paths of [undefined, ["README.md"]]) {
          yield* driver.prepareCommitContext(cwd, paths);
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`)),
            before,
          );
        }
      }),
    );
  });

  describe("remote operations", () => {
    it.effect.each(["offline", "auth", "timeout"] as const)(
      "does not retry a scoped fetch after %s",
      (failure) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const started = yield* Deferred.make<void>();
          const attempts: Array<ReadonlyArray<string>> = [];
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command))
                return yield* Effect.die("unexpected command");
              if (command.args[0] !== "fetch") return yield* delegate.spawn(command);
              attempts.push(command.args);
              yield* Deferred.succeed(started, undefined);
              return ChildProcessSpawner.makeHandle({
                ...makeNonRepositoryHandle(),
                exitCode:
                  failure === "timeout"
                    ? Effect.never
                    : Effect.succeed(ChildProcessSpawner.ExitCode(128)),
                stderr: Stream.encodeText(
                  Stream.make(
                    failure === "auth"
                      ? "fatal: Authentication failed"
                      : "fatal: Could not resolve host",
                  ),
                ),
              });
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const fetching = yield* driver
            .fetchRemote({ cwd, remoteName: "origin", refName: "main" })
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          if (failure === "timeout") {
            yield* TestClock.adjust("31 seconds");
            yield* TestClock.adjust("31 seconds");
          }
          const result = yield* Fiber.join(fetching);
          assert.isTrue(Result.isFailure(result));
          assert.equal(attempts.length, 1);
          if (Result.isFailure(result)) {
            assert.equal(
              result.failure.detail,
              failure === "timeout"
                ? "Git command timed out."
                : failure === "offline"
                  ? "Git could not reach the remote. Check the server's network connection and remote host, then retry."
                  : "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.",
            );
          }
        }),
    );

    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        yield* git(peer, ["push", "origin", "HEAD:refs/heads/unrelated"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({
          cwd,
          remoteName: "origin",
          refName: `origin/${initialBranch}`,
        });
        assert.isFalse(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );

        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: initialBranch,
          }),
          true,
        );
        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: "local-only",
          }),
          false,
        );

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "studio/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.studio/fetched-origin.gh-merge-base"),
          initialBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.studio/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);

        yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "local-only" });
        assert.isTrue(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect("allows pushes to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const delayedPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedPushSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* driver
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 seconds");
        const pushed = yield* Fiber.join(pushing);

        assert.deepInclude(pushed, {
          status: "pushed",
          setUpstream: true,
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "origin/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(yield* git(remote, ["log", "-1", "--pretty=%s", "feature/x"]), "Add feature");
        assert.equal(yield* git(remote, ["rev-parse", "dev"]), devSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        // `checkout --track my-org/upstream/effect-atom` cannot name the local
        // branch `effect-atom`, so git keeps `upstream/effect-atom`. Its
        // upstream is still its published head.
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
