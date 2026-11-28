// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Electron main-process windows and one small file of window places, outside any Effect fiber.
/**
 * A window of its own for each machine whose screen this app shows (1519).
 * Built like an installed page's window: the same sandbox, context isolation
 * and preload as every app window, locked to its one route; any other
 * navigation and every new window goes to the system browser.
 *
 * One window per machine: asking again brings it forward. The window counts
 * as showing a remote screen from creation to close, so computer use here
 * stays paused for as long as it is open, whatever its page reports.
 */
import * as NodeFS from "node:fs";

import * as Electron from "electron";

import {
  SCREEN_VIEWER_MIN_SIZE,
  SCREEN_VIEWER_WINDOW_ROLE,
  isScreenViewerNavigationAllowed,
  parseViewerPlaces,
  placeViewerWindow,
  rememberViewerPlace,
  screenViewerMachineName,
  screenViewerWindowTitle,
  screenViewerWindowUrl,
} from "./screenViewerWindows.logic.ts";
import { isScreenViewEnvironmentId, type ScreenViewingRegistry } from "./screenViewing.logic.ts";

/** At most this many viewer windows at once: each holds a live session. */
export const SCREEN_VIEWER_WINDOW_LIMIT = 8;
const MACOS_HEADER_HEIGHT = 44;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

export type ScreenViewerOpenResult = "opened" | "focused" | "invalid" | "limit" | "failed";

export interface ScreenViewerWindowsDeps {
  readonly desktopUrl: string;
  readonly preloadPath: string;
  readonly platform: NodeJS.Platform;
  readonly roleArgument: string;
  readonly placesFile: string;
  readonly registry: ScreenViewingRegistry;
  /** Makes the window through the app's own window service, or null when it cannot. */
  readonly create: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Promise<Electron.BrowserWindow | null>;
  /** Counts it among the app's windows, so IPC answers it. */
  readonly register: (window: Electron.BrowserWindow) => void;
  readonly reveal: (window: Electron.BrowserWindow) => void;
  readonly openExternal: (url: string) => void;
}

export class ScreenViewerWindows {
  private readonly windows = new Map<string, Electron.BrowserWindow>();
  private readonly opening = new Set<string>();
  private places: Map<string, { x: number; y: number; width: number; height: number }> | null =
    null;

  private readonly deps: ScreenViewerWindowsDeps;

  constructor(deps: ScreenViewerWindowsDeps) {
    this.deps = deps;
  }

  private live(environmentId: string): Electron.BrowserWindow | undefined {
    const window = this.windows.get(environmentId);
    if (window === undefined) return undefined;
    if (window.isDestroyed()) {
      this.windows.delete(environmentId);
      return undefined;
    }
    return window;
  }

  private readPlaces() {
    if (this.places !== null) return this.places;
    let text: string | null = null;
    try {
      text = NodeFS.readFileSync(this.deps.placesFile, "utf8");
    } catch {
      text = null;
    }
    this.places = parseViewerPlaces(text);
    return this.places;
  }

  private savePlace(environmentId: string, window: Electron.BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const text = rememberViewerPlace(this.readPlaces(), environmentId, window.getNormalBounds());
    try {
      const temporary = `${this.deps.placesFile}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, text, { mode: 0o600 });
      NodeFS.renameSync(temporary, this.deps.placesFile);
    } catch {
      // Not kept: the window opens in the default place next time.
    }
  }

  /** Brings forward the window that shows this renderer, if any. */
  revealOwner(owner: number): boolean {
    const contents = Electron.webContents.fromId(owner);
    const window = contents === undefined ? null : Electron.BrowserWindow.fromWebContents(contents);
    if (window === null || window.isDestroyed()) return false;
    this.deps.reveal(window);
    return true;
  }

  async open(environmentId: unknown, name: unknown): Promise<ScreenViewerOpenResult> {
    if (!isScreenViewEnvironmentId(environmentId)) return "invalid";
    const existing = this.live(environmentId);
    if (existing !== undefined) {
      this.deps.reveal(existing);
      return "focused";
    }
    // A view of this machine inside another window: that one comes forward instead.
    const owner = this.deps.registry.ownerOf(environmentId);
    if (owner !== undefined && this.revealOwner(owner)) return "focused";
    if (this.opening.has(environmentId)) return "focused";
    const openCount = [...this.windows.keys()].filter((id) => this.live(id) !== undefined).length;
    if (openCount >= SCREEN_VIEWER_WINDOW_LIMIT) return "limit";
    this.opening.add(environmentId);
    try {
      return await this.create(environmentId, name, openCount);
    } finally {
      this.opening.delete(environmentId);
    }
  }

  private async create(
    environmentId: string,
    name: unknown,
    openCount: number,
  ): Promise<ScreenViewerOpenResult> {
    const title = screenViewerWindowTitle(name);
    const url = screenViewerWindowUrl(
      this.deps.desktopUrl,
      environmentId,
      screenViewerMachineName(name),
    );
    const bounds = placeViewerWindow({
      saved: this.readPlaces().get(environmentId),
      workAreas: Electron.screen.getAllDisplays().map((display) => display.workArea),
      openCount,
    });
    const dark = Electron.nativeTheme.shouldUseDarkColors;
    const window = await this.deps.create({
      ...bounds,
      minWidth: SCREEN_VIEWER_MIN_SIZE.width,
      minHeight: SCREEN_VIEWER_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title,
      backgroundColor: dark ? "#0a0a0a" : "#ffffff",
      ...(this.deps.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: {
              x: 16,
              y: MACOS_HEADER_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
            },
          }
        : {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: {
              color: "#01000000",
              height: 40,
              symbolColor: dark ? "#f8fafc" : "#1f2937",
            },
          }),
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // A screen in a background window keeps drawing; the session's own pace bounds the cost.
        backgroundThrottling: false,
        additionalArguments: [`${this.deps.roleArgument}${SCREEN_VIEWER_WINDOW_ROLE}`],
      },
    });
    if (window === null) return "failed";
    // Another window began viewing this machine while this one was being made: that one wins.
    const holder = this.deps.registry.ownerOf(environmentId);
    if (holder !== undefined && this.revealOwner(holder)) {
      window.destroy();
      return "focused";
    }
    const owner = window.webContents.id;
    this.windows.set(environmentId, window);
    // Counted before its page loads: from now until it closes this machine shows a remote screen.
    this.deps.registry.holdWindow(owner, environmentId);
    this.deps.register(window);
    window.once("closed", () => {
      this.deps.registry.release(owner);
      if (this.windows.get(environmentId) === window) this.windows.delete(environmentId);
    });
    // The page's own title would replace the machine's name.
    window.on("page-title-updated", (event) => event.preventDefault());
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const saveSoon = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this.savePlace(environmentId, window), 400);
    };
    window.on("resize", saveSoon);
    window.on("move", saveSoon);
    window.on("close", () => {
      clearTimeout(saveTimer);
      this.savePlace(environmentId, window);
    });
    const guard = (event: { preventDefault: () => void }, target: string) => {
      if (isScreenViewerNavigationAllowed(url, target)) return;
      event.preventDefault();
      if (/^https?:/i.test(target)) this.deps.openExternal(target);
    };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", (event) => {
      if (event.isMainFrame === true) guard(event, event.url);
    });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) this.deps.openExternal(target);
      return { action: "deny" };
    });
    let shown = false;
    const show = () => {
      if (shown || window.isDestroyed()) return;
      shown = true;
      this.deps.reveal(window);
    };
    window.once("ready-to-show", show);
    window.webContents.on(
      "did-fail-load",
      (_event, _code, _description, _url, isMainFrame) => isMainFrame && show(),
    );
    void window.loadURL(url).catch(() => undefined);
    return "opened";
  }

  closeAll(): void {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.close();
    this.windows.clear();
  }
}
