/**
 * The windows installed pages open in. Each install gets at most one window,
 * built with the same sandbox, context isolation and preload as a project
 * window, locked to its own route: any other document navigation and every
 * new window goes to the system browser, so a page can never turn its window
 * into a browser for the app's own origin. The frame the page runs in is held
 * to the one version the window was told to show: any other frame navigation
 * is stopped, so content from elsewhere never stands where the page stood.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { DESKTOP_WINDOW_ROLE_ARGUMENT, getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ExternalBrowsers from "../preview/ExternalBrowsers.ts";
import { artifactAppVersionUrl } from "./ArtifactAppPowers.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import {
  ARTIFACT_APP_WINDOW_ARGUMENT,
  artifactAppUserModelId,
  artifactAppWindowUrl,
  isArtifactAppInstallId,
} from "./ArtifactAppUrl.ts";

const ARTIFACT_APP_WINDOW_LIMIT = 10;
const ARTIFACT_APP_WINDOW_ROLE = "artifact-app";
const DEFAULT_SIZE = { width: 1000, height: 720 } as const;
const MINIMUM_SIZE = { width: 360, height: 300 } as const;
const MACOS_HEADER_HEIGHT = 44;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-windows");

/** Whether one more installed-page window may open while `openCount` are open. */
export function canOpenAnotherArtifactAppWindow(openCount: number): boolean {
  return openCount < ARTIFACT_APP_WINDOW_LIMIT;
}

/**
 * Whether the window may follow a document navigation to `targetUrl`. Only its
 * own route is allowed: same scheme, host, path, query and hash. `.origin` is
 * not used because it is the string "null" for custom schemes. Hash-only route
 * changes inside the client never reach this check (they are in-page).
 */
export function isArtifactAppWindowNavigationAllowed(input: {
  readonly windowUrl: string;
  readonly targetUrl: string;
}): boolean {
  try {
    const own = new URL(input.windowUrl);
    const target = new URL(input.targetUrl);
    return (
      own.host !== "" &&
      target.username === "" &&
      target.password === "" &&
      own.protocol === target.protocol &&
      own.host === target.host &&
      own.pathname === target.pathname &&
      own.search === target.search &&
      own.hash === target.hash
    );
  } catch {
    return false;
  }
}

/**
 * Whether a frame inside the window may go to `targetUrl`. Only the version
 * the window shows is allowed, at exactly its address (the fragment aside,
 * which carries the theme). With no version set, or an address that does not
 * parse, nothing is allowed.
 */
export function isArtifactAppFrameNavigationAllowed(input: {
  readonly versionUrl: string | null;
  readonly targetUrl: string;
}): boolean {
  if (input.versionUrl === null) return false;
  const target = artifactAppVersionUrl(input.targetUrl);
  return target !== null && target === input.versionUrl;
}

// Chromium's ERR_ABORTED: the navigation was stopped before anything loaded.
const NAVIGATION_ABORTED = -3;

// A frame's empty first document and inline `srcdoc` content: no address was loaded.
const INLINE_FRAME_URLS: ReadonlySet<string> = new Set(["about:blank", "about:srcdoc"]);

/** The web address a blocked navigation or popup may open in the browser, or null. */
export function artifactAppExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export type ArtifactAppWindowOpenResult = "opened" | "focused" | "unknown" | "limit" | "failed";

export class ArtifactAppWindows extends Context.Service<
  ArtifactAppWindows,
  {
    /** Opens the install's window, or brings the open one forward. */
    readonly open: (installId: string) => Effect.Effect<ArtifactAppWindowOpenResult>;
    /** The install an installed-page window's renderer shows. */
    readonly installIdForWebContents: (
      webContentsId: number,
    ) => Effect.Effect<Option.Option<string>>;
    /** The install's open window. */
    readonly windowForInstall: (
      installId: string,
    ) => Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    /**
     * Names the one address the window's page frame may be at, or none. Until
     * it is set, and after it is cleared, every frame navigation is stopped.
     */
    readonly setVersionUrl: (installId: string, url: Option.Option<string>) => Effect.Effect<void>;
    /**
     * Whether every frame in the window has stayed on the version since it was
     * set. False when unknown, when no version is set, or once any frame has
     * been seen at another address.
     */
    readonly isFrameOnVersion: (installId: string) => Effect.Effect<boolean>;
    /** Calls `listener` with the install id each time one of these windows has closed. */
    readonly onClosed: (listener: (installId: string) => void) => Effect.Effect<void>;
    /**
     * Calls `listener` with the install id the moment a window stops being on
     * its version: a frame was seen at another address, the window's own
     * document was replaced, or its page process ended.
     */
    readonly onFrameStrayed: (listener: (installId: string) => void) => Effect.Effect<void>;
    /** Closes the install's window after the current IPC reply has gone out. */
    readonly close: (installId: string) => Effect.Effect<void>;
    readonly closeAll: Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppWindows") {}

function iconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  // macOS takes the icon from the app bundle.
  if (platform === "darwin") return {};
  const icon = platform === "win32" ? iconPaths.ico : iconPaths.png;
  return Option.match(icon, { onNone: () => ({}), onSome: (path) => ({ icon: path }) });
}

// Same title bar as every app window: the page's header sits under the window controls.
// The app's appearance sync updates the Windows and Linux overlay, and a zoom change moves
// the macOS buttons, on every app window, so a native title bar would break both.
function titleBarOptions(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean,
): Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition"
> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      // Centred in the 44px header, as the main window's buttons are.
      trafficLightPosition: { x: 16, y: MACOS_HEADER_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS },
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      // Fully transparent does not draw correctly on Linux.
      color: "#01000000",
      height: 40,
      symbolColor: shouldUseDarkColors ? "#f8fafc" : "#1f2937",
    },
  };
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  // Optional so tests need not provide it; the app always does.
  const externalBrowsers = yield* Effect.serviceOption(ExternalBrowsers.ExternalBrowsers);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // One open at a time, so two launches of one install cannot make two windows or pass the cap.
  const openLock = yield* Semaphore.make(1);
  const windows = new Map<string, Electron.BrowserWindow>();
  const installIdsByWebContents = new Map<number, string>();
  // The address each window's page frame may be at, without its fragment.
  const versionUrls = new Map<string, string>();
  // Windows where a frame was seen somewhere else since the version was set.
  const strayedFrames = new Set<string>();
  const closedListeners: Array<(installId: string) => void> = [];
  const strayedListeners: Array<(installId: string) => void> = [];
  const tell = (listeners: ReadonlyArray<(installId: string) => void>, installId: string) => {
    for (const listener of listeners) {
      // One listener failing must not keep the others from releasing what they hold.
      try {
        listener(installId);
      } catch {
        // Nothing to do here: the listener owns its own failure.
      }
    }
  };

  const openExternally = (rawUrl: string) => {
    const url = artifactAppExternalUrl(rawUrl);
    if (url === null) return;
    runFork(
      Option.isSome(externalBrowsers)
        ? externalBrowsers.value.openLink(url)
        : electronShell.openExternal(url),
    );
  };

  const liveWindow = (installId: string): Electron.BrowserWindow | undefined => {
    const window = windows.get(installId);
    if (window === undefined) return undefined;
    if (window.isDestroyed()) {
      windows.delete(installId);
      return undefined;
    }
    return window;
  };

  const showLimitMessage = electronDialog
    .showMessageBox({
      type: "info",
      message: "Too many installed pages are open",
      detail: `SpecWithCode opens up to ${ARTIFACT_APP_WINDOW_LIMIT} installed pages at once. Close one of them, then open this page again.`,
      buttons: ["OK"],
      defaultId: 0,
    })
    .pipe(Effect.ignoreCause({ log: true }));

  const createWindow = Effect.fn("desktop.artifactAppWindows.create")(function* (
    installId: string,
    title: string,
  ) {
    const windowUrl = artifactAppWindowUrl(getDesktopUrl(environment.isDevelopment), installId);
    const iconPaths = yield* assets.iconPaths;
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const window = yield* electronWindow.create({
      ...DEFAULT_SIZE,
      minWidth: MINIMUM_SIZE.width,
      minHeight: MINIMUM_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title,
      ...titleBarOptions(environment.platform, shouldUseDarkColors),
      backgroundColor: shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
      ...iconOption(iconPaths, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The page itself sits in a sandboxed iframe; this window never hosts a browser tab.
        webviewTag: false,
        additionalArguments: [
          `${DESKTOP_WINDOW_ROLE_ARGUMENT}${ARTIFACT_APP_WINDOW_ROLE}`,
          `${ARTIFACT_APP_WINDOW_ARGUMENT}${installId}`,
        ],
      },
    });
    const webContentsId = window.webContents.id;

    // Recorded and registered before the first load: IPC only answers registered app
    // windows, and the preload calls into the main process while the page loads.
    windows.set(installId, window);
    installIdsByWebContents.set(webContentsId, installId);
    window.once("closed", () => {
      const current = windows.get(installId) === window;
      if (current) windows.delete(installId);
      installIdsByWebContents.delete(webContentsId);
      if (!current) return;
      versionUrls.delete(installId);
      strayedFrames.delete(installId);
      tell(closedListeners, installId);
    });
    yield* electronWindow.registerSecondary(window, { role: "page" });

    if (environment.platform === "win32") {
      // Each installed page groups on its own in the taskbar, like the shortcut that opened it.
      window.setAppDetails({
        appId: artifactAppUserModelId(environment.appUserModelId, installId),
      });
    }
    // The window keeps the app's name; the client's document title would replace it.
    window.on("page-title-updated", (event) => event.preventDefault());
    const guardNavigation = (event: { preventDefault: () => void }, url: string) => {
      if (isArtifactAppWindowNavigationAllowed({ windowUrl, targetUrl: url })) return;
      event.preventDefault();
      openExternally(url);
    };
    window.webContents.on("will-navigate", guardNavigation);
    // Frames inside the window: the page's sandboxed frame and anything it
    // embeds. Each may only be at the version this window shows, whether the
    // move comes from a script, a form, a refresh or a redirect. A stopped
    // frame navigation opens nothing: no person asked for it.
    const frameMayGoTo = (url: string) =>
      // The live window only: a window that was replaced has no version.
      windows.get(installId) === window &&
      isArtifactAppFrameNavigationAllowed({
        versionUrl: versionUrls.get(installId) ?? null,
        targetUrl: url,
      });
    const stray = () => {
      if (windows.get(installId) !== window || strayedFrames.has(installId)) return;
      strayedFrames.add(installId);
      tell(strayedListeners, installId);
    };
    window.webContents.on("will-frame-navigate", (event) => {
      // The window's own document is `will-navigate`'s.
      if (event.isMainFrame === true) return;
      if (!frameMayGoTo(event.url)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event) => {
      if (event.isMainFrame === true) return guardNavigation(event, event.url);
      if (!frameMayGoTo(event.url)) event.preventDefault();
    });
    // What actually loaded. A frame that arrives anywhere else, by a road the
    // two guards above did not see, ends this version's powers.
    // The window's own document was replaced (a reload, say) or failed to load. The view
    // that named the version is gone with it, so the version is over until a new view names one.
    const windowDocumentGone = () => {
      if (windows.get(installId) === window && versionUrls.delete(installId)) stray();
    };
    window.webContents.on("did-frame-navigate", (_event, url, code, _status, isMainFrame) => {
      if (isMainFrame === true) return windowDocumentGone();
      if (typeof url === "string" && INLINE_FRAME_URLS.has(url)) return;
      if (typeof url !== "string" || !frameMayGoTo(url)) return stray();
      // The right address with an error answer (an expired link, say) is not the version.
      if (typeof code !== "number" || !(code >= 200 && code < 400)) stray();
    });
    // A load that failed left an error page where the document was. A navigation that was
    // only stopped (ours are) leaves the document in place and is not one of these.
    window.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (code === NAVIGATION_ABORTED) return;
      if (isMainFrame === true) return windowDocumentGone();
      stray();
    });
    // A page process that ended holds no version: what comes back is a new document.
    window.webContents.on("render-process-gone", stray);
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });

    let shown = false;
    const show = () => {
      if (shown || window.isDestroyed()) return;
      shown = true;
      runFork(electronWindow.reveal(window));
    };
    window.once("ready-to-show", show);
    // A window whose page failed to load still shows, so the person sees the failure.
    window.webContents.on(
      "did-fail-load",
      (_event, _code, _description, _url, isMainFrame) => isMainFrame && show(),
    );
    void window.loadURL(windowUrl).catch(() => undefined);
    return window;
  });

  const open = Effect.fn("desktop.artifactAppWindows.open")(
    function* (installId: string) {
      if (!isArtifactAppInstallId(installId)) return "unknown" as const;
      const existing = liveWindow(installId);
      if (existing !== undefined) {
        yield* electronWindow.reveal(existing);
        return "focused" as const;
      }
      const app = yield* records.get(installId);
      if (Option.isNone(app)) {
        yield* logInfo("ignored an open for an install that is not recorded");
        return "unknown" as const;
      }
      const openCount = [...windows.keys()].filter((id) => liveWindow(id) !== undefined).length;
      if (!canOpenAnotherArtifactAppWindow(openCount)) {
        yield* logInfo("installed page window limit reached", { openCount });
        // The dialog waits for the person; the lock must not.
        runFork(showLimitMessage);
        return "limit" as const;
      }
      return yield* createWindow(installId, app.value.name).pipe(
        Effect.as("opened" as const),
        Effect.catchTags({
          ElectronWindowCreateError: (error) =>
            logWarning("installed page window could not be created", { error: error.message }).pipe(
              Effect.as("failed" as const),
            ),
        }),
      );
    },
    (effect, installId) => openLock.withPermits(1)(effect).pipe(Effect.annotateLogs({ installId })),
  );

  const closeWindow = (window: Electron.BrowserWindow) =>
    // Deferred a turn so an uninstall asked from this window still gets its reply.
    Effect.sync(() => {
      setImmediate(() => {
        if (!window.isDestroyed()) window.close();
      });
    });

  return ArtifactAppWindows.of({
    open,
    installIdForWebContents: (webContentsId) =>
      Effect.sync(() => {
        const installId = installIdsByWebContents.get(webContentsId);
        return installId !== undefined && liveWindow(installId) !== undefined
          ? Option.some(installId)
          : Option.none();
      }),
    windowForInstall: (installId) =>
      Effect.sync(() => Option.fromUndefinedOr(liveWindow(installId))),
    setVersionUrl: (installId, url) =>
      Effect.sync(() => {
        strayedFrames.delete(installId);
        const versionUrl = Option.isSome(url) ? artifactAppVersionUrl(url.value) : null;
        if (versionUrl === null || liveWindow(installId) === undefined) {
          versionUrls.delete(installId);
        } else {
          versionUrls.set(installId, versionUrl);
        }
      }),
    isFrameOnVersion: (installId) =>
      Effect.sync(
        () =>
          liveWindow(installId) !== undefined &&
          versionUrls.has(installId) &&
          !strayedFrames.has(installId),
      ),
    onClosed: (listener) =>
      Effect.sync(() => {
        closedListeners.push(listener);
      }),
    onFrameStrayed: (listener) =>
      Effect.sync(() => {
        strayedListeners.push(listener);
      }),
    close: (installId) =>
      Effect.suspend(() => {
        const window = liveWindow(installId);
        return window === undefined ? Effect.void : closeWindow(window);
      }),
    closeAll: Effect.suspend(() =>
      Effect.forEach([...windows.values()], closeWindow, { discard: true }),
    ),
  });
});

export const layer = Layer.effect(ArtifactAppWindows, make);
