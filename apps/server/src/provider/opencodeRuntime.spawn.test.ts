import { it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  CommandResolutionCache,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@specweave-studio/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

// Windows executable discovery and file reads are injected. The real npm
// parser, spawn resolver and runtime execute without launching a provider.
const fixture = vi.hoisted(() => ({
  shim: "C:\\Users\\Test User\\npm\\opencode.CMD",
  executable: "C:\\Users\\Test User\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
  contents: "",
  targetExists: true,
}));

vi.mock("../../../../packages/shared/src/windowsNpmShim.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../packages/shared/src/windowsNpmShim.ts")>();
  return {
    ...actual,
    npmShimExecutable: (shimPath: string) =>
      actual.npmShimExecutable(
        shimPath,
        (path) => (path === fixture.shim ? fixture.contents : undefined),
        (path) => fixture.targetExists && path === fixture.executable,
      ),
  };
});

beforeEach(() => {
  fixture.contents = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
    "",
  ].join("\r\n");
  fixture.targetExists = true;
});

function makeRuntime(server = false) {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const killed: Array<string | undefined> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("Expected a single OpenCode child process");
    }
    spawned.push(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(12345),
        exitCode: server ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(server),
        kill: (options) =>
          Effect.sync(() => {
            killed.push(options?.killSignal);
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(
          Stream.make(
            server ? "opencode server listening on http://127.0.0.1:4096\n" : "1.14.19\n",
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return {
    spawned,
    killed,
    layer: OpenCodeRuntime.layer.pipe(
      Layer.provide([
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        OpenCodeServerLedger.layerTest,
      ]),
    ),
  };
}

const windowsResolution = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessEnvironment, { PATH: "C:\\Users\\Test User\\npm" }),
    Effect.provideService(SpawnExecutableResolution, () => fixture.shim),
    Effect.provideService(CommandResolutionCache, new Map()),
  );

describe("OpenCode Windows process ownership", () => {
  effectIt.live("runs the npm native executable directly with unmodified command arguments", () => {
    const runtime = makeRuntime();
    const args = ["models", "provider with spaces & punctuation"];
    return Effect.gen(function* () {
      const service = yield* OpenCodeRuntime.OpenCodeRuntime;
      const result = yield* service.runOpenCodeCommand({ binaryPath: "opencode", args });
      expect(result).toEqual({ stdout: "1.14.19\n", stderr: "", code: 0 });
      expect(runtime.spawned).toHaveLength(1);
      expect(runtime.spawned[0]).toMatchObject({
        command: fixture.executable,
        args,
        options: { shell: false, detached: false },
      });
      expect(runtime.killed).toEqual(["SIGKILL"]);
    }).pipe(Effect.provide(runtime.layer), windowsResolution);
  });

  effectIt.live("starts and stops the native server child in its caller's scope", () => {
    const runtime = makeRuntime(true);
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* OpenCodeRuntime.OpenCodeRuntime;
        const server = yield* service.startOpenCodeServerProcess({
          binaryPath: "opencode",
          directory: "C:\\work",
          port: 4096,
          verify: () => Effect.succeed("1.14.19"),
        });
        expect(server.url).toBe("http://127.0.0.1:4096");
        expect(runtime.spawned[0]).toMatchObject({
          command: fixture.executable,
          args: ["serve", "--hostname=127.0.0.1", "--port=4096"],
          options: { shell: false, detached: false },
        });
        expect(runtime.killed).toEqual([]);
      }).pipe(Effect.scoped);
      expect(runtime.killed).toEqual(["SIGTERM", "SIGKILL"]);
    }).pipe(Effect.provide(runtime.layer), windowsResolution);
  });

  for (const condition of ["custom shim", "missing target"] as const) {
    effectIt.live(`preserves the command shim for a ${condition}`, () => {
      if (condition === "custom shim") {
        fixture.contents = fixture.contents.replace("SETLOCAL", "SETLOCAL\r\nSET CUSTOM=1");
      } else {
        fixture.targetExists = false;
      }
      const runtime = makeRuntime();
      return Effect.gen(function* () {
        const service = yield* OpenCodeRuntime.OpenCodeRuntime;
        yield* service.runOpenCodeCommand({ binaryPath: "opencode", args: ["--version"] });
        expect(runtime.spawned[0]?.command).toContain("opencode.CMD");
        expect(runtime.spawned[0]?.options.shell).toBe(true);
      }).pipe(Effect.provide(runtime.layer), windowsResolution);
    });
  }

  effectIt.live("keeps the shared resolver opt-in", () =>
    Effect.gen(function* () {
      expect((yield* resolveSpawnCommand("opencode", ["serve"])).shell).toBe(true);
      expect(yield* resolveSpawnCommand("opencode", ["serve"], { bypassNpmShim: true })).toEqual({
        command: fixture.executable,
        args: ["serve"],
        shell: false,
      });
    }).pipe(windowsResolution),
  );

  for (const platform of ["darwin", "linux"] as const) {
    effectIt.live(`preserves command resolution on ${platform}`, () =>
      Effect.gen(function* () {
        expect(yield* resolveSpawnCommand("opencode", ["serve"], { bypassNpmShim: true })).toEqual({
          command: "opencode",
          args: ["serve"],
          shell: false,
        });
      }).pipe(Effect.provideService(HostProcessPlatform, platform)),
    );
  }
});
