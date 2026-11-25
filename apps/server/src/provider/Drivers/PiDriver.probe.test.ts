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

describe("Pi status probe folder", () => {
  it.effect(
    "starts Pi in a private empty folder under the status cache, not the server's folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-probe-cache-" });
        const cwds: Array<string | undefined> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          const args = ChildProcess.isStandardCommand(command) ? command.args : [];
          if (ChildProcess.isStandardCommand(command) && !args.includes("--version")) {
            cwds.push(command.options.cwd);
          }
          return Effect.succeed(
            args.includes("--version")
              ? processHandle({ stdout: "pi 0.90.0\n" })
              : processHandle({ exitCode: 1 }),
          );
        });
        yield* checkPiProviderStatusInProbeFolder(
          { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
          {},
          cacheDir,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const probeFolder = path.join(cacheDir, "pi-status-probe");
        assert.isAbove(cwds.length, 0);
        assert.deepEqual([...new Set(cwds)], [probeFolder]);
        assert.isTrue(yield* fileSystem.exists(probeFolder));
        assert.deepEqual(yield* fileSystem.readDirectory(probeFolder), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
