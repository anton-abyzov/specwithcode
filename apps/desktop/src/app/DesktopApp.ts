import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { formatStorageFreeSpace } from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as Crypto from "effect/Crypto";
import * as Electron from "electron";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import { registerHandoffSleepNotice } from "./DesktopHandoffSleep.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalService from "../backend/DesktopLocalService.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopRemoteUpdates from "../updates/DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as MacBundleName from "../updates/macBundleName.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 8319;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {
    startPort: Schema.Int,
    maxPort: Schema.Int,
    hosts: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export class DesktopLocalServiceUnresponsiveError extends Schema.TaggedError<DesktopLocalServiceUnresponsiveError>()(
  "DesktopLocalServiceUnresponsiveError",
  {
    pid: Schema.Int,
    origin: Schema.String,
    stateDir: Schema.String,
    /** The home disk, set only when it is nearly full. */
    lowDisk: Schema.optional(Schema.Struct({ freeBytes: Schema.Int, onMac: Schema.Boolean })),
  },
) {
  override get message(): string {
    const unresponsive = `Another SpecWithCode process (pid ${this.pid}) owns ${this.stateDir} but does not answer at ${this.origin}.`;
    if (this.lowDisk !== undefined) {
      const machine = this.lowDisk.onMac ? "This Mac" : "This computer";
      return `${machine} is almost out of disk space (${formatStorageFreeSpace(this.lowDisk.freeBytes)} free), which is the likely reason SpecWithCode does not respond. ${unresponsive} Free some space, then open the app again. Starting a second server on the same data could damage it.`;
    }
    return `${unresponsive} Wait for it to finish starting or stop it, then open the app again. Starting a second server on the same data could damage it.`;
  }
}

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedError<DesktopDevelopmentBackendPortRequiredError>()(
  "DesktopDevelopmentBackendPortRequiredError",
  {},
) {
  override get message(): string {
    return "STUDIO_PORT is required in desktop development.";
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
) {
  if (Option.isSome(configuredPort)) {
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  const net = yield* NetService.NetService;
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    let availableOnEveryHost = true;

    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        availableOnEveryHost = false;
        break;
      }
    }

    if (availableOnEveryHost) {
      return {
        port,
        selectedByScan: true,
      } as const;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: MAX_TCP_PORT,
    hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
  });
});

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      "SpecWithCode failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

export const stopAllPoolInstances = Effect.fn("desktop.app.stopAllPoolInstances")(
  function* (): Effect.fn.Return<void, never, DesktopBackendPool.DesktopBackendPool> {
    // Stop every backend in the pool with a timeout to guarantee the quit
    // path makes progress even if a backend hangs during teardown.
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    yield* Effect.forEach(
      instances,
      (instance) => instance.stop({ timeout: Duration.seconds(5) }),
      { concurrency: "unbounded" },
    );
  },
);

const bootstrap = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const appActivation = yield* DesktopAppActivation.DesktopAppActivation;
  yield* logBootstrapInfo("bootstrap start");

  const settings = yield* desktopSettings.get;
  // The renderer is served from the bundled client (or Vite in development)
  // rather than through the local backend, so the window can open without one.
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(environment.isDevelopment
      ? { targetOrigin: Option.getOrThrow(environment.devServerUrl) }
      : { assetDirectory: environment.clientAssetsDir }),
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");
  // Before any window: the preload merges these items before the app reads storage.
  yield* (yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage).load(
    yield* (yield* DesktopAppIdentity.DesktopAppIdentity).resolveUserDataPath,
  );

  yield* snapShot.initialize;

  if (!settings.localEnvironmentEnabled) {
    yield* logBootstrapInfo("bootstrap skipping local environment (disabled in settings)");
    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.createMainIfBackendReady;
    }
    return;
  }

  // One writer per Studio home: when the installed service (or any live
  // server) already owns this store, use it as the local environment instead
  // of starting a second backend on the same database.
  if (!environment.isDevelopment) {
    const localService = yield* DesktopLocalService.DesktopLocalService;
    // Waiting for a service update can take minutes: show that, not nothing.
    const discovery = yield* localService.discover({
      onInstallWait: desktopWindow.showServiceUpdateSplash,
    });
    if (discovery._tag === "unresponsive") {
      return yield* new DesktopLocalServiceUnresponsiveError({
        pid: discovery.runtime.pid,
        origin: discovery.runtime.origin,
        stateDir: discovery.stateDir,
        ...(discovery.lowDiskFreeBytes === undefined
          ? {}
          : {
              lowDisk: {
                freeBytes: discovery.lowDiskFreeBytes,
                onMac: environment.platform === "darwin",
              },
            }),
      });
    }
    if (discovery._tag === "running") {
      yield* localService.attach(discovery.service);
      yield* (yield* DesktopServerExposure.DesktopServerExposure).attachLocalService({
        port: discovery.service.runtime.port,
      });
      yield* logBootstrapInfo("bootstrap attached to the running Studio server", {
        pid: discovery.service.runtime.pid,
        origin: discovery.service.httpBaseUrl.href,
        baseDir: discovery.service.baseDir,
        serviceManaged: discovery.service.runtime.serviceManaged,
        installedService: discovery.service.installedService === true,
        serverVersion: discovery.service.descriptor.serverVersion,
      });
      if (!(yield* Ref.get(state.quitting))) {
        yield* desktopWindow.handleBackendReady(discovery.service.httpBaseUrl);
        yield* appActivation.start.pipe(
          Effect.catch((error) =>
            logStartupError("desktop app control socket unavailable", { error }),
          ),
        );
      }
      return;
    }
  }

  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const primaryBackend = yield* pool.primary;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (
    settings.serverExposureMode === "network-accessible" &&
    serverExposureState.mode === "local-only"
  ) {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  if (!(yield* Ref.get(state.quitting))) {
    // The main window waits for the primary backend. In wsl-only mode that is
    // the WSL backend, which can be slow to cold-boot — show a "Connecting to
    // WSL" splash immediately so the app feels responsive instead of presenting
    // no window until WSL is ready. (Dual mode opens fast off the Windows
    // primary, so no splash there.)
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
    // This backend quits with the app, so an app restart may stop its work first.
    yield* (yield* DesktopLocalService.DesktopLocalService).markSpawned;
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    yield* appActivation.start.pipe(
      Effect.tap(() => logBootstrapInfo("desktop app control socket ready")),
      Effect.catch((error) => logStartupError("desktop app control socket unavailable", { error })),
    );
    // Bring up the WSL backend if the user previously enabled it. The
    // primary is already starting; reconcile fires off the WSL register
    // in parallel rather than blocking primary readiness on a possibly
    // slow first wsl.exe spawn.
    yield* Effect.forkScoped(wslBackend.reconcile);
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const linuxUrlHandler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
  const clerk = yield* DesktopClerk.DesktopClerk;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  yield* shellEnvironment.installIntoProcess;
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess()
      : preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null && !hasCommandLinePasswordStore) {
    if (
      linuxElectronOptions.passwordStore !== null ||
      preReadyElectronOptions.linux?.passwordStore !== null
    ) {
      yield* electronApp.removeCommandLineSwitch("password-store");
    }
    if (linuxElectronOptions.passwordStore !== null) {
      yield* electronApp.appendCommandLineSwitch(
        "password-store",
        linuxElectronOptions.passwordStore,
      );
    }
  }
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
  yield* desktopSettings.load;

  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }

  yield* appIdentity.configureBeforeReady;
  yield* lifecycle.register;
  yield* clerk.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  // An install updated from a release with an earlier bundle name (such as
  // "SpecWeave Studio (Alpha).app") renames itself before anything starts:
  // a script moves the bundle once this process has exited and reopens it.
  const bundleRename = yield* Effect.sync(() =>
    MacBundleName.startBundleRenameIfNeeded({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      execPath: process.execPath,
      appVersion: environment.appVersion,
      pid: process.pid,
      workDir: userDataPath,
      env: process.env,
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      logStartupError("app bundle rename unavailable", { cause: Cause.pretty(cause) }).pipe(
        Effect.as<MacBundleName.BundleRenamePlan>({ kind: "skip", reason: "error" }),
      ),
    ),
  );
  if (bundleRename.kind === "rename") {
    yield* logStartupInfo("renaming app bundle", {
      from: bundleRename.current,
      to: bundleRename.target,
    });
    yield* electronApp.exit(0);
    return yield* Effect.never;
  }
  // After a manual install both apps can sit side by side; the older copy goes to the Trash.
  yield* Effect.forkScoped(
    Effect.promise(() =>
      MacBundleName.trashLegacySiblings({
        platform: environment.platform,
        isPackaged: environment.isPackaged,
        execPath: process.execPath,
        trashItem: (path) => Electron.shell.trashItem(path),
      }),
    ).pipe(
      Effect.flatMap((removed) =>
        removed.length > 0
          ? logStartupInfo("moved earlier app copies to the Trash", { removed })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        logStartupError("could not remove an earlier app copy", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  if (environment.platform === "linux") {
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    yield* logStartupInfo("safe storage ready", {
      backend: Option.getOrElse(selectedBackend, () => "unknown"),
    });
  }
  yield* appIdentity.configure;
  yield* applicationMenu.configure;
  yield* updates.configure;
  // A Mac that slept through the hourly poll checks again on wake, unlock or
  // when a Studio window comes forward, so a downloaded update is usually
  // waiting behind "Restart to update" by the time someone sits down.
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const updateContext = yield* Effect.context<never>();
  const checkIfStale = (reason: string) => () => {
    void Effect.runPromiseWith(updateContext)(updates.checkIfStale(reason));
  };
  yield* powerMonitor.onSimpleEvent("resume", checkIfStale("resume"));
  yield* powerMonitor.onSimpleEvent("unlock-screen", checkIfStale("unlock"));
  // Handoff mode: the main window asks the local server to move running threads
  // to the chosen machine before this Mac sleeps (no reveal; it may be hidden).
  const handoffWindow = yield* DesktopWindow.DesktopWindow;
  yield* registerHandoffSleepNotice(powerMonitor, (action) =>
    handoffWindow.dispatchMenuAction(action, { reveal: false, target: "main" }),
  );
  yield* electronApp.on("browser-window-focus", checkIfStale("focus"));
  yield* DesktopRemoteUpdates.listen;
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;

    yield* Effect.addFinalizer(() =>
      // Stop every backend in the pool, not just the primary. The
      // electronApp.quit() path can race ahead of the layer-scope
      // cascade, so leaving the WSL instance for its parent scope
      // finalizer means it gets hard-killed by the OS instead of
      // receiving SIGTERM + grace.
      stopAllPoolInstances().pipe(
        Effect.ensuring(rendererHistory.shutdown),
        Effect.ensuring(shutdown.markComplete),
      ),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
