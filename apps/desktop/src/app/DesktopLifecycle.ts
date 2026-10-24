import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as DesktopLocalService from "../backend/DesktopLocalService.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedError<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export class DesktopLifecycleTrayError extends Schema.TaggedError<DesktopLifecycleTrayError>()(
  "DesktopLifecycleTrayError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not create the tray icon.";
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | DesktopAssets.DesktopAssets
  | DesktopLocalService.DesktopLocalService
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopAssets | DesktopEnvironment | DesktopLocalService | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@specweave-studio/desktop/app/DesktopLifecycle") {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (
    afterBoundsFlush: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<void, never, DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow> {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* afterBoundsFlush;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* Ref.set(state.shutdownBegun, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* Ref.set(state.quitting, true);
      yield* Ref.set(state.shutdownBegun, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait(
        electronWindow.destroyAll.pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before shutdown", { cause }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).finally(() => {
    markQuitAllowed();
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.quit;
      }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
    );
  });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* Ref.set(state.shutdownBegun, true);
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* Ref.set(state.shutdownBegun, true);
      yield* requestDesktopShutdownAndWait();
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const assets = yield* DesktopAssets.DesktopAssets;
    const localService = yield* DesktopLocalService.DesktopLocalService;
    const createTray = yield* ElectronTray.ElectronTray;
    const desktopState = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    let tray: ElectronTray.ElectronTrayHandle | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        tray?.destroy();
        tray = undefined;
      }),
    );
    // The way back into an app that has no window, and the explicit Quit.
    const showBackgroundTray = Effect.gen(function* () {
      if (tray !== undefined) return;
      const iconPaths = yield* assets.iconPaths;
      const iconPath =
        environment.platform === "win32"
          ? Option.orElse(iconPaths.ico, () => iconPaths.png)
          : iconPaths.png;
      // Without an icon there is no tray; launching the app again still
      // reopens its window through the single-instance handoff.
      if (Option.isNone(iconPath)) return;
      const name = yield* electronApp.name;
      tray = yield* Effect.try({
        try: () =>
          createTray({
            iconPath: iconPath.value,
            tooltip: `${name} is running in the background`,
            openLabel: `Open ${name}`,
            quitLabel: `Quit ${name}`,
            onOpen: () => {
              void runEffect(
                desktopWindow.activate.pipe(
                  Effect.catchCause((cause) =>
                    logLifecycleError("failed to open a window from the tray", { cause }),
                  ),
                  Effect.withSpan("desktop.lifecycle.trayOpen"),
                ),
              );
            },
            onQuit: () => {
              void runEffect(electronApp.quit.pipe(Effect.withSpan("desktop.lifecycle.trayQuit")));
            },
          }),
        catch: (cause) => new DesktopLifecycleTrayError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          logLifecycleError(error.message, { error }).pipe(Effect.as(undefined)),
        ),
      );
    });
    let quitAllowed = false;
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      // This event is synchronous and the updater's quit proceeds as soon as
      // the listener returns, so a forked destroyAll would race the quit
      // and windows could still be open when the process exits (visible on
      // macOS). Destroy them inline.
      Effect.runSyncWith(context)(
        Ref.set(desktopState.updaterQuitAllowed, true).pipe(
          Effect.andThen(Ref.set(desktopState.shutdownBegun, true)),
          Effect.andThen(electronWindow.destroyAll),
          Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before updater quit", { cause }),
          ),
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed || Ref.getUnsafe(desktopState.updaterQuitAllowed),
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on("activate", () => {
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          // `quitting` alone also covers an install that has not quit the
          // app; a Dock click then still brings a window back.
          if (yield* Ref.get(state.shutdownBegun)) return;
          // A Dock click while a project window is in use must not pull the
          // main window over it. The main window is still recreated when it
          // was closed, and revealed when it is the only window left.
          const main = yield* electronWindow.main;
          if (Option.isSome(main)) {
            const appWindows = yield* electronWindow.appWindows;
            const projectWindowInUse = appWindows.some(
              (window) =>
                window !== main.value &&
                !window.isDestroyed() &&
                window.isVisible() &&
                !window.isMinimized(),
            );
            if (projectWindowInUse) return;
          }
          yield* desktopWindow.activate;
        }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (environment.platform === "darwin" || (yield* Ref.get(state.quitting))) return;
          // On macOS the app outlives its last window, and so do the backend
          // it started and the threads running there. Do the same here while
          // this app owns the backend, with a tray icon to reopen or quit.
          // An attached service runs on without the app, so the app quits.
          if (!(yield* localService.ownsBundledService)) {
            yield* app.quit;
            return;
          }
          yield* logLifecycleInfo("keeping the app-owned backend running in the background");
          yield* showBackgroundTray;
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
