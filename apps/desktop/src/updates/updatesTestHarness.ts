import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@specweave-studio/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

/** Shared DesktopUpdates test harness: a fully stubbed updater layer whose
    electron-updater events are driven by hand via `emit`. Used by
    DesktopUpdates.test.ts and DesktopRemoteUpdates.test.ts. */

export const flushCallbacks = Effect.yieldNow;

export interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly beforeSetUpdateChannel?: Effect.Effect<void>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterDownloadUpdateError>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  /** quitAndInstall returns without starting a quit (the M4 no-quit of October 22, 2026). */
  readonly quitAndInstallDoesNothing?: boolean;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** False for an unpackaged (dev) build. */
  readonly isPackaged?: boolean;
  /** Contents of the resources/package-type marker a Linux package ships. */
  readonly packageType?: string | undefined;
  /**
   * Models electron-updater's MacUpdater: Squirrel.Mac stages a download only
   * when it finishes with install-on-quit set, and quitAndInstall on an
   * unstaged bundle with that flag set only waits, so nothing quits. As in
   * ElectronUpdater, the install is ready only once Squirrel staged the
   * version of the latest update-downloaded, not an older one.
   */
  readonly squirrel?: boolean;
  /** How long Squirrel.Mac unpacks after electron-updater hands it the download. */
  readonly squirrelUnpack?: Duration.Duration;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let quitAndInstallCount = 0;
  let downloadCount = 0;
  // The latest update-downloaded version, and the one Squirrel staged.
  let downloadedVersion: string | null = null;
  let stagedVersion: string | null = null;
  const squirrelStaged = () => downloadedVersion !== null && stagedVersion === downloadedVersion;
  let quitCount = 0;
  // Every value the updater was given for install-on-quit, in order.
  const installOnQuitValues: boolean[] = [];
  const disableDifferentialValues: boolean[] = [];
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];
  const notices: Array<{ notice: DesktopUpdates.DesktopUpdateNotice; click: () => void }> = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  // A quitAndInstall that really quits starts the app's quit, which the
  // lifecycle records as shutdownBegun; the test process itself never exits.
  const layerUpdater = Layer.effect(
    ElectronUpdater.ElectronUpdater,
    Effect.gen(function* () {
      const desktopState = yield* DesktopState.DesktopState;
      return {
        setFeedURL: (options) =>
          Effect.sync(() => {
            feedUrls.push(options);
          }),
        setAutoDownload: () => Effect.void,
        setAutoInstallOnAppQuit: (value) =>
          Effect.sync(() => {
            installOnQuitValues.push(value);
          }),
        setChannel: () => Effect.void,
        setAllowPrerelease: () => Effect.void,
        allowDowngrade: Effect.sync(() => allowDowngrade),
        setAllowDowngrade: (value) =>
          Effect.sync(() => {
            allowDowngrade = value;
          }),
        setFullChangelog: (value) =>
          Effect.sync(() => {
            fullChangelog = value;
          }),
        setDisableDifferentialDownload: (value) =>
          Effect.sync(() => {
            disableDifferentialValues.push(value);
          }).pipe(Effect.andThen(options.setDisableDifferentialDownload ?? Effect.void)),
        checkForUpdates: Effect.sync(() => {
          checkCount += 1;
        }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
        downloadUpdate: Effect.sync(() => {
          downloadCount += 1;
        }).pipe(
          Effect.andThen(options.downloadUpdate ?? Effect.void),
          Effect.tap(() => {
            if (installOnQuitValues.at(-1) !== true) return Effect.void;
            const stage = Effect.sync(() => {
              stagedVersion = downloadedVersion;
            });
            return options.squirrelUnpack === undefined
              ? stage
              : Effect.sleep(options.squirrelUnpack).pipe(Effect.andThen(stage), Effect.forkDetach);
          }),
        ),
        installReady: Effect.sync(() => !options.squirrel || squirrelStaged()),
        quitAndInstall: () =>
          Effect.suspend(() => {
            quitAndInstallCount += 1;
            installSteps.push("quitAndInstall");
            const quitsBefore = quitCount;
            if (options.quitAndInstallDoesNothing) {
              // Squirrel.Mac reports a staged bundle that is gone: nothing quits.
            } else if (!options.squirrel || squirrelStaged()) quitCount += 1;
            else if (installOnQuitValues.at(-1) !== true) {
              // MacUpdater starts the native fetch itself, which stages and quits.
              stagedVersion = downloadedVersion;
              quitCount += 1;
            }
            // A real quit starts at once; the lifecycle records it.
            const quitStart =
              quitCount > quitsBefore ? Ref.set(desktopState.shutdownBegun, true) : Effect.void;
            return (options.quitAndInstall ?? Effect.void).pipe(Effect.andThen(quitStart));
          }),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
            }),
            () =>
              Effect.sync(() => {
                removeListener(
                  eventName,
                  listener as unknown as (...args: readonly unknown[]) => void,
                );
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronUpdater.ElectronUpdater["Service"];
    }),
  );

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    registerSecondary: () => Effect.void,
    appWindows: Effect.succeed([]),
    appWindowForWebContents: () => Effect.succeedNone,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () => options.stopBackend ?? Effect.void,
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const layerBackend = DesktopBackendPool.layerTest([stubBackendInstance]);

  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/studio-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: options.isPackaged ?? true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          STUDIO_HOME: `/tmp/studio-desktop-updates-test-${process.pid}`,
          STUDIO_DESKTOP_MOCK_UPDATES: "true",
          STUDIO_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const setUpdateChannelError = options.setUpdateChannelError;
  const layerSettings =
    setUpdateChannelError || options.beforeSetUpdateChannel
      ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.sync(() => testSettings),
          load: Effect.sync(() => testSettings),
          setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
          setProjectWindowBounds: () => Effect.die("unexpected project window bounds update"),
          setServerExposureMode: () => Effect.die("unexpected server exposure update"),
          setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
          setUpdatePreferences: (patch) =>
            Effect.sync(() => {
              const next = DesktopAppSettings.setUpdatePreferences(testSettings, patch);
              const changed = next !== testSettings;
              testSettings = next;
              return { settings: testSettings, changed };
            }),
          setUpdateChannel: (channel) =>
            setUpdateChannelError
              ? Effect.fail(setUpdateChannelError)
              : (options.beforeSetUpdateChannel ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const changed = testSettings.updateChannel !== channel;
                      testSettings = {
                        ...testSettings,
                        updateChannel: channel,
                        updateChannelConfiguredByUser: true,
                      };
                      return { settings: testSettings, changed };
                    }),
                  ),
                ),
          setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
          setWslDistro: () => Effect.die("unexpected WSL distro change"),
          setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  // Tracks the restart markers installs leave, so installs stay free of real
  // disk I/O that would outrun the tests' settle loops.
  const updateRestartMarkers = new Set<string>();
  // Other files the updater keeps (the shown-notices list) or reads
  // (app-update.yml, electron-updater's cache), by path.
  const files = new Map<string, string>();
  // The environment joins with the host separator, so Windows asks for backslashed
  // paths; the fake keys every file by its forward-slash path.
  const key = (path: string) => path.replaceAll("\\", "/");
  const layerFileSystem = FileSystem.layerNoop({
    readFileString: (path) =>
      key(path) === "/missing/resources/package-type" && options.packageType !== undefined
        ? Effect.succeed(options.packageType)
        : files.has(key(path))
          ? Effect.succeed(files.get(key(path)) ?? "")
          : Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "readFileString",
                _tag: "NotFound",
                pathOrDescriptor: path,
              }),
            ),
    exists: (path) => Effect.sync(() => files.has(key(path))),
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.sync(() => {
        if (path.endsWith("update-notices.json")) files.set(key(path), data);
        else updateRestartMarkers.add(path);
      }),
    remove: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.delete(path);
        for (const file of files.keys()) {
          if (file === key(path) || file.startsWith(`${key(path)}/`)) files.delete(file);
        }
      }),
  });

  // System notifications are recorded instead of shown.
  const layerNotifier = Layer.succeed(DesktopUpdates.DesktopUpdateNotifier, (notice, click) => {
    notices.push({ notice, click });
  });

  const layer = DesktopUpdates.layer.pipe(
    Layer.provide(layerFileSystem),
    Layer.provide(layerNotifier),
    Layer.provideMerge(layerUpdater),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        STUDIO_HOME: `/tmp/studio-desktop-updates-test-${process.pid}`,
        STUDIO_DESKTOP_MOCK_UPDATES: "true",
        STUDIO_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    quitAndInstalls: () => quitAndInstallCount,
    /** quitAndInstall calls that really quit the app. */
    quits: () => quitCount,
    installSteps,
    updateRestartMarkers,
    files,
    /** The home folder the updater's environment resolves paths against. */
    homeDirectory: `/tmp/studio-desktop-updates-home-${process.pid}`,
    downloadCount: () => downloadCount,
    installOnQuit: (): boolean | undefined => installOnQuitValues.at(-1),
    disableDifferentialDownload: (): boolean | undefined => disableDifferentialValues.at(-1),
    feedUrls: (): ElectronUpdater.ElectronUpdaterFeedUrl[] => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    notices,
    emit: (eventName: string, payload?: unknown) => {
      if (eventName === "update-downloaded") {
        const version = (payload as { version?: unknown } | undefined)?.version;
        downloadedVersion = typeof version === "string" ? version : null;
      }
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}
