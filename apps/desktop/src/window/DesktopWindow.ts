import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import { type DesktopSnapShotEvent, DEFAULT_CLIENT_SETTINGS } from "@specweave-studio/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import {
  DESKTOP_WINDOW_PROJECT_ARGUMENT,
  DESKTOP_WINDOW_ROLE_ARGUMENT,
  getDesktopProjectWindowUrl,
  getDesktopUrl,
} from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ExternalBrowsers from "../preview/ExternalBrowsers.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { makeQuitShortcutHandler } from "./QuitHold.ts";

const TITLEBAR_HEIGHT = 40;
// Matches --workspace-topbar-height in apps/web/src/styles/base.css. Native macOS
// buttons are 14 points tall and do not scale with the renderer's zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 44;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function syncMacosWindowButtons(
  window: Electron.BrowserWindow,
  zoomFactor: number = window.webContents.getZoomFactor(),
): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round((MACOS_WORKSPACE_TOPBAR_HEIGHT * zoomFactor) / 2 - MACOS_WINDOW_BUTTON_RADIUS),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
// A project window with no saved position opens offset from the main window
// instead of exactly on top of it.
const PROJECT_WINDOW_CASCADE_OFFSET = 32;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
// Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
// short delay, at most MAX_ATTEMPTS times per rolling WINDOW so a renderer
// that dies on boot cannot reload-loop forever.
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2, // ERR_FAILED
  -7, // ERR_TIMED_OUT
  -9, // ERR_UNEXPECTED (custom protocol handler rejected)
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
]);

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | DesktopRendererHistory.DesktopRendererHistory
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";

export interface OpenProjectWindowInput {
  readonly projectKey: string;
  readonly title?: string | undefined;
}

// What differs between the main window and a project window. Everything else
// (security preferences, context menu, quit shortcut, crash recovery) is shared.
interface AppWindowSpec {
  readonly role: "main" | "project";
  // The project a project window was opened for.
  readonly projectKey?: string;
  readonly url: string;
  readonly title: string;
  readonly persisted: {
    readonly bounds: DesktopAppSettings.DesktopWindowBounds | null;
    readonly maximized: boolean;
  };
  // Where a window with no restorable saved bounds opens; null centers it.
  readonly fallbackBounds: DesktopAppSettings.DesktopWindowBounds | null;
  readonly persistBounds: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
    isMaximized: boolean,
  ) => Effect.Effect<unknown, DesktopAppSettings.DesktopSettingsWriteError>;
}

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    // Opens one project in its own window on the same backend, or brings that
    // project's window forward when it is already open. The window remembers
    // its own position per project and never becomes the main window.
    readonly openProjectWindow: (
      input: OpenProjectWindowInput,
    ) => Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    // Show a lightweight "Connecting to WSL" splash window immediately (wsl-only
    // mode), before the WSL backend that acts as the primary is ready. It is
    // dismissed automatically once the real main window reveals.
    readonly showConnectingSplash: Effect.Effect<void>;
    // The same splash while the installed Studio service restarts on an update:
    // the app waits for it instead of starting its own server, and must not sit
    // there with no window. Dismissed the same way.
    readonly showServiceUpdateSplash: Effect.Effect<void>;
    // Marks the primary backend as ready so `createMainIfBackendReady` and the
    // macOS "activate without windows" path may open the real main window. The
    // renderer now always loads the local client URL (getDesktopUrl) and connects
    // to the backend through the connection layer, so the reported httpBaseUrl is
    // no longer used to point the window at the backend — it is kept only for the
    // readiness log and to preserve the callback contract the backend pool drives.
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    // Called when the backend transitions back to "not ready" (clean stop,
    // restart, crash). Clears the latch that lets `activate` auto-create a
    // window so a "macOS dock click" while the backend is down doesn't
    // produce a stranded window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    /**
     * Push a capture lifecycle event to the renderer. Only `started` reveals the
     * window; the rest must not interrupt the app the user has switched to.
     */
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Zooms the main window's own webContents. The Electron `zoomIn`/`zoomOut`
    // menu roles act on whichever webContents has keyboard focus, so with an
    // embedded preview WebContentsView (or DevTools) focused they zoom the
    // guest page instead of the app UI. The menu routes here to always target
    // the main window.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

const CONNECTING_TO_WSL_LABEL = "Connecting to WSL…";
const WAITING_FOR_SERVICE_UPDATE_LABEL = "Waiting for the SpecWithCode service update…";

// A self-contained splash, shown immediately in wsl-only mode while the WSL
// backend (which serves the renderer) cold-boots, or while the installed
// service restarts on an update. Inlined as a data URL so it needs no bundled
// asset and no backend — pure CSS, no JS. Labels are fixed strings, never input.
function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean, label: string): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const labelColor = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${labelColor};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">${label}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// A project window with no usable saved position is placed down and right of
// the main window, one step further for each project window already open, so
// every window stays visible and can be dragged to another screen. When that
// spot is off every display it is centered instead.
export function resolveProjectWindowFallbackBounds(
  mainBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
  step = 1,
): DesktopAppSettings.DesktopWindowBounds | null {
  if (mainBounds === null) return null;
  const offset = PROJECT_WINDOW_CASCADE_OFFSET * Math.max(1, step);
  const cascaded = {
    x: mainBounds.x + offset,
    y: mainBounds.y + offset,
    width: DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE.width,
    height: DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE.height,
  };
  return displays.some((display) => windowFitsWithinDisplay(cascaded, display)) ? cascaded : null;
}

// Whether a project window still shows the project it was opened for. Keys can
// extend one another ("repo" and "repo::packages/web"), so the project URL
// must be followed by the end of the URL or a route separator, never by more
// of a longer key.
export function isProjectWindowOnUrl(currentUrl: string, projectUrl: string): boolean {
  if (!currentUrl.startsWith(projectUrl)) return false;
  const rest = currentUrl.slice(projectUrl.length);
  return rest === "" || /^[/?#]/.test(rest);
}

export function resolveProjectWindowTitle(
  appName: string,
  projectTitle: string | undefined,
): string {
  const trimmed = projectTitle?.trim() ?? "";
  return trimmed === "" ? appName : `${trimmed} - ${appName}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

export function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

export function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Electron implements window opacity on macOS and Windows. Linux keeps the
  // release-gated quit behavior but cannot make the pending window disappear.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  // Optional so window tests need not provide it; the app always does.
  const externalBrowsers = yield* Effect.serviceOption(ExternalBrowsers.ExternalBrowsers);
  // Links leaving the app follow "Open links in": a chosen browser profile, or
  // the OS default browser.
  const openLinkExternally = (url: string) =>
    Option.isSome(externalBrowsers)
      ? externalBrowsers.value.openLink(url)
      : electronShell.openExternal(url);
  // Window-side latch for the primary backend's readiness. Set by
  // handleBackendReady (driven by the pool's onReady callback), cleared
  // by handleBackendNotReady (driven by onShutdown). Only consumed by
  // createMainIfBackendReady, which gates the post-readiness window
  // open in development and the macOS "activate without windows" path.
  const backendReadyRef = yield* Ref.make(false);
  // The transient "Connecting to WSL" splash window, tracked separately so it
  // is never mistaken for the real main window.
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  // One pending-bounds flush per open app window, so quitting saves the
  // position of the main window and of every project window.
  const windowBoundsFlushers = new Map<number, Effect.Effect<void>>();
  const windowTitleSetters = new Map<number, (title: string) => void>();
  const projectWindows = new Map<string, Electron.BrowserWindow>();
  // Windows that have shown themselves after their first page was ready.
  const revealedWindows = new WeakSet<Electron.BrowserWindow>();
  const openProjectWindowLock = yield* Semaphore.make(1);

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  // currentMainOrFirst / focusedMainOrFirst fall back to "any first window",
  // which during WSL-only boot is the connecting splash. The splash is never
  // registered via setMain, so it must be treated as "no real main window" --
  // otherwise ensureMain/activate/dispatchMenuAction latch onto it and never
  // open (or retry) the real main. That is the failure the pool's swallowed
  // post-readiness window-open error would otherwise strand the user in:
  // splash up, backend ready, no main, and activation only re-reveals splash.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash));
  const focusedMainWindow = electronWindow.focusedMainOrFirst.pipe(Effect.flatMap(withoutSplash));

  const readDisplayBounds = Effect.gen(function* () {
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    return displayBoundsResult._tag === "Success"
      ? displayBoundsResult.bounds
      : yield* logWindowWarning("failed to read connected displays; using defaults", {
          cause: displayBoundsResult.cause,
        }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
  });

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (
    spec: AppWindowSpec,
  ): Effect.fn.Return<Electron.BrowserWindow, DesktopWindowError> {
    yield* previewManager.getBrowserSession();
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const windowLabel = `${spec.role} window`;
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedBounds = spec.persisted.bounds;
    const displayBounds = yield* readDisplayBounds;
    const resolvedBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && resolvedBounds === persistedBounds;
    if (
      persistedBounds !== null &&
      resolvedBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE
    ) {
      yield* logWindowWarning(`saved ${windowLabel} bounds could not be restored; using defaults`);
    }
    const initialBounds =
      resolvedBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE && spec.fallbackBounds !== null
        ? spec.fallbackBounds
        : resolvedBounds;
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: spec.title,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // The window boots hidden (show: false until ready-to-show), and
        // Chromium throttles hidden renderers: timers coalesce and rAF stops,
        // which stalls first paint. Boot unthrottled; the first-reveal trigger
        // re-enables throttling so a hidden or minimized window goes back to
        // being cheap after it has been shown once.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        additionalArguments: [
          `${DESKTOP_WINDOW_ROLE_ARGUMENT}${spec.role}`,
          ...(spec.projectKey === undefined
            ? []
            : [`${DESKTOP_WINDOW_PROJECT_ARGUMENT}${encodeURIComponent(spec.projectKey)}`]),
        ],
      },
    });

    yield* rendererHistory.register(window.webContents, { surface: spec.role });
    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = spec.persisted.maximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        spec.persistBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning(`failed to persist ${windowLabel} bounds`, {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    const windowId = window.id;
    windowBoundsFlushers.set(windowId, flushBoundsPersist);
    let title = spec.title;
    windowTitleSetters.set(windowId, (nextTitle) => {
      title = nextTitle;
      if (!window.isDestroyed()) window.setTitle(nextTitle);
    });

    // The preview browser has one main host window; a project window is an
    // additional host so previews opened inside it are managed the same way.
    if (spec.role === "main") {
      yield* previewManager.setMainWindow(window);
    } else {
      yield* previewManager.addHostWindow(window);
    }
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Native editing roles act on the focused contents, which may still be
        // the host renderer when the user right-clicks inside a browser guest.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: "No suggestions", enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: "Copy Image",
            click: () => {
              if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents);
      void runPromise(previewManager.prepareWebview(contents));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(openLinkExternally(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(openLinkExternally(url));
      }
    });

    // Electron's windowMenu close role owns CmdOrCtrl+W. Holding the
    // close-terminal shortcut can outlive the terminal that handled its first
    // press, so reject repeats before they reach the native window accelerator.
    // Deliberate presses still flow through the renderer or native menu.
    // Intercept the quit accelerator before the native menu sees it and apply
    // the configured direct, hold, or double-press behavior.
    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Keep the transparent window focused until the physical shortcut is
      // released so its remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });
    window.webContents.on("input-event", (_event, input) => {
      if (input.type === "gestureScrollEnd") window.webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(title);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      void window.loadURL(spec.url).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      window.setTitle(title);
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runPromise(
          logWindowWarning(`${windowLabel} failed to load`, {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "abnormal-exit";
      // Long sessions can OOM the renderer (V8 heap exhaustion from
      // accumulated thread state). Without a reload the user is left staring
      // at a dead white window while agents keep running invisibly, so
      // recover by reloading — the renderer rehydrates from the backend,
      // which is unaffected. Recovery attempts are bounded so a renderer
      // that dies immediately on boot cannot reload-loop forever.
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWindowWarning(`${windowLabel} render process gone`, {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    bindFirstRevealTrigger(revealSubscribers, () => {
      revealedWindows.add(window);
      // Boot is done; hand the window back to normal hidden-window throttling
      // (see the backgroundThrottling comment on the create options above).
      if (!window.isDestroyed()) {
        window.webContents.setBackgroundThrottling(true);
      }
      // Reveal the real window, then close the connecting splash (if any) so the
      // two don't overlap and there's no blank gap between them.
      if (spec.persisted.maximized) {
        window.maximize();
      }
      void runPromise(
        spec.role === "main"
          ? Effect.andThen(electronWindow.reveal(window), dismissConnectingSplash)
          : electronWindow.reveal(window),
      );
    });

    loadApplication();
    if (environment.isDevelopment && spec.role === "main") {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      windowTitleSetters.delete(windowId);
      // A write started by "close" may still be running. Quit has to be able
      // to wait for it, so the entry stays until that write settles.
      const pendingPersist = pendingBoundsPersistFiber;
      if (pendingPersist === undefined) {
        windowBoundsFlushers.delete(windowId);
      } else {
        const joinPendingPersist = Fiber.join(pendingPersist).pipe(Effect.asVoid);
        windowBoundsFlushers.set(windowId, joinPendingPersist);
        runFork(
          Fiber.await(pendingPersist).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (windowBoundsFlushers.get(windowId) === joinPendingPersist) {
                  windowBoundsFlushers.delete(windowId);
                }
              }),
            ),
          ),
        );
      }
      // clearMain only clears when this window is the main one.
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const createMain = Effect.gen(function* () {
    const persistedSettings = yield* desktopSettings.get;
    const window = yield* createWindow({
      role: "main",
      url: getDesktopUrl(environment.isDevelopment),
      title: environment.displayName,
      persisted: {
        bounds: persistedSettings.mainWindowBounds,
        maximized: persistedSettings.mainWindowMaximized,
      },
      fallbackBounds: null,
      persistBounds: desktopSettings.setMainWindowBounds,
    });
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const openProjectWindow = Effect.fn("desktop.window.openProjectWindow")(function* (
    input: OpenProjectWindowInput,
  ): Effect.fn.Return<Electron.BrowserWindow, DesktopWindowError> {
    const { projectKey } = input;
    const url = getDesktopProjectWindowUrl(environment.isDevelopment, projectKey);
    const existing =
      projectWindows.get(projectKey) ??
      [...new Set(projectWindows.values())].find(
        (window) => !window.isDestroyed() && isProjectWindowOnUrl(window.webContents.getURL(), url),
      );
    if (existing !== undefined && !existing.isDestroyed()) {
      // A first handoff can replace a legacy route with its canonical domain key.
      // Keep the existing native window and its old alias alive; no history is closed.
      projectWindows.set(projectKey, existing);
      // The project may have been renamed since the window opened.
      if (input.title !== undefined) {
        windowTitleSetters.get(existing.id)?.(
          resolveProjectWindowTitle(environment.displayName, input.title),
        );
      }
      // A second request while the window is still starting (a double click)
      // leaves it alone: it shows itself once its first page is ready.
      if (!revealedWindows.has(existing) && existing.webContents.isLoadingMainFrame()) {
        return existing;
      }
      // The window may have been navigated elsewhere since it opened; asking
      // for the project again brings it back to the project.
      if (!isProjectWindowOnUrl(existing.webContents.getURL(), url)) {
        void existing.loadURL(url).catch(() => undefined);
      }
      yield* electronWindow.reveal(existing);
      return existing;
    }

    const persistedSettings = yield* desktopSettings.get;
    const saved = DesktopAppSettings.findProjectWindowState(persistedSettings, projectKey);
    const openProjectWindowCount = [...new Set(projectWindows.values())].filter(
      (window) => !window.isDestroyed(),
    ).length;
    const main = yield* electronWindow.main;
    const mainBounds = Option.isSome(main)
      ? DesktopAppSettings.normalizeMainWindowBounds(main.value.getNormalBounds())
      : null;
    const window = yield* createWindow({
      role: "project",
      projectKey,
      url,
      title: resolveProjectWindowTitle(environment.displayName, input.title),
      persisted: {
        bounds: saved?.bounds ?? null,
        maximized: saved?.maximized ?? false,
      },
      // Only used when there is no saved position or it is off every display.
      fallbackBounds: resolveProjectWindowFallbackBounds(
        mainBounds,
        yield* readDisplayBounds,
        openProjectWindowCount + 1,
      ),
      persistBounds: (bounds, isMaximized) =>
        desktopSettings.setProjectWindowBounds(projectKey, bounds, isMaximized),
    });
    projectWindows.set(projectKey, window);
    window.once("closed", () => {
      for (const [alias, candidate] of projectWindows)
        if (candidate === window) projectWindows.delete(alias);
    });
    yield* electronWindow.registerSecondary(window);
    yield* logWindowInfo("project window created");
    return window;
  }, openProjectWindowLock.withPermits(1));

  const ensureMain = Effect.gen(function* () {
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) {
      return existingWindow.value;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  // With the local environment disabled there is no backend to wait for: the
  // renderer is served from bundled assets and only talks to remote environments.
  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* waitingForBackend) return;
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showSplash = Effect.fn("desktop.window.showSplash")(
    function* (label: string) {
      // Only when nothing is shown yet: no real window, no existing splash.
      const existingSplash = yield* Ref.get(splashWindowRef);
      if (Option.isSome(existingSplash)) return;
      const existingWindow = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(existingWindow)) return;

      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      const splash = yield* electronWindow.create({
        width: 360,
        height: 220,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        center: true,
        show: false,
        skipTaskbar: false,
        backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
        title: environment.displayName,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      yield* rendererHistory.register(splash.webContents, { surface: "splash" });
      yield* Ref.set(splashWindowRef, Option.some(splash));
      splash.once("closed", () => {
        void runPromise(Ref.set(splashWindowRef, Option.none()));
      });
      splash.once("ready-to-show", () => {
        if (!splash.isDestroyed()) {
          splash.show();
        }
      });
      void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors, label));
      yield* logWindowInfo("connecting splash shown", { label });
    },
    // The splash is best-effort UX — never let it fail startup.
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
  );
  const showConnectingSplash = showSplash(CONNECTING_TO_WSL_LABEL);
  const showServiceUpdateSplash = showSplash(WAITING_FOR_SERVICE_UPDATE_LABEL);

  // The app window the user is in: the focused one when it is the main window
  // or a project window, otherwise the main window. Helper windows (preview
  // picture-in-picture, permission prompts) never receive app events.
  const focusedAppWindow = Effect.gen(function* () {
    const focused = yield* focusedMainWindow;
    if (Option.isSome(focused) && (yield* electronWindow.appWindows).includes(focused.value)) {
      return focused;
    }
    return yield* electronWindow.main;
  });

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    {
      reveal = true,
      target = "main",
    }: {
      readonly reveal?: boolean;
      // Without a reveal the event goes to the main window, unless it belongs
      // to whichever app window the user is working in.
      readonly target?: "main" | "focused-app";
    } = {},
  ) {
    const existingWindow = yield* target === "focused-app"
      ? reveal
        ? focusedMainWindow
        : focusedAppWindow
      : reveal
        ? currentMainWindow
        : electronWindow.main;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) return;
    const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* ensureMain;
    if (targetWindow.isDestroyed()) return;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send(channel, payload);
    });
    // The renderer must learn about the event even when another process refuses to
    // yield the foreground, so send first and treat the reveal as best effort.
    const dispatch = reveal
      ? send.pipe(Effect.andThen(electronWindow.reveal(targetWindow).pipe(Effect.ignoreCause)))
      : send;
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", () => void runPromise(dispatch));
      return;
    }
    yield* dispatch;
  });

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    activate: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
        return;
      }
      // No real main window yet. While the backend is still cold-booting,
      // re-reveal the connecting splash so taskbar/dock activation brings it
      // back instead of doing nothing. Once the backend is ready we fall
      // through to (re)create the real main -- including retrying a previously
      // failed open the pool swallowed -- rather than latching onto the splash.
      const backendReady = yield* Ref.get(backendReadyRef);
      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);
        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);
          return;
        }
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    openProjectWindow,
    showConnectingSplash,
    showServiceUpdateSplash,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      // A backend that restarts while someone works in a project window with
      // the main window closed must not open the main window over them.
      if ((yield* electronWindow.appWindows).length > 0) return;
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() =>
      Effect.forEach([...windowBoundsFlushers.values()], (flush) => flush, { discard: true }),
    ).pipe(Effect.withSpan("desktop.window.flushMainWindowBounds")),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, {
        ...options,
        target: "focused-app",
      });
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
      });
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* focusedMainWindow;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      const webContents = window.value.webContents;
      // Same step size as the Electron zoomIn/zoomOut menu roles.
      webContents.setZoomLevel(
        direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
      );
      if (environment.platform === "darwin") {
        // Zoom is shared by every window on the app origin, so each app
        // window's traffic lights move with it, not only the focused one's.
        // A focused helper window (picture-in-picture, permission helper) is
        // a different origin and leaves the app windows alone.
        const zoomFactor = webContents.getZoomFactor();
        syncMacosWindowButtons(window.value, zoomFactor);
        const appWindows = yield* electronWindow.appWindows;
        if (appWindows.includes(window.value)) {
          for (const appWindow of appWindows) {
            if (appWindow !== window.value) syncMacosWindowButtons(appWindow, zoomFactor);
          }
        }
      }
      // Chromium pushes the new level down to embedded guests, which would zoom
      // the previewed page along with the app UI. The preview browser keeps its
      // own zoom, so put each guest back where the preview left it.
      yield* previewManager.reapplyZoom();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
