import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopLocalService from "../backend/DesktopLocalService.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("SpecWithCode"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

function layerAssets(icons: { readonly ico?: string; readonly png?: string } = {}) {
  return Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.fromUndefinedOr(icons.ico),
      icns: Option.none(),
      png: Option.fromUndefinedOr(icons.png),
    }),
    resolveResourcePath: () => Effect.succeedNone,
  });
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(
  destroyAll: Effect.Effect<void> = Effect.void,
  windows?: {
    readonly main: () => Option.Option<Electron.BrowserWindow>;
    readonly appWindows: () => readonly Electron.BrowserWindow[];
  },
) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: windows ? Effect.sync(windows.main) : Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    registerSecondary: () => Effect.void,
    appWindows: windows ? Effect.sync(windows.appWindows) : Effect.succeed([]),
    appWindowForWebContents: () => Effect.succeedNone,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    openProjectWindow: () => Effect.die("unexpected project window"),
    showConnectingSplash: Effect.void,
    showServiceUpdateSplash: Effect.void,
    showServiceStartSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(layerAssets()),
        Layer.provideMerge(DesktopLocalService.layerTest()),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect("orders a later quit once an install that did not quit is recovered", () => {
    const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
    const layer = DesktopLifecycle.layer.pipe(
      Layer.provideMerge(layerElectronApp(appListeners)),
      Layer.provideMerge(layerElectronTheme),
      Layer.provideMerge(layerElectronWindow(Effect.void)),
      Layer.provideMerge(layerDesktopWindow()),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
      Layer.provideMerge(layerAssets()),
      Layer.provideMerge(DesktopLocalService.layerTest()),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const state = yield* DesktopState.DesktopState;
        yield* lifecycle.register;
        appListeners.get("before-quit-for-update")?.();
        assert.isTrue(yield* Ref.get(state.updaterQuitAllowed));

        // DesktopUpdates' install recovery: Squirrel refused, the app stays.
        yield* Ref.set(state.updaterQuitAllowed, false);
        yield* Ref.set(state.shutdownBegun, false);
        let prevented = false;
        appListeners.get("before-quit")?.({
          preventDefault: () => {
            prevented = true;
          },
        } as Electron.Event);
        assert.isTrue(prevented, "the backends get the ordered shutdown");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners, quit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow(destroyAll)),
        Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(layerDesktopShutdown),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(layerAssets()),
        Layer.provideMerge(DesktopLocalService.layerTest()),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
          assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  const activationLayer = (
    appListeners: Map<string, (...args: readonly unknown[]) => void>,
    activate: Effect.Effect<void>,
  ) =>
    DesktopLifecycle.layer.pipe(
      Layer.provideMerge(layerElectronApp(appListeners)),
      Layer.provideMerge(layerElectronTheme),
      Layer.provideMerge(
        layerElectronWindow(Effect.void, { main: () => Option.none(), appWindows: () => [] }),
      ),
      Layer.provideMerge(layerDesktopWindow({ activate })),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
      Layer.provideMerge(layerAssets()),
      Layer.provideMerge(DesktopLocalService.layerTest()),
    );

  it.effect("ignores app activation once the updater's quit has begun", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);
          appListeners.get("before-quit-for-update")?.();
          assert.isTrue(yield* Ref.get(state.shutdownBegun));

          appListeners.get("activate")?.();
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow;

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(activationLayer(appListeners, activate)));
    }),
  );

  it.effect("opens a window on activation while an install that has not quit holds quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const activated = yield* Queue.unbounded<void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();
          yield* Queue.take(activated);
          assert.isFalse(yield* Ref.get(state.shutdownBegun));
        }),
      ).pipe(
        Effect.provide(
          activationLayer(appListeners, Queue.offer(activated, undefined).pipe(Effect.asVoid)),
        ),
      );
    }),
  );

  it.effect(
    "leaves the main window where it is when the Dock is clicked from a project window",
    () =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const activated = yield* Queue.unbounded<void>();
        const makeWindow = (state: { visible: boolean; minimized: boolean; destroyed: boolean }) =>
          ({
            isDestroyed: () => state.destroyed,
            isVisible: () => state.visible,
            isMinimized: () => state.minimized,
          }) as unknown as Electron.BrowserWindow;
        const mainWindow = makeWindow({ visible: true, minimized: false, destroyed: false });
        const projectState = { visible: true, minimized: false, destroyed: false };
        const projectWindow = makeWindow(projectState);
        let main = Option.some(mainWindow);
        let appWindows: readonly Electron.BrowserWindow[] = [mainWindow, projectWindow];
        const appWindowsRead = Promise.withResolvers<void>();
        const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]);
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(
            layerElectronWindow(Effect.void, {
              main: () => main,
              appWindows: () => {
                appWindowsRead.resolve();
                return appWindows;
              },
            }),
          ),
          Layer.provideMerge(
            layerDesktopWindow({ activate: Queue.offer(activated, undefined).pipe(Effect.asVoid) }),
          ),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
          Layer.provideMerge(layerAssets()),
          Layer.provideMerge(DesktopLocalService.layerTest()),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            yield* lifecycle.register;
            // A project window is in use: the Dock click must not pull main over it.
            appListeners.get("activate")?.();
            // The handler decides right after it lists the app windows.
            yield* Effect.promise(() => appWindowsRead.promise);
            yield* Effect.yieldNow;
            assert.equal(yield* Queue.size(activated), 0);

            // Minimized or hidden project windows do not count as in use.
            projectState.minimized = true;
            appListeners.get("activate")?.();
            yield* Queue.take(activated);
            projectState.minimized = false;
            projectState.visible = false;
            appListeners.get("activate")?.();
            yield* Queue.take(activated);
            projectState.visible = true;

            // With the main window closed the click brings it back.
            main = Option.none();
            appWindows = [projectWindow];
            appListeners.get("activate")?.();
            yield* Queue.take(activated);

            // The main window alone behaves as it always did.
            main = Option.some(mainWindow);
            appWindows = [mainWindow];
            appListeners.get("activate")?.();
            yield* Queue.take(activated);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );
  function layerBackgroundTest(input: {
    readonly platform: NodeJS.Platform;
    readonly appListeners: Map<string, (...args: readonly unknown[]) => void>;
    readonly quit: Effect.Effect<void>;
    readonly activate: Effect.Effect<void>;
    readonly localService: Layer.Layer<DesktopLocalService.DesktopLocalService>;
    readonly createTray: ElectronTray.ElectronTrayFactory;
  }) {
    return DesktopLifecycle.layer.pipe(
      Layer.provideMerge(layerElectronApp(input.appListeners, input.quit)),
      Layer.provideMerge(layerElectronTheme),
      Layer.provideMerge(layerElectronWindow()),
      Layer.provideMerge(layerDesktopWindow({ activate: input.activate })),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: input.platform,
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
      Layer.provideMerge(layerAssets({ ico: "C:/app/icon.ico", png: "/app/icon.png" })),
      Layer.provideMerge(input.localService),
      Layer.provideMerge(Layer.succeed(ElectronTray.ElectronTray, input.createTray)),
    );
  }

  it.effect.each(["win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "keeps an app-owned backend running in the tray when the last window closes on %s",
    (platform) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const quits = yield* Queue.unbounded<void>();
        const activations = yield* Queue.unbounded<void>();
        const trays: ElectronTray.ElectronTrayInput[] = [];
        const trayCreated = Promise.withResolvers<ElectronTray.ElectronTrayInput>();
        let destroyed = 0;
        const layer = layerBackgroundTest({
          platform,
          appListeners,
          quit: Queue.offer(quits, undefined).pipe(Effect.asVoid),
          activate: Queue.offer(activations, undefined).pipe(Effect.asVoid),
          localService: DesktopLocalService.layerTest({ spawned: true }),
          createTray: (input) => {
            trays.push(input);
            trayCreated.resolve(input);
            return {
              destroy: () => {
                destroyed += 1;
              },
            };
          },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            yield* lifecycle.register;

            appListeners.get("window-all-closed")?.();
            const tray = yield* Effect.promise(() => trayCreated.promise);
            assert.equal(tray.iconPath, platform === "win32" ? "C:/app/icon.ico" : "/app/icon.png");
            assert.equal(tray.quitLabel, "Quit SpecWithCode");
            assert.equal(yield* Queue.size(quits), 0, "the backend and its threads keep running");

            // Closing the reopened window again reuses the one tray icon.
            tray.onOpen();
            yield* Queue.take(activations);
            appListeners.get("window-all-closed")?.();
            yield* Effect.yieldNow;
            assert.equal(trays.length, 1);

            // Quit stays one click away.
            tray.onQuit();
            yield* Queue.take(quits);
          }),
        ).pipe(Effect.provide(layer));
        assert.equal(destroyed, 1);
      }),
  );

  it.effect.each(["win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "quits on %s when the window closes and an installed service keeps the threads",
    (platform) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const quits = yield* Queue.unbounded<void>();
        let traysCreated = 0;
        const layer = layerBackgroundTest({
          platform,
          appListeners,
          quit: Queue.offer(quits, undefined).pipe(Effect.asVoid),
          activate: Effect.void,
          // Attached to a running service: the app never owns the backend.
          localService: DesktopLocalService.layerTest({ spawned: false }),
          createTray: () => {
            traysCreated += 1;
            return { destroy: () => undefined };
          },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            yield* lifecycle.register;
            appListeners.get("window-all-closed")?.();
            yield* Queue.take(quits);
            assert.equal(traysCreated, 0);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  it.effect("stays running without a tray on macOS when the last window closes", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let quits = 0;
      let traysCreated = 0;
      const layer = layerBackgroundTest({
        platform: "darwin",
        appListeners,
        quit: Effect.sync(() => {
          quits += 1;
        }),
        activate: Effect.void,
        localService: DesktopLocalService.layerTest({ spawned: true }),
        createTray: () => {
          traysCreated += 1;
          return { destroy: () => undefined };
        },
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          appListeners.get("window-all-closed")?.();
          for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
          assert.equal(quits, 0);
          assert.equal(traysCreated, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
