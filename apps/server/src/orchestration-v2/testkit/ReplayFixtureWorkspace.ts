import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class ReplayFixtureGitCommandError extends Schema.TaggedError<ReplayFixtureGitCommandError>()(
  "ReplayFixtureGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ReplayFixtureGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new ReplayFixtureGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
    }
  });
}

/** Workspace-relative path to file contents, committed with the initial README. */
export type ReplayWorkspaceFiles = Readonly<Record<string, string>>;

const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
  files: ReplayWorkspaceFiles = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({
    prefix: `studio-orchestrator-v2-${fixtureName}-`,
  });
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.name", "SpecWithCode Test"]);
  yield* runGit(cwd, ["config", "user.email", "studio-test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
  yield* runGit(cwd, ["add", "README.md", ...Object.keys(files)]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

// Windows refuses to remove a folder while a child still runs in it (a
// just-interrupted Git child, or a provider process whose release finishes
// after the scenario), so removal retries briefly there. The retry waits on
// wall time: under it.effect's TestClock the spacing would never elapse.
const wallClock = Clock.Clock.defaultValue();
const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(cwd, { recursive: true, force: true })
    .pipe(
      Effect.retry({ times: 20, schedule: Schedule.spaced("100 millis") }),
      Effect.provideService(Clock.Clock, wallClock),
    );
});

export const checkpointWorkspace = (fixtureName: string, files?: ReplayWorkspaceFiles) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName, files), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

/**
 * A workspace that is not a Git repository, so runs in it skip checkpoint
 * capture. Checkpoints in one workspace run one at a time, about a dozen Git
 * commands each, so a scenario with many concurrent runs that does not assert
 * on checkpoints uses this to keep that queue off its timing.
 */
export const uncheckpointedWorkspace = (fixtureName: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ prefix: `studio-orchestrator-v2-${fixtureName}-` });
    }),
    (cwd) => removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(
  fixtureName: string,
  files?: ReplayWorkspaceFiles,
): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName, files).pipe(Effect.provide(NodeServices.layer)),
  );
}
