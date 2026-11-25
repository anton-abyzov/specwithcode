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

const recordingSpawner = (cwds: Array<string | undefined>, seen?: (cwd: string) => void) =>
  ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
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

describe("Pi status probe folder", () => {
  it.effect(
    "starts Pi in a fresh private empty folder under the status cache, not the server's folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-probe-cache-" });
        const cwds: Array<string | undefined> = [];
        const observed: Array<{ entries: number; mode: number }> = [];
        const spawner = recordingSpawner(cwds, (cwd) => {
          // Inspect the folder while the probe runs in it.
          observed.push({
            entries: NodeFs.readdirSync(cwd).length,
            mode: NodeFs.lstatSync(cwd).mode & 0o777,
          });
        });
        yield* checkPiProviderStatusInProbeFolder(piSettings, {}, cacheDir).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.isAbove(cwds.length, 0);
        const folders = [...new Set(cwds)];
        assert.equal(folders.length, 1);
        assert.equal(path.dirname(folders[0]!), cacheDir);
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
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-probe-cache-" });
      const elsewhere = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pi-probe-elsewhere-",
      });
      yield* fileSystem.symlink(elsewhere, path.join(cacheDir, "pi-status-probe"));
      const cwds: Array<string | undefined> = [];
      yield* checkPiProviderStatusInProbeFolder(piSettings, {}, cacheDir).pipe(
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
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-probe-cache-" });
      // A file where the cache folder should be: no folder can be made inside it.
      const cacheDir = path.join(parent, "not-a-folder");
      yield* fileSystem.writeFileString(cacheDir, "");
      const cwds: Array<string | undefined> = [];
      const snapshot = yield* checkPiProviderStatusInProbeFolder(piSettings, {}, cacheDir).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(cwds)),
      );
      assert.deepEqual(cwds, []);
      assert.equal(snapshot.status, "error");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
