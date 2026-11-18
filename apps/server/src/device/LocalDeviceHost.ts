import { pruneLocalDeviceTools } from "./deviceToolMaintenance.ts";
import { deviceToolInstallMessage } from "@specweave-studio/contracts";
/**
 * The device host that is this machine.
 *
 * Runs expo-device-hub as a supervised child on a loopback port and starts the
 * agent-device daemon in HTTP mode under a Studio-owned state directory. Both are
 * lazy: the device service requires explicit setup consent before it calls
 * ensureReady to install tools or start helper processes.
 *
 * The hub runs in its standalone mode (origin root). The Studio proxy strips its
 * own prefix, and the Device panel derives stream and socket URLs from the
 * prefix itself rather than from anything the hub prints.
 */
import {
  type DeviceHostSummary,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type DevicePlatformSetupCode,
  type AndroidSdkPart,
  LOCAL_DEVICE_HOST_ID,
} from "@specweave-studio/contracts";
import { waitForHttpReady } from "@specweave-studio/shared/httpReadiness";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
  HostProcessWorkingDirectory,
} from "@specweave-studio/shared/hostProcess";
import {
  resolveNodeExecutable,
  type NodeRuntimeUnavailableError,
} from "@specweave-studio/shared/nodeRuntime";
import * as NetService from "@specweave-studio/shared/Net";
import { isCommandAvailable } from "@specweave-studio/shared/shell";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import {
  type IosSetupStatus,
  type IosSimulatorSetup,
  IosSimulatorSetupSupport,
  iosSimulatorSetup,
  type KeptCheck,
} from "./iosSimulatorSupport.ts";
import {
  agentDeviceStateDir,
  type DeviceToolPaths,
  ensureAgentDevice,
  ensureDeviceHub,
  isAgentDeviceInstalled,
  isDeviceHubInstalled,
  deviceToolVersions,
  DEVICE_HUB_VERSION,
} from "./DeviceToolchain.ts";

const HUB_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;
const HUB_RESTART_STABLE_UPTIME_MS = 60_000;
const HUB_RESTART_MAX_DELAY_MS = 30_000;

/**
 * Written beside the agent-device state so a server that dies without running
 * its finalizers (SIGKILL, dev-runner restarts) does not leave a hub bound to
 * a loopback port forever. The next start reads it, kills only a process that
 * is still that hub, and replaces the file.
 */
const HubStateFile = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  entryPath: Schema.String,
});
const decodeHubStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(HubStateFile));
const encodeHubStateFile = Schema.encodeUnknownEffect(Schema.fromJsonString(HubStateFile));

const AgentDeviceDaemonFile = Schema.Struct({
  httpPort: Schema.Int,
  token: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.optional(Schema.String),
});
const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

const decodeAgentDeviceFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        details: Schema.Struct({
          reason: Schema.String,
          inspection: Schema.optional(Schema.Struct({ reason: Schema.String })),
        }),
      }),
    }),
  ),
);

interface HubProcess {
  readonly nodePath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly origin: string;
  readonly startedAtMillis: number;
}

interface RunningHost {
  readonly hub: HubProcess;
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
  readonly helpers: DeviceHost.DeviceHostReady["helpers"];
}

type Availability = Omit<DevicePlatformAvailability, "platform" | "code" | "missing"> & {
  readonly code?: DevicePlatformSetupCode;
  readonly missing?: ReadonlyArray<AndroidSdkPart>;
};

const IOS_REASONS: Partial<Record<IosSetupStatus, string>> = {
  xcode_missing: "Xcode was not found. Install Xcode from the App Store to run iOS Simulators.",
  xcode_not_selected:
    "Xcode was found, but the command line tools are selected instead. Run sudo xcode-select -s with the Xcode app's path.",
  xcode_setup_unfinished:
    "Xcode has not finished setting up. Open Xcode once to install its parts and accept its license.",
  unknown: "Xcode did not answer in time. Check again.",
};

/**
 * iOS on this machine's own host. The full check (Xcode.app, the selected
 * developer folder, `simctl` and its runtimes and devices) is kept between
 * reads; until its first answer the read falls back to the quick `xcrun` test
 * this host always used, without a code. A forced read waits for a fresh check.
 */
const iosAvailability = Effect.fn("LocalDeviceHost.iosAvailability")(function* (
  setupCheck: KeptCheck<IosSimulatorSetup>,
  force: boolean,
): Effect.fn.Return<Availability, never, FileSystem.FileSystem | Path.Path> {
  if ((yield* HostProcessPlatform) !== "darwin")
    return { available: false, reason: "iOS Simulators need macOS with Xcode.", code: "not_mac" };
  const setup = force
    ? yield* Effect.promise(() => setupCheck.read({ force: true }))
    : setupCheck.current();
  if (setup === undefined) {
    return (yield* isCommandAvailable("xcrun"))
      ? { available: true }
      : { available: false, reason: "Xcode command line tools were not found." };
  }
  const facts = {
    xcodeAppFound: setup.xcodeAppPath !== null,
    simctlAnswered: setup.simctlAnswered,
  };
  switch (setup.status) {
    case "ready":
      return { available: true, ...facts };
    // simctl answers, so the toolchain works; only a simulator is missing.
    case "ios_runtime_missing":
    case "ios_simulator_missing":
      return { available: true, code: setup.status, ...facts };
    case "unknown":
      return { available: false, reason: IOS_REASONS.unknown!, ...facts };
    default:
      return { available: false, reason: IOS_REASONS[setup.status]!, code: setup.status, ...facts };
  }
});

/**
 * Whether Android Studio is installed: the app bundle on macOS and the install
 * folder on Windows answer yes or no; on Linux it can live anywhere, so a miss
 * is unknown (undefined).
 */
const androidStudioFound = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Android Studio.app",
          "/Applications/Android Studio Preview.app",
          path.join(home, "Applications", "Android Studio.app"),
        ]
      : platform === "win32"
        ? [
            path.join(environment.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio"),
            path.join(
              environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
              "Programs",
              "Android Studio",
            ),
          ]
        : [
            "/opt/android-studio/bin/studio.sh",
            "/usr/local/android-studio/bin/studio.sh",
            "/snap/bin/android-studio",
            path.join(home, "android-studio", "bin", "studio.sh"),
            path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps", "android-studio"),
            ...(environment.PATH ?? "")
              .split(":")
              .filter(Boolean)
              .map((directory) => path.join(directory, "studio.sh")),
          ];
  for (const candidate of candidates) if (yield* exists(candidate)) return true;
  return platform === "darwin" || platform === "win32" ? false : undefined;
});

/**
 * Whether an Android virtual device exists, read from the AVD folder the
 * emulator uses (its `.ini` files), so no Java tool runs on every read.
 * Undefined when the folder exists but cannot be read.
 */
const androidAvdExists = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const folder = environment.ANDROID_AVD_HOME?.trim()
    ? environment.ANDROID_AVD_HOME.trim()
    : environment.ANDROID_USER_HOME?.trim()
      ? path.join(environment.ANDROID_USER_HOME.trim(), "avd")
      : environment.ANDROID_EMULATOR_HOME?.trim()
        ? path.join(environment.ANDROID_EMULATOR_HOME.trim(), "avd")
        : environment.ANDROID_SDK_HOME?.trim()
          ? path.join(environment.ANDROID_SDK_HOME.trim(), ".android", "avd")
          : path.join(home, ".android", "avd");
  if (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) return false;
  const names = yield* fs.readDirectory(folder).pipe(Effect.option);
  if (Option.isNone(names)) return undefined;
  return names.value.some((name) => name.endsWith(".ini"));
});

/** Android on this machine's own host; file checks only, so it is never kept. */
const androidAvailability = Effect.fn("LocalDeviceHost.androidAvailability")(
  function* (): Effect.fn.Return<Availability, never, FileSystem.FileSystem | Path.Path> {
    const sdk = yield* androidSdk;
    if (!sdk.root) {
      const studio = yield* androidStudioFound;
      return {
        available: false,
        reason:
          "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.",
        code: studio === false ? "android_studio_missing" : "android_sdk_missing",
        ...(studio === undefined ? {} : { androidStudioFound: studio }),
      };
    }
    const missing: AndroidSdkPart[] = [];
    if (!sdk.adb) missing.push("platform_tools");
    if (!sdk.emulator) missing.push("emulator");
    if (!sdk.avdmanager) missing.push("cmdline_tools");
    if (missing.length > 0) {
      // Today's text names the first missing part; `missing` names them all.
      const reason = !sdk.adb
        ? `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`
        : !sdk.emulator
          ? `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`
          : sdk.legacyAvdmanager
            ? `The Android SDK command-line tools in ${sdk.root} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.`
            : `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`;
      return { available: false, reason, code: "android_tools_missing", missing };
    }
    // Physical devices work over adb without a virtual device, so the platform stays available.
    return (yield* androidAvdExists) === false
      ? { available: true, code: "android_avd_missing" }
      : { available: true };
  },
);

const platformCheck = (
  platform: DevicePlatform,
  setupCheck: KeptCheck<IosSimulatorSetup>,
  force: boolean,
) => (platform === "ios" ? iosAvailability(setupCheck, force) : androidAvailability());

/** Today's text, or null when the platform is available. */
const platformReason = Effect.fn("LocalDeviceHost.platformReason")(function* (
  platform: DevicePlatform,
  setupCheck: KeptCheck<IosSimulatorSetup> = iosSimulatorSetup,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const availability = yield* platformCheck(platform, setupCheck, false);
  return availability.available ? null : (availability.reason ?? null);
});

/** Resolve the SDK once for both diagnostics and the environment passed to helpers. */
const androidSdk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const windows = platform === "win32";
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const explicit = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const adbBinary = windows ? "adb.exe" : "adb";
  const avdmanagerBinary = windows ? "avdmanager.bat" : "avdmanager";
  const inspect = Effect.fnUntraced(function* (root: string) {
    const adb = yield* exists(path.join(root, "platform-tools", adbBinary));
    const emulator = yield* exists(
      path.join(root, "emulator", windows ? "emulator.exe" : "emulator"),
    );
    if (!explicit && !adb && !emulator) return null;
    const avdmanager = yield* exists(
      path.join(root, "cmdline-tools", "latest", "bin", avdmanagerBinary),
    );
    const legacyAvdmanager =
      !avdmanager && (yield* exists(path.join(root, "tools", "bin", avdmanagerBinary)));
    return { root, adb, emulator, avdmanager, legacyAvdmanager };
  });
  const candidates = explicit
    ? [explicit]
    : [
        path.join(home, "Library", "Android", "sdk"),
        path.join(home, "Android", "Sdk"),
        path.join(
          environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
          "Android",
          "Sdk",
        ),
      ];
  for (const root of candidates) {
    const sdk = yield* inspect(root);
    if (sdk) return sdk;
  }
  // PATH entries can be slow to stat (network shares), so only consult them after the standard locations miss.
  if (!explicit) {
    const searchPath = environment.PATH ?? environment.Path ?? "";
    for (const directory of searchPath.split(windows ? ";" : ":")) {
      if (!directory) continue;
      const adb = path.join(directory, adbBinary);
      if (!(yield* exists(adb))) continue;
      const resolved = yield* fs.realPath(adb).pipe(Effect.orElseSucceed(() => adb));
      const sdk = yield* inspect(path.dirname(path.dirname(resolved)));
      if (sdk) return sdk;
    }
  }
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false };
});

const deviceHostEnvironment = (
  environment: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  hostPlatform: NodeJS.Platform,
  path: Path.Path,
): NodeJS.ProcessEnv => {
  return sdkRoot
    ? {
        ...environment,
        ANDROID_HOME: sdkRoot,
        PATH: [
          path.join(sdkRoot, "platform-tools"),
          path.join(sdkRoot, "emulator"),
          environment.PATH ?? environment.Path ?? "",
        ].join(hostPlatform === "win32" ? ";" : ":"),
      }
    : environment;
};

const hubEnvironment = Effect.fn("LocalDeviceHost.hubEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const env: NodeJS.ProcessEnv = { ...environment, FORCE_COLOR: "0", NO_COLOR: "1" };
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  if (env.ANDROID_HOME) {
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const emulator = path.join(
      env.ANDROID_HOME,
      "emulator",
      platform === "win32" ? "emulator.exe" : "emulator",
    );
    const cameraArgs = yield* Effect.forEach(["front", "back"], (facing) =>
      runner
        .run({
          command: emulator,
          args: [`-help-camera-${facing}`],
          env,
          timeout: Duration.seconds(5),
        })
        .pipe(
          Effect.map((result) => {
            const help = `${result.stdout}\n${result.stderr}`;
            // The hub wires imagefile cameras unconditionally; older SDK emulators reject that mode.
            return result.code === 0 && /\bemulated\b/.test(help) && !/\bimagefile\b/.test(help)
              ? `-camera-${facing} emulated`
              : "";
          }),
          Effect.orElseSucceed(() => ""),
        ),
    );
    const overrides = cameraArgs.filter(Boolean).join(" ");
    if (overrides) {
      env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS = [overrides, env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS]
        .filter(Boolean)
        .join(" ");
    }
  }
  if (platform === "linux" && env.XDG_RUNTIME_DIR === undefined && uid !== undefined) {
    // SSH sessions may omit the directory where the emulator publishes its gRPC token.
    const runtimeDir = `/run/user/${uid}`;
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(runtimeDir).pipe(Effect.option);
    if (
      stat._tag === "Some" &&
      stat.value.type === "Directory" &&
      Option.contains(stat.value.uid, uid)
    ) {
      env.XDG_RUNTIME_DIR = runtimeDir;
    }
  }
  return env;
});

/** Only a Mac can list Apple simulators; elsewhere the hub's attempt surfaces as an error. */
const hubPlatformArguments = (hostPlatform: NodeJS.Platform) =>
  hostPlatform === "darwin" ? [] : ["--platform", "android"];

export const make = Effect.fn("LocalDeviceHost.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const net = yield* NetService.NetService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;
  const hostPlatform = yield* HostProcessPlatform;
  const updateHold = yield* ServiceUpdateHold.optional;
  const hostScope = yield* Effect.scope;
  const sdk = yield* androidSdk;
  const hostEnvironment = deviceHostEnvironment(environment, sdk.root, hostPlatform, path);
  const startLock = yield* Semaphore.make(1);
  const runningRef = yield* Ref.make<RunningHost | null>(null);
  const restartDelayRef = yield* Ref.make(0);
  const hostId = LOCAL_DEVICE_HOST_ID;
  const iosSetup = yield* IosSimulatorSetupSupport;

  // Refuse foreground starts promptly: waiting while holding the device
  // lifecycle lock would prevent settings changes and shutdown from stopping it.
  const refuseStart = updateHold.refuse("device.start");
  const startRunner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      refuseStart.pipe(
        Effect.mapError(
          (cause) =>
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause,
            }),
        ),
        Effect.andThen(runner.run(input)),
      ),
  };

  const checkPlatform = Effect.fn("LocalDeviceHost.checkPlatform")(function* (
    platform: DevicePlatform,
    force: boolean,
  ): Effect.fn.Return<DevicePlatformAvailability> {
    const availability = yield* platformCheck(platform, iosSetup, force).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { platform, ...availability };
  });
  const platformAvailability = (platform: DevicePlatform) => checkPlatform(platform, false);

  /** Forced, it runs the setup checks again whatever answer is kept ("Check again"). */
  const summaryWith = (force: boolean): Effect.Effect<DeviceHostSummary> =>
    Effect.gen(function* () {
      const [platforms, hubInstalled, agentDeviceInstalled] = yield* Effect.all([
        Effect.all([checkPlatform("ios", force), checkPlatform("android", force)]),
        isDeviceHubInstalled(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
        isAgentDeviceInstalled(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ]);
      const running = yield* Ref.get(runningRef);
      const daemon = running?.agentDevice
        ? yield* readDaemonFile().pipe(Effect.option)
        : Option.none();
      const hubAlive = running
        ? yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false))
        : false;
      const agentAlive =
        Option.isSome(daemon) && daemon.value.pid ? yield* isProcessAlive(daemon.value.pid) : false;
      const tools = yield* deviceToolVersions(config.baseDir, {
        ...(hubAlive ? { hub: DEVICE_HUB_VERSION } : {}),
        ...(agentAlive && Option.isSome(daemon) && daemon.value.version
          ? { agent: daemon.value.version }
          : {}),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return {
        tools,
        id: hostId,
        kind: "local",
        label: "This machine",
        platforms,
        hubInstalled,
        agentDeviceInstalled,
      };
    });
  const summary = summaryWith(false);

  const stopHub = (hub: HubProcess | undefined) =>
    hub ? Scope.close(hub.scope, Exit.void).pipe(Effect.ignore) : Effect.void;

  const hubStatePath = () => path.join(agentDeviceStateDir(path, config.stateDir), "hub.json");

  const isProcessAlive = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  /**
   * A hub left behind by a previous server is identified by pid plus the
   * command line's entry path, so a recycled pid belonging to something else
   * is never touched.
   */
  const reapStaleHub = Effect.gen(function* () {
    const previous = yield* fs
      .readFileString(hubStatePath())
      .pipe(Effect.flatMap(decodeHubStateFile), Effect.option);
    if (previous._tag === "None") return;
    const alive = yield* isProcessAlive(previous.value.pid);
    if (alive) {
      const commandLine = yield* startRunner
        .run({
          command: "ps",
          args: ["-o", "command=", "-p", String(previous.value.pid)],
          timeout: Duration.seconds(5),
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.orElseSucceed(() => ""),
        );
      if (commandLine.includes(previous.value.entryPath)) {
        yield* Effect.logWarning("Stopping a device hub left behind by a previous server", {
          pid: previous.value.pid,
          port: previous.value.port,
        });
        yield* Effect.sync(() => {
          try {
            process.kill(previous.value.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        });
      }
    }
    yield* fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore);
  }).pipe(Effect.ignoreCause);

  const recordHub = (hub: HubProcess, hubTool: DeviceToolPaths) =>
    encodeHubStateFile({
      pid: Number(hub.child.pid),
      port: Number(new URL(hub.origin).port),
      entryPath: hubTool.entryPath,
    }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: hubStatePath(), contents }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    );

  const spawnHub = Effect.fn("LocalDeviceHost.spawnHub")(function* (
    hubTool: DeviceToolPaths,
    nodePath: string,
  ): Effect.fn.Return<
    HubProcess,
    DeviceHost.DeviceHostError | ServiceUpdateHold.ServiceUpdateInProgressError
  > {
    yield* refuseStart;
    yield* reapStaleHub;
    yield* fs
      .makeDirectory(agentDeviceStateDir(path, config.stateDir), { recursive: true })
      .pipe(Effect.ignore);
    const port = yield* net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "reserving a port for the device hub",
            cause,
          }),
      ),
    );
    const origin = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make("sequential");
    // On failure or interrupt, from the spawn on: the hub is not recorded yet,
    // so nothing else stops it.
    return yield* Effect.gen(function* () {
      const env = yield* hubEnvironment(hostEnvironment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcessPlatform, hostPlatform),
      );
      // Port reservation and environment discovery can yield to a newly acquired hold.
      yield* refuseStart;
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            nodePath,
            [
              hubTool.entryPath,
              "--port",
              String(port),
              "--host",
              "127.0.0.1",
              "--hide-sidebar",
              "--hide-boot-device",
              ...hubPlatformArguments(hostPlatform),
            ],
            {
              cwd: workingDirectory,
              detached: false,
              shell: false,
              stdout: "pipe",
              stderr: "pipe",
              env,
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new DeviceHost.DeviceHostError({
                hostId,
                step: "starting the device hub",
                cause,
              }),
          ),
        );
      const startedAtMillis = yield* Clock.currentTimeMillis;
      const hub: HubProcess = { child, scope, origin, startedAtMillis, nodePath };
      yield* Effect.forkIn(observeHubOutput(hub), scope);
      yield* waitForHttpReady({
        baseUrl: origin,
        path: "/readyz",
        timeoutMs: HUB_READY_TIMEOUT_MS,
        makeError: (info) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "waiting for the device hub to answer",
            cause: info.cause,
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      yield* recordHub(hub, hubTool);
      yield* Effect.logInfo("Device hub started", { pid: Number(child.pid), port });
      return hub;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const observeHubOutput = (hub: HubProcess) =>
    hub.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) =>
        Effect.logDebug("Device hub output", { pid: Number(hub.child.pid), output: line }),
      ),
      Effect.ignoreCause,
    );

  /**
   * Restart the hub when it dies under us, with the same doubling backoff the
   * relay connector uses so a hub that crashes on boot cannot spin.
   */
  const superviseHub = (hub: HubProcess, hubTool: DeviceToolPaths): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.result(hub.child.exitCode);
      const running = yield* Ref.get(runningRef);
      if (running?.hub !== hub) return;
      const uptime = (yield* Clock.currentTimeMillis) - hub.startedAtMillis;
      const delay = yield* Ref.modify(restartDelayRef, (current) => {
        if (uptime >= HUB_RESTART_STABLE_UPTIME_MS) return [0, 0];
        const next = current === 0 ? 1_000 : Math.min(current * 2, HUB_RESTART_MAX_DELAY_MS);
        return [current, next];
      });
      yield* Effect.logWarning("Device hub exited; restarting", {
        pid: Number(hub.child.pid),
        delayMs: delay,
      });
      yield* Effect.sleep(Duration.millis(delay));
      while (true) {
        // The updater may have reaped this hub. Keep its replacement out of the
        // quiescence window, without holding the lock needed by stop/finalization.
        yield* updateHold.awaitReleased;
        const finished = yield* startLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(runningRef);
            if (current?.hub !== hub) return true;
            // Once spawning succeeds, shutdown must see the replacement in
            // runningRef before it can interrupt this supervisor.
            yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const replacement = yield* restore(spawnHub(hubTool, hub.nodePath));
                yield* Ref.set(runningRef, { ...current, hub: replacement });
                yield* Effect.forkIn(superviseHub(replacement, hubTool), hostScope);
              }),
            );
            return true;
          }).pipe(
            // The hold can close again while waiting for the lock or preparing
            // the spawn. Retry only after releasing the lock.
            Effect.catchTags({ ServiceUpdateInProgressError: () => Effect.succeed(false) }),
          ),
        );
        if (finished) return;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Device hub supervisor failed", { cause })),
    );

  const daemonFilePath = () => path.join(agentDeviceStateDir(path, config.stateDir), "daemon.json");

  const readDaemonFile = Effect.fn("LocalDeviceHost.readDaemonFile")(function* () {
    const raw = yield* fs.readFileString(daemonFilePath());
    return yield* decodeDaemonFile(raw);
  });

  /**
   * agent-device auto-starts its daemon on any command. A trivial `devices`
   * call in HTTP mode is the documented way to bring it up; its output is the
   * daemon.json this reads back.
   */
  const startAgentDeviceDaemon = Effect.fn("LocalDeviceHost.startAgentDeviceDaemon")(function* (
    agentTool: DeviceToolPaths,
    nodePath: string,
  ): Effect.fn.Return<
    DeviceHost.AgentDeviceEndpoint,
    | DeviceHost.DeviceHostError
    | DeviceHost.DeviceHostTimeoutError
    | DeviceHost.AgentDeviceStartError
    | ServiceUpdateHold.ServiceUpdateInProgressError
  > {
    yield* refuseStart;
    const stateDir = agentDeviceStateDir(path, config.stateDir);
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
    const existing = yield* readDaemonFile().pipe(Effect.option);
    const daemonEnvironment: NodeJS.ProcessEnv = {
      ...hostEnvironment,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      // The daemon idles out after five minutes by default; the server owns
      // its lifetime here and stops it explicitly.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const toEndpoint = (
      file: typeof AgentDeviceDaemonFile.Type,
    ): DeviceHost.AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath: agentTool.entryPath,
    });
    if (existing._tag === "Some") {
      const alive = yield* HttpClient.withScope(httpClient)
        .get(`http://127.0.0.1:${existing.value.httpPort}/health`)
        .pipe(
          Effect.timeout(Duration.seconds(2)),
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(Effect.as(response.status === 200)),
          ),
          Effect.scoped,
          Effect.orElseSucceed(() => false),
        );
      if (alive) return toEndpoint(existing.value);
      yield* fs.remove(daemonFilePath(), { force: true }).pipe(Effect.ignore);
    }
    // There is no `daemon start`; the first command in a state dir spawns the
    // daemon and blocks until it answers. `devices` is the cheapest one.
    yield* refuseStart;
    const runResult = yield* runner
      .run({
        command: nodePath,
        args: [agentTool.entryPath, "devices", "--json"],
        env: daemonEnvironment,
        timeout: Duration.millis(DAEMON_READY_TIMEOUT_MS),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    // Discovery can fail after the daemon starts. A published endpoint still
    // lets agents connect; absent one, preserve the CLI failure instead of polling.
    const started = yield* readDaemonFile().pipe(Effect.option);
    if (started._tag === "Some") return toEndpoint(started.value);
    if (runResult._tag === "Failure") {
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "starting agent tools",
        cause: runResult.failure,
      });
    }
    const result = runResult.success;
    if (result.timedOut) {
      return yield* new DeviceHost.DeviceHostTimeoutError({
        hostId,
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
      });
    }
    if (result.code !== 0) {
      const failure = decodeAgentDeviceFailure(result.stdout);
      const details = Option.isSome(failure) ? failure.value.error.details : undefined;
      const reason =
        details?.reason === "daemon_registration_unproven"
          ? details.inspection?.reason === "non-directory"
            ? "daemon_lock_not_directory"
            : "daemon_registration_unproven"
          : details?.reason === "daemon_retirement_unconfirmed"
            ? "daemon_retirement_unconfirmed"
            : "command_failed";
      return yield* new DeviceHost.AgentDeviceStartError({
        hostId,
        stateDir,
        exitCode: result.code === null ? null : Number(result.code),
        reason,
        cause: result,
      });
    }
    const deadline = (yield* Clock.currentTimeMillis) + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = yield* readDaemonFile().pipe(Effect.option);
      if (file._tag === "Some") return toEndpoint(file.value);
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new DeviceHost.DeviceHostTimeoutError({
          hostId,
          timeoutMs: DAEMON_READY_TIMEOUT_MS,
        });
      }
      yield* Effect.sleep(Duration.millis(DAEMON_POLL_MS));
    }
  });

  const stopAgentDeviceDaemon = (
    agentTool: { readonly entryPath: string; readonly nodePath: string } | null,
  ) =>
    agentTool
      ? runner
          .run({
            command: agentTool.nodePath,
            args: [
              agentTool.entryPath,
              "daemon",
              "stop",
              "--state-dir",
              agentDeviceStateDir(path, config.stateDir),
            ],
            env: { ...hostEnvironment, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
            timeout: Duration.seconds(10),
            timeoutBehavior: "timedOutResult",
          })
          .pipe(Effect.ignore)
      : Effect.void;

  let agentToolRef: { readonly entryPath: string; readonly nodePath: string } | null = null;

  const ensureHubReady = Effect.fn("LocalDeviceHost.ensureHubReady")(function* (
    onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
  ): Effect.fn.Return<
    RunningHost,
    | DeviceHost.DeviceHostError
    | NodeRuntimeUnavailableError
    | ServiceUpdateHold.ServiceUpdateInProgressError
  > {
    yield* refuseStart;
    const running = yield* Ref.get(runningRef);
    if (running) {
      const alive = yield* running.hub.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (alive) return running;
      yield* Ref.set(runningRef, null);
    }
    const nodePath = yield* resolveNodeExecutable("Local device support", hostEnvironment).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, hostPlatform),
    );
    const installed = yield* isDeviceHubInstalled(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (!installed) {
      const inventory = yield* summary;
      yield* onPhase("installing", deviceToolInstallMessage("device hub", inventory.tools?.hub));
    }
    const hubTool = yield* ensureDeviceHub(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, startRunner),
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId,
            step: "installing device support",
            cause,
          }),
      ),
    );
    yield* onPhase("starting");
    const hub = yield* spawnHub(hubTool, nodePath);
    // Until the hub is in runningRef, nothing else stops it, so publishing it
    // is part of the guarded step.
    const next = yield* Effect.gen(function* () {
      yield* pruneLocalDeviceTools(config.baseDir, nodePath, "hub").pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, startRunner),
        Effect.ignore,
      );
      const candidate = helperPaths(hubTool);
      const [axExists, cliExists] = yield* Effect.all([
        fs.exists(candidate.serveSimAxSettings).pipe(Effect.orElseSucceed(() => false)),
        fs.exists(candidate.serveSimCli).pipe(Effect.orElseSucceed(() => false)),
      ]);
      const next: RunningHost = {
        hub,
        agentDevice: null,
        helpers: {
          serveSimAxSettings: axExists ? candidate.serveSimAxSettings : null,
          serveSimCli: cliExists ? candidate.serveSimCli : null,
        },
      };
      yield* Ref.set(runningRef, next);
      return next;
    }).pipe(Effect.onError(() => stopHub(hub)));
    yield* Ref.set(restartDelayRef, 0);
    yield* Effect.forkIn(superviseHub(hub, hubTool), hostScope);
    return next;
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    startLock.withPermits(1)(
      ensureHubReady(onPhase).pipe(
        Effect.map(toReady),
        Effect.catchTags({
          ServiceUpdateInProgressError: (cause) =>
            Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId,
                step: "waiting for the service update",
                cause,
              }),
            ),
        }),
      ),
    );

  const ensureAgentReady: DeviceHost.DeviceHost["Service"]["ensureAgentReady"] = (onPhase) =>
    startLock.withPermits(1)(
      Effect.gen(function* (): Generator<
        Effect.Effect<
          unknown,
          | DeviceHost.DeviceHostError
          | DeviceHost.DeviceHostTimeoutError
          | DeviceHost.AgentDeviceStartError
          | NodeRuntimeUnavailableError
          | ServiceUpdateHold.ServiceUpdateInProgressError
        >,
        DeviceHost.DeviceHostAgentReady
      > {
        const running = yield* ensureHubReady(onPhase);
        if (running.agentDevice) return { ...toReady(running), agentDevice: running.agentDevice };
        const installed = yield* isAgentDeviceInstalled(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (!installed) {
          const inventory = yield* summary;
          yield* onPhase(
            "installing",
            deviceToolInstallMessage("agent tools", inventory.tools?.agent),
          );
        }
        const agentTool = yield* ensureAgentDevice(config.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, startRunner),
          Effect.mapError(
            (cause) =>
              new DeviceHost.DeviceHostError({
                hostId,
                step: "installing agent tools",
                cause,
              }),
          ),
        );
        agentToolRef = { entryPath: agentTool.entryPath, nodePath: running.hub.nodePath };
        yield* onPhase("starting");
        const agentDevice = yield* startAgentDeviceDaemon(agentTool, running.hub.nodePath);
        yield* pruneLocalDeviceTools(config.baseDir, running.hub.nodePath, "agent").pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, startRunner),
          Effect.ignore,
        );
        const next = { ...running, agentDevice };
        yield* Ref.set(runningRef, next);
        return { ...toReady(next), agentDevice };
      }).pipe(
        Effect.catchTags({
          ServiceUpdateInProgressError: (cause) =>
            Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId,
                step: "waiting for the service update",
                cause,
              }),
            ),
        }),
      ),
    );

  const helperPaths = (hubTool: DeviceToolPaths) => {
    const serveSimDist = path.join(
      hubTool.installDir,
      "node_modules",
      "expo-device-hub",
      "vendor",
      "serve-sim",
      "dist",
    );
    return {
      serveSimAxSettings: path.join(serveSimDist, "simax", "serve-sim-ax-settings"),
      serveSimCli: path.join(serveSimDist, "serve-sim.js"),
    };
  };

  const run: DeviceHost.DeviceHostReady["run"] = (command, args, options) =>
    startRunner
      .run({
        command:
          command === "emulator" && sdk.root
            ? path.join(
                sdk.root,
                "emulator",
                hostPlatform === "win32" ? "emulator.exe" : "emulator",
              )
            : command,
        args,
        cwd: workingDirectory,
        env: hostEnvironment,
        timeout: Duration.millis(options?.timeoutMs ?? 20_000),
        timeoutBehavior: "timedOutResult",
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
        Effect.map((result) => ({
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.timedOut ? 124 : Number(result.code ?? 127),
        })),
        Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: String(cause), code: 127 })),
      );

  const toReady = (running: RunningHost): DeviceHost.DeviceHostReady => ({
    hub: { origin: running.hub.origin } satisfies DeviceHost.DeviceHubEndpoint,
    devices: makeDeviceHubOperations({
      hostId,
      origin: running.hub.origin,
      http: httpClient,
      run,
      androidAvailable: platformAvailability("android").pipe(
        Effect.map((availability) => availability.available),
      ),
    }),
    nodePath: running.hub.nodePath,
    run,
    helpers: running.helpers,
  });

  const current: DeviceHost.DeviceHost["Service"]["current"] = Ref.get(runningRef).pipe(
    Effect.map((running) => (running ? toReady(running) : null)),
  );

  const stopAgent: DeviceHost.DeviceHost["Service"]["stopAgent"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      yield* stopAgentDeviceDaemon(agentToolRef);
      yield* Ref.update(runningRef, (running) =>
        running ? { ...running, agentDevice: null } : running,
      );
    }),
  );

  const stop: DeviceHost.DeviceHost["Service"]["stop"] = startLock.withPermits(1)(
    Effect.gen(function* () {
      const running = yield* Ref.getAndSet(runningRef, null);
      yield* stopHub(running?.hub);
      yield* fs.remove(hubStatePath(), { force: true }).pipe(Effect.ignore);
      yield* stopAgentDeviceDaemon(agentToolRef);
    }),
  );

  // Never leave the hub or daemon behind when the server's scope closes.
  yield* Effect.addFinalizer(() => stop);

  const host: DeviceHost.DeviceHost["Service"] = {
    id: hostId,
    summary,
    inspect: summaryWith(true),
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    current,
    stopAgent,
    stop,
  };
  return host;
});

export const layer = Layer.effect(DeviceHost.DeviceHost, make());

/** Exposed for tests. */
export const __testing = {
  AgentDeviceDaemonFile,
  androidSdk,
  androidStudioFound,
  androidAvdExists,
  platformCheck,
  platformReason,
  deviceHostEnvironment,
  hubEnvironment,
};
