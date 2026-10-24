import * as Electron from "electron";

/** Explicit opt-in for installed tests. CI/PWDEBUG alone never enables this. */
export const isDesktopOffscreenTest = () => process.env.STUDIO_DESKTOP_TEST_OFFSCREEN === "1";

export function desktopBrowserWindowOptions(
  options: Electron.BrowserWindowConstructorOptions,
): Electron.BrowserWindowConstructorOptions {
  if (!isDesktopOffscreenTest()) return options;
  return {
    ...options,
    show: false,
    focusable: false,
    skipTaskbar: true,
    fullscreen: false,
    kiosk: false,
    webPreferences: {
      ...options.webPreferences,
      offscreen: true,
      backgroundThrottling: false,
      devTools: false,
      disableDialogs: true,
    },
  };
}

const guardedWindows = new WeakSet<Electron.BrowserWindow>();

function failOffscreenTest(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(`[desktop-test-offscreen] failure: ${failure.message}\n`);
  // Fatal even if a best-effort splash/preview caller catches constructor errors.
  Electron.app.exit(1);
  throw failure;
}

export function assertDesktopOffscreenWindow(window: Electron.BrowserWindow): void {
  if (window.isDestroyed()) return;
  const state = {
    id: window.id,
    offscreen: window.webContents.isOffscreen(),
    visible: window.isVisible(),
    focused: window.isFocused(),
  };
  if (!state.offscreen || state.visible || state.focused) {
    failOffscreenTest(new Error(`BrowserWindow invariant violated: ${JSON.stringify(state)}`));
  }
}

/**
 * Keep the real window, renderer, preload and IPC. Only native presentation is
 * disabled. Never replace isVisible/isFocused/isOffscreen: tests read Electron's
 * actual state, and a native show/focus event fails the process.
 */
export function guardDesktopOffscreenWindow(window: Electron.BrowserWindow): void {
  if (!isDesktopOffscreenTest() || guardedWindows.has(window)) return;
  assertDesktopOffscreenWindow(window);
  guardedWindows.add(window);
  const assertHidden = () => assertDesktopOffscreenWindow(window);
  for (const method of [
    "show",
    "showInactive",
    "focus",
    "restore",
    "maximize",
    "moveTop",
    "setFullScreen",
    "setKiosk",
    "setFocusable",
  ] as const) {
    window[method] = assertHidden;
  }
  window.webContents.focus = assertHidden;
  window.webContents.openDevTools = assertHidden;
  window.on("show", () => failOffscreenTest(new Error(`BrowserWindow ${window.id} emitted show`)));
  window.on("focus", () =>
    failOffscreenTest(new Error(`BrowserWindow ${window.id} emitted focus`)),
  );
  window.on("ready-to-show", assertHidden);
  window.webContents.on("did-finish-load", assertHidden);
  process.stderr.write(
    `[desktop-test-offscreen] ${JSON.stringify({ event: "window-created", id: window.id, offscreen: true, visible: false, focused: false })}\n`,
  );
}

export function createDesktopBrowserWindow(
  options: Electron.BrowserWindowConstructorOptions,
): Electron.BrowserWindow {
  const window = new Electron.BrowserWindow(desktopBrowserWindowOptions(options));
  guardDesktopOffscreenWindow(window);
  return window;
}

/** Call before app readiness and before any BrowserWindow can be constructed. */
export function configureDesktopOffscreenTest(): void {
  if (!isDesktopOffscreenTest()) return;
  // Electron's documented software output device for offscreen rendering.
  Electron.app.disableHardwareAcceleration();
  Electron.app.on("browser-window-created", (_event, window) =>
    guardDesktopOffscreenWindow(window),
  );
  // Startup failure UI must not open a native dialog in an unattended test.
  Electron.dialog.showErrorBox = (title, content) => {
    failOffscreenTest(new Error(`${title}: ${content}`));
  };
  for (const method of [
    "showMessageBox",
    "showMessageBoxSync",
    "showOpenDialog",
    "showOpenDialogSync",
    "showSaveDialog",
    "showSaveDialogSync",
  ] as const) {
    Electron.dialog[method] = () =>
      failOffscreenTest(new Error(`Native dialog ${method} is unavailable in offscreen tests`));
  }
  process.on("uncaughtException", failOffscreenTest);
  process.on("unhandledRejection", failOffscreenTest);
}
