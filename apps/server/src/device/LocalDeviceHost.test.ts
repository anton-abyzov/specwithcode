import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
  HostProcessUserId,
} from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NetService from "@specweave-studio/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { awaitGateOpen, makeGatedHold } from "../serviceUpdate/UpdateInstallGate.testkit.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";

const processOutput = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const agentFixture = Effect.fn("agentFixture")(function* (
  startup: (
    stateDir: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  avdOutput: ProcessRunner.ProcessRunOutput = processOutput(0),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-device-agent-start-" });
  const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
  for (const [name, version, entry] of [
    ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
    ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
  ]) {
    const installDir = path.join(baseDir, "tools", name!, version!);
    const entryPath = path.join(installDir, "node_modules", name!, entry!);
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), version!);
  }
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
    Effect.provideService(HostProcessIsExecutable, false),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) =>
        input.args.includes("devices")
          ? startup(stateDir)
          : Effect.succeed(input.args.includes("-list-avds") ? avdOutput : processOutput(0)),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
      ),
    ),
  );
  yield* host.ensureReady(() => Effect.void);
  return { host, fs, stateDir };
});

describe("AgentDevice startup", () => {
  it.effect("reports an incompatible lock immediately and retains it for manual repair", () =>
    Effect.gen(function* () {
      const result = processOutput(
        1,
        JSON.stringify({
          success: false,
          error: {
            message: "private command output",
            details: {
              reason: "daemon_registration_unproven",
              inspection: { state: "unproven", reason: "non-directory" },
            },
          },
        }),
      );
      const { host, fs, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const lock = `${stateDir}/daemon.lock`;
      const legacyOwner = JSON.stringify({ pid: 85669, processStartTime: "old start time" });
      yield* fs.writeFileString(lock, legacyOwner);
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "daemon_lock_not_directory",
        exitCode: 1,
        cause: result,
      });
      expect(error.message).toContain("Daemon registration ownership could not be verified");
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).toContain(stateDir);
      expect(error.message).toContain("original CLI");
      expect(error.message).not.toContain("private command output");
      expect(yield* fs.readFileString(lock)).toBe(legacyOwner);
      expect(yield* host.current).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unknown nonzero exits without exposing arbitrary command output", () =>
    Effect.gen(function* () {
      const result = processOutput(2, "invalid JSON", "private credentials");
      const { host, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "command_failed",
        exitCode: 2,
        cause: result,
      });
      expect(error.message).toContain("exit code 2");
      expect(error.message).toContain(stateDir);
      expect(error.message).not.toContain("private credentials");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves process execution failures instead of waiting for a daemon file", () =>
    Effect.gen(function* () {
      const cause = new ProcessRunner.ProcessSpawnError({
        command: "/missing/node",
        argumentCount: 3,
        cause: new Error("missing executable"),
      });
      const { host } = yield* agentFixture(() => Effect.fail(cause));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostError",
        step: "starting agent tools",
        cause,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a command timeout without starting another readiness wait", () =>
    Effect.gen(function* () {
      const { host } = yield* agentFixture(() => Effect.succeed(processOutput(124, "", "", true)));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DeviceHostTimeoutError", timeoutMs: 30_000 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a registered daemon when reading startup command output fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cause = new ProcessRunner.ProcessReadError({
        command: process.execPath,
        argumentCount: 3,
        stream: "stdout",
        cause: new Error("output read failed after registration"),
      });
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          yield* fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345, token: "test-token" }),
            )
            .pipe(Effect.orDie);
          return yield* cause;
        }),
      );
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect(attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows retry and uses a registered daemon even when discovery exits nonzero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          if (attempts > 1) {
            yield* fs
              .writeFileString(
                `${stateDir}/daemon.json`,
                JSON.stringify({ httpPort: 12345, token: "test-token" }),
              )
              .pipe(Effect.orDie);
          }
          return processOutput(1);
        }),
      );
      yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("uses the standard Windows SDK without probing PATH", () =>
    Effect.gen(function* () {
      const root = "C:\\Users\\test\\AppData\\Local\\Android\\Sdk";
      const probes: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcessEnvironment, {
          USERPROFILE: "C:\\Users\\test",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PATH: "\\\\slow-share\\tools;C:\\other-tools",
        }),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.sync(() => {
                probes.push(file);
                return file === `${root}\\platform-tools\\adb.exe`;
              }),
            realPath: () => Effect.die("Standard SDK must not resolve PATH executables"),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(probes.filter((file) => !file.startsWith("C:\\Users\\test\\"))).toEqual([]);
    }),
  );

  it.effect("falls back to adb on the Windows Path without resolving missing entries", () =>
    Effect.gen(function* () {
      const root = "D:\\Android\\Sdk";
      const resolved: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcessEnvironment, {
          USERPROFILE: "C:\\Users\\test",
          Path: "C:\\missing;C:\\shims",
        }),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.succeed(
                file === "C:\\shims\\adb.exe" || file === `${root}\\platform-tools\\adb.exe`,
              ),
            realPath: (file) =>
              Effect.sync(() => {
                resolved.push(file);
                return `${root}\\platform-tools\\adb.exe`;
              }),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(resolved).toEqual(["C:\\shims\\adb.exe"]);
    }),
  );

  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect.each([
  { reason: "timeout", timedOut: true },
  { reason: "signal termination", timedOut: false },
])("reports AVD enumeration $reason as a failed command", ({ timedOut }) =>
  Effect.gen(function* () {
    const { host } = yield* agentFixture(() => Effect.succeed(processOutput(0)), {
      ...processOutput(0),
      code: null,
      timedOut,
    });
    const ready = yield* host.ensureReady(() => Effect.void);
    const result = yield* ready.run("emulator", ["-list-avds"]);
    expect(result.code).not.toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
    // The darwin host joins with POSIX paths whatever OS runs the test.
  }).pipe(Effect.provide(NodePath.layerPosix)),
);

it.effect(
  "recovers an owned Linux runtime directory without overriding explicit environments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const stat = yield* fs.stat(directory);
      for (const [platform, uid, runtimeDir, type, owner, expected] of [
        ["linux", 1000, undefined, "Directory", 1000, "/run/user/1000"],
        ["linux", 1000, "/custom/runtime", "Directory", 1000, "/custom/runtime"],
        ["linux", 1000, "", "Directory", 1000, ""],
        ["linux", 1000, undefined, "Directory", 1001, undefined],
        ["linux", 1000, undefined, "File", 1000, undefined],
        ["linux", undefined, undefined, "Directory", 1000, undefined],
        ["darwin", 1000, undefined, "Directory", 1000, undefined],
        ["win32", 1000, undefined, "Directory", 1000, undefined],
      ] as const) {
        const environment = { PATH: "/usr/bin", XDG_RUNTIME_DIR: runtimeDir };
        const result = yield* LocalDeviceHost.__testing.hubEnvironment(environment).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(HostProcessUserId, uid),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              stat: (path) => {
                expect(path).toBe("/run/user/1000");
                return Effect.succeed({ ...stat, type, uid: Option.some(owner) });
              },
            }),
          ),
        );
        expect(result.XDG_RUNTIME_DIR).toBe(expected);
        expect(result.PATH).toBe("/usr/bin");
        expect(result.FORCE_COLOR).toBe("0");
        expect(result.NO_COLOR).toBe("1");
        expect(environment.XDG_RUNTIME_DIR).toBe(runtimeDir);
      }
      const missing = yield* LocalDeviceHost.__testing
        .hubEnvironment({})
        .pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessUserId, 1000),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
      expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
    ),
);

it.effect.each([
  {
    name: "old SDK",
    front: "emulated webcam<N> none",
    back: "emulated virtualscene none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated -camera-back emulated",
  },
  {
    name: "imagefile-capable SDK",
    front: "emulated imagefile:<path> none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: undefined,
  },
  {
    name: "user overrides",
    front: "emulated none",
    back: "emulated none",
    code: 0,
    extra: "-memory 4096 -camera-front none",
    expected: "-camera-front emulated -camera-back emulated -memory 4096 -camera-front none",
  },
  {
    name: "different camera capabilities",
    front: "emulated none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated",
  },
  {
    name: "failed help probe",
    front: "emulated none",
    back: "emulated none",
    code: 1,
    extra: undefined,
    expected: undefined,
  },
])("configures supported emulator cameras for $name", ({ front, back, code, extra, expected }) =>
  Effect.gen(function* () {
    const result = yield* LocalDeviceHost.__testing
      .hubEnvironment({ ANDROID_HOME: "/sdk", EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: extra })
      .pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessUserId, 1000),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            expect(input.command).toBe("/sdk/emulator/emulator");
            expect(input.args[0]).toMatch(/^-help-camera-(front|back)$/);
            return Effect.succeed(
              processOutput(code, input.args[0] === "-help-camera-front" ? front : back),
            );
          },
        }),
        // The simulated host is a Mac, so SDK paths stay POSIX on every test runner.
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodePath.layerPosix)),
      );
    expect(result.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS).toBe(expected);
  }),
);

it.live("limits hub discovery to Android unless the host is a Mac", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcessEnvironment;
    const hubArguments = Effect.fn(function* (platform: NodeJS.Platform) {
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-device-hub-" });
      const installDir = path.join(baseDir, "tools/expo-device-hub", DEVICE_HUB_VERSION);
      const entryPath = path.join(installDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
      const argumentsPath = path.join(baseDir, "hub-args.json");
      yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fs.writeFileString(path.join(installDir, ".install-complete"), DEVICE_HUB_VERSION);
      yield* fs.writeFileString(
        entryPath,
        `import http from 'node:http'; import fs from 'node:fs';
const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(argumentsPath)},JSON.stringify(args));
http.createServer((req,res)=>res.end('ok')).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
      );
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(baseDir, baseDir),
            NetService.layer,
            ProcessRunner.layer,
            FetchHttpClient.layer,
          ),
        ),
        Effect.provideService(HostProcessEnvironment, { ...environment, HOME: baseDir }),
        Effect.provideService(HostProcessPlatform, platform),
      );
      yield* host.ensureReady(() => Effect.void).pipe(Effect.ensuring(host.stop));
      return (yield* fs
        .readFileString(argumentsPath)
        .pipe(Effect.map((contents) => JSON.parse(contents)))) as ReadonlyArray<string>;
    });
    expect((yield* hubArguments("linux")).slice(-2)).toEqual(["--platform", "android"]);
    expect(yield* hubArguments("darwin")).not.toContain("--platform");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps local Android and iOS available without ffmpeg", () =>
  Effect.gen(function* () {
    // The fake xcrun is a POSIX shell script, which a Windows runner cannot execute.
    if ((yield* HostProcessPlatform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-device-ffmpeg-" });
    yield* fs.makeDirectory(`${baseDir}/bin`);
    yield* fs.writeFileString(`${baseDir}/bin/xcrun`, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(`${baseDir}/bin/xcrun`, 0o755);
    for (const [directory, tool] of [
      ["platform-tools", "adb"],
      ["emulator", "emulator"],
      ["cmdline-tools/latest/bin", "avdmanager"],
    ]) {
      yield* fs.makeDirectory(`${baseDir}/sdk/${directory}`, { recursive: true });
      yield* fs.writeFileString(`${baseDir}/sdk/${directory}/${tool}`, "");
    }
    const onTestHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcessEnvironment, {
          HOME: baseDir,
          PATH: `${baseDir}/bin`,
          ANDROID_HOME: `${baseDir}/sdk`,
        }),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
      onTestHost,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error("Readiness must not make network requests"))),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Platform availability must not probe emulator video"),
      }),
    );
    expect((yield* onTestHost(host.summary)).platforms).toEqual([
      { platform: "ios", available: true },
      { platform: "android", available: true },
    ]);
    expect(yield* onTestHost(host.platformAvailability("android"))).toEqual({
      platform: "android",
      available: true,
    });
    expect(yield* onTestHost(host.platformAvailability("ios"))).toEqual({
      platform: "ios",
      available: true,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcessIsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const makeLifecycleFixture = (hold: ServiceUpdateHold.ServiceUpdateHoldShape) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "device-update-lifecycle-" });
    const hostScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(hostScope, Exit.void));
    const waits = yield* Queue.unbounded<void>();
    const resumed = yield* Queue.unbounded<void>();
    const spawns = yield* Queue.unbounded<void>();
    const hubs: Array<{ readonly exit: Effect.Effect<boolean>; closed: boolean }> = [];
    const commands: Array<ProcessRunner.ProcessRunInput> = [];
    const hooks = { beforeReserve: Effect.void };
    const entries = [
      ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
      ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
    ] as const;
    for (const [name, version, entry] of entries) {
      const directory = path.join(baseDir, "tools", name, version);
      const entryPath = path.join(directory, "node_modules", name, entry);
      yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fs.writeFileString(entryPath, "// fixture only; never executed\n");
      yield* fs.writeFileString(path.join(directory, ".install-complete"), version);
    }
    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) =>
        Effect.gen(function* () {
          commands.push(input);
          if (input.args.includes("devices")) {
            yield* fs
              .writeFileString(
                path.join(input.env!.AGENT_DEVICE_STATE_DIR!, "daemon.json"),
                JSON.stringify({ httpPort: 4999, token: "test-token" }),
              )
              .pipe(Effect.orDie);
          }
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    };
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
      Effect.provideService(Scope.Scope, hostScope),
      Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessIsExecutable, false),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, {
        ...hold,
        awaitReleased: Effect.gen(function* () {
          if (yield* hold.isHeld) yield* Queue.offer(waits, undefined);
          yield* hold.awaitReleased;
          yield* Queue.offer(resumed, undefined);
        }),
      }),
      Effect.provideService(NetService.NetService, {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        hasListenerOnHost: () => Effect.succeed(false),
        findAvailablePort: (port) => Effect.succeed(port),
        reserveLoopbackPort: () =>
          Effect.suspend(() => hooks.beforeReserve).pipe(Effect.as(4100 + hubs.length)),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
        ),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const child = {
              exit: Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)),
              closed: false,
            };
            hubs.push(child);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                child.closed = true;
              }).pipe(Effect.andThen(child.exit)),
            );
            yield* Queue.offer(spawns, undefined);
            return ChildProcessSpawner.makeHandle({
              // Deliberately outside the OS PID range: no fixture PID can name a live process.
              pid: ChildProcessSpawner.ProcessId(2_000_000_000 + hubs.length),
              exitCode: Deferred.await(exited),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              kill: () => child.exit.pipe(Effect.asVoid),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        ),
      ),
    );
    return { host, hostScope, baseDir, hubs, commands, hooks, waits, resumed, spawns };
  });

const makeHold = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "device-update-hold-" });
  return yield* ServiceUpdateHold.makeWithOptions({ agentStatePath: `${directory}/state.json` });
});

const noPhase = () => Effect.void;

it.layer(NodeServices.layer)("LocalDeviceHost during a service update", (it) => {
  for (const mode of ["hold", "install gate"] as const) {
    it.effect(`refuses initial hub and agent starts during an ${mode}`, () =>
      Effect.gen(function* () {
        const gated = mode === "install gate" ? yield* makeGatedHold() : null;
        const hold = gated?.hold ?? (yield* makeHold);
        if (!gated) yield* hold.acquire();
        const fixture = yield* makeLifecycleFixture(hold);
        for (const start of [fixture.host.ensureReady, fixture.host.ensureAgentReady]) {
          const error = yield* start(noPhase).pipe(Effect.flip);
          expect(error._tag).toBe("DeviceHostError");
          if (error._tag === "DeviceHostError") {
            expect(error.cause).toBeInstanceOf(ServiceUpdateHold.ServiceUpdateInProgressError);
          }
        }
        expect(fixture.hubs).toHaveLength(0);
        expect(fixture.commands).toHaveLength(0);
        if (gated) {
          yield* gated.clear;
          expect(yield* awaitGateOpen(hold)).toBe(true);
        } else {
          yield* hold.release("test-resume");
        }
        yield* fixture.host.ensureReady(noPhase);
        expect(fixture.hubs).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("pauses a reaped hub and resumes its normal restart after release", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      yield* fixture.host.ensureReady(noPhase);
      yield* Queue.take(fixture.spawns);
      yield* hold.acquire();
      yield* fixture.hubs[0]!.exit;
      yield* Queue.take(fixture.waits);
      expect(fixture.hubs).toHaveLength(1);
      yield* hold.release("test-resume");
      yield* Queue.take(fixture.spawns);
      // Readiness serializes behind the restart and proves the replacement was published.
      const ready = yield* fixture.host.ensureReady(noPhase);
      expect(ready.hub.origin).toBe("http://127.0.0.1:4101");
      expect(fixture.hubs).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("scope finalization stops a host while its supervisor waits for release", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      yield* fixture.host.ensureReady(noPhase);
      yield* hold.acquire();
      yield* fixture.hubs[0]!.exit;
      yield* Queue.take(fixture.waits);
      yield* Scope.close(fixture.hostScope, Exit.void);
      expect(yield* fixture.host.current).toBeNull();
      yield* hold.release("test-resume");
      expect(fixture.hubs).toHaveLength(1);
      expect(fixture.hubs[0]!.closed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("does not resurrect a stopped hub when the hold ends", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      yield* fixture.host.ensureReady(noPhase);
      yield* hold.acquire();
      yield* fixture.hubs[0]!.exit;
      yield* Queue.take(fixture.waits);
      yield* fixture.host.stop;
      yield* hold.release("test-resume");
      yield* Queue.take(fixture.resumed);
      // The test scheduler drains the resumed supervisor without wall-clock sleeps.
      yield* TestClock.adjust(0);
      expect(yield* fixture.host.current).toBeNull();
      expect(fixture.hubs).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rechecks a hold acquired while preparing the replacement spawn", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      yield* fixture.host.ensureReady(noPhase);
      yield* Queue.take(fixture.spawns);
      fixture.hooks.beforeReserve = Effect.gen(function* () {
        fixture.hooks.beforeReserve = Effect.void;
        yield* hold.acquire();
      });
      yield* fixture.hubs[0]!.exit;
      yield* Queue.take(fixture.waits);
      expect(fixture.hubs).toHaveLength(1);
      yield* hold.release("test-resume");
      yield* Queue.take(fixture.spawns);
      yield* fixture.host.ensureReady(noPhase);
      expect(fixture.hubs).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("rechecks initial hub and agent starts after phase callbacks yield", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      const acquireDuringStart = () => hold.acquire().pipe(Effect.asVoid);
      yield* fixture.host.ensureReady(acquireDuringStart).pipe(Effect.flip);
      expect(fixture.hubs).toHaveLength(0);
      yield* hold.release("test-resume");
      yield* fixture.host.ensureReady(noPhase);
      yield* fixture.host.ensureAgentReady(acquireDuringStart).pipe(Effect.flip);
      expect(fixture.commands.some((command) => command.args.includes("devices"))).toBe(false);
      yield* hold.release("test-resume");
      yield* fixture.host.ensureAgentReady(noPhase);
      expect(fixture.commands.filter((command) => command.args.includes("devices"))).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not install missing tools if an update starts after consent", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${fixture.baseDir}/tools`, { recursive: true });
      const error = yield* fixture.host
        .ensureReady((phase) => {
          expect(phase).toBe("installing");
          return hold.acquire().pipe(Effect.asVoid);
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("DeviceHostError");
      expect(fixture.hubs).toHaveLength(0);
      expect(fixture.commands).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks commands from old ready endpoints but still permits daemon teardown", () =>
    Effect.gen(function* () {
      const hold = yield* makeHold;
      const fixture = yield* makeLifecycleFixture(hold);
      const ready = yield* fixture.host.ensureAgentReady(noPhase);
      const beforeHold = fixture.commands.length;
      yield* hold.acquire();
      expect((yield* ready.run("node", ["old-helper.mjs"])).code).not.toBe(0);
      yield* fixture.host.ensureAgentReady(noPhase).pipe(Effect.flip);
      expect(fixture.commands).toHaveLength(beforeHold);
      yield* fixture.host.stopAgent;
      expect(fixture.commands.at(-1)?.args).toContain("stop");
      expect(fixture.commands).toHaveLength(beforeHold + 1);
      yield* hold.release("test-resume");
      expect((yield* ready.run("node", ["old-helper.mjs"])).code).toBe(0);
    }).pipe(Effect.scoped),
  );
});
