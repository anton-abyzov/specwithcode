// @effect-diagnostics nodeBuiltinImport:off - reads the probe folder synchronously while Pi runs in it.
import * as NodeFs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkPiProviderStatusInProbeFolder } from "./PiDriver.ts";

const encoder = new TextEncoder();

function processHandle(input: { readonly stdout?: string; readonly exitCode?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_002),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined ? Stream.empty : Stream.succeed(encoder.encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const recordingSpawner = (
  cwds: Array<string | undefined>,
  seen?: (cwd: string) => void,
  commands?: Array<string>,
) =>
  ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    if (ChildProcess.isStandardCommand(command)) commands?.push(command.command);
    if (ChildProcess.isStandardCommand(command) && !args.includes("--version")) {
      cwds.push(command.options.cwd);
      if (command.options.cwd !== undefined) seen?.(command.options.cwd);
    }
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: "pi 0.90.0\n" })
        : processHandle({ exitCode: 1 }),
    );
  });

const piSettings = { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] };

/**
 * A new folder no other user can write, nor any folder above it. The system
 * temporary folder is shared on Linux, so tests use the checkout's own cache.
 */
const privateFolder = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve("node_modules", ".cache", "studio-pi-probe-tests");
  yield* fileSystem.makeDirectory(root, { recursive: true });
  return yield* fileSystem.makeTempDirectoryScoped({ directory: root, prefix: "pi-probe-cache-" });
});

const probeFolders = (probeParent: string) => ({ probeParent, serverCwd: "/srv/studio" });

describe("Pi status probe folder", () => {
  it.effect(
    "starts Pi in a fresh private empty folder under the status cache, not the server's folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* privateFolder;
        const cwds: Array<string | undefined> = [];
        const observed: Array<{ entries: number; mode: number }> = [];
        const spawner = recordingSpawner(cwds, (cwd) => {
          // Inspect the folder while the probe runs in it.
          observed.push({
            entries: NodeFs.readdirSync(cwd).length,
            mode: NodeFs.lstatSync(cwd).mode & 0o777,
          });
        });
        yield* checkPiProviderStatusInProbeFolder(piSettings, {}, probeFolders(cacheDir)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.isAbove(cwds.length, 0);
        const folders = [...new Set(cwds)];
        assert.equal(folders.length, 1);
        // Under the cache folder's real path (a temp folder can sit behind a link).
        assert.equal(path.dirname(folders[0]!), yield* fileSystem.realPath(cacheDir));
        assert.isTrue(path.basename(folders[0]!).startsWith("pi-status-probe-"));
        assert.equal(observed[0]?.entries, 0);
        // Windows has no POSIX mode bits to check.
        if (process.platform !== "win32") assert.equal(observed[0]?.mode, 0o700);
        // The folder is removed once the check ends.
        assert.isFalse(yield* fileSystem.exists(folders[0]!));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never follows a planted symlink at the old fixed folder name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* privateFolder;
      const elsewhere = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pi-probe-elsewhere-",
      });
      yield* fileSystem.symlink(elsewhere, path.join(cacheDir, "pi-status-probe"));
      const cwds: Array<string | undefined> = [];
      yield* checkPiProviderStatusInProbeFolder(piSettings, {}, probeFolders(cacheDir)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(cwds)),
      );
      assert.isAbove(cwds.length, 0);
      for (const cwd of cwds) assert.notEqual(cwd, path.join(cacheDir, "pi-status-probe"));
      for (const cwd of cwds) assert.notEqual(cwd, elsewhere);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the check, and runs nothing, when no private folder can be made", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* privateFolder;
      // A file where the cache folder should be: no folder can be made inside it.
      const cacheDir = path.join(parent, "not-a-folder");
      yield* fileSystem.writeFileString(cacheDir, "");
      const cwds: Array<string | undefined> = [];
      const snapshot = yield* checkPiProviderStatusInProbeFolder(
        piSettings,
        {},
        probeFolders(cacheDir),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(cwds)),
      );
      assert.deepEqual(cwds, []);
      assert.equal(snapshot.status, "error");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.platform === "win32")(
    "fails the check, and runs nothing, when another user could write the cache folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* privateFolder;
        const cacheDir = path.join(parent, "shared");
        yield* fileSystem.makeDirectory(cacheDir);
        yield* fileSystem.chmod(cacheDir, 0o777);
        // A link that leads into the shared folder counts as the shared folder.
        const linked = path.join(parent, "linked");
        yield* fileSystem.symlink(cacheDir, linked);
        for (const candidate of [cacheDir, linked]) {
          const cwds: Array<string | undefined> = [];
          const snapshot = yield* checkPiProviderStatusInProbeFolder(
            piSettings,
            {},
            probeFolders(candidate),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(cwds)),
          );
          assert.deepEqual(cwds, []);
          assert.equal(snapshot.status, "error");
        }
        assert.deepEqual(yield* fileSystem.readDirectory(cacheDir), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.platform === "win32")(
    "fails the check, and runs nothing, under a shared sticky folder such as /tmp",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Pi reads context files from every folder above where it runs, and
        // anyone can write beside the probe folder in a sticky shared one.
        const shared = path.join(yield* privateFolder, "tmp");
        yield* fileSystem.makeDirectory(shared);
        yield* fileSystem.chmod(shared, 0o1777);
        const cwds: Array<string | undefined> = [];
        const snapshot = yield* checkPiProviderStatusInProbeFolder(
          piSettings,
          {},
          probeFolders(path.join(shared, "cache")),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(cwds)),
        );
        assert.deepEqual(cwds, []);
        assert.equal(snapshot.status, "error");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Windows may wrap the command in a shell, so the spawned name differs there.
  it.effect.skipIf(process.platform === "win32")(
    "runs a relative binary path from the server's folder, not the probe folder",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const commands: Array<string> = [];
        yield* checkPiProviderStatusInProbeFolder(
          { ...piSettings, binaryPath: "./bin/pi" },
          {},
          probeFolders(yield* privateFolder),
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            recordingSpawner([], undefined, commands),
          ),
        );
        assert.isAbove(commands.length, 0);
        for (const command of commands)
          assert.equal(command, path.resolve("/srv/studio", "bin/pi"));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
