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
import { HttpClient } from "effect/http";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NetService from "@specweave-studio/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { awaitGateOpen, makeGatedHold } from "../serviceUpdate/UpdateInstallGate.testkit.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

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
