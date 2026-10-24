import { EventEmitter } from "node:events";
import type * as Electron from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { browserWindow, app, dialog } = vi.hoisted(() => ({
  browserWindow: vi.fn(function BrowserWindow() {}),
  app: { on: vi.fn(), exit: vi.fn(), disableHardwareAcceleration: vi.fn() },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
    showOpenDialog: vi.fn(),
    showOpenDialogSync: vi.fn(),
    showSaveDialog: vi.fn(),
    showSaveDialogSync: vi.fn(),
  },
}));

vi.mock("electron", () => ({ BrowserWindow: browserWindow, app, dialog }));

import {
  assertDesktopOffscreenWindow,
  configureDesktopOffscreenTest,
  createDesktopBrowserWindow,
  desktopBrowserWindowOptions,
  guardDesktopOffscreenWindow,
} from "./DesktopOffscreen.ts";

function fakeWindow() {
  const state = { visible: false, focused: false, offscreen: true, destroyed: false };
  const window = Object.assign(new EventEmitter(), {
    id: 17,
    isDestroyed: vi.fn(() => state.destroyed),
    isVisible: vi.fn(() => state.visible),
    isFocused: vi.fn(() => state.focused),
    show: vi.fn(() => {
      state.visible = true;
    }),
    showInactive: vi.fn(() => {
      state.visible = true;
    }),
    focus: vi.fn(() => {
      state.focused = true;
    }),
    restore: vi.fn(),
    maximize: vi.fn(),
    moveTop: vi.fn(),
    setFullScreen: vi.fn(),
    setKiosk: vi.fn(),
    setFocusable: vi.fn(),
    webContents: Object.assign(new EventEmitter(), {
      isOffscreen: vi.fn(() => state.offscreen),
      focus: vi.fn(),
      openDevTools: vi.fn(),
    }),
  });
  return { state, window: window as unknown as Electron.BrowserWindow };
}

describe("explicit desktop offscreen test mode", () => {
  beforeEach(() => {
    vi.stubEnv("STUDIO_DESKTOP_TEST_OFFSCREEN", "1");
    vi.clearAllMocks();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "0", "true"])("keeps normal behavior for %s", (value) => {
    vi.stubEnv("STUDIO_DESKTOP_TEST_OFFSCREEN", value);
    const options = { show: true, webPreferences: { preload: "/real/preload.cjs" } };
    const { window } = fakeWindow();
    const show = window.show;
    browserWindow.mockImplementation(function () {
      return window;
    });
    expect(desktopBrowserWindowOptions(options)).toBe(options);
    expect(createDesktopBrowserWindow(options)).toBe(window);
    expect(browserWindow).toHaveBeenCalledWith(options);
    expect(window.show).toBe(show);
    configureDesktopOffscreenTest();
    expect(app.on).not.toHaveBeenCalled();
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
  });

  it("forces offscreen, non-presenting options while preserving the actual renderer setup", () => {
    const options = {
      show: true,
      fullscreen: true,
      kiosk: true,
      webPreferences: {
        offscreen: false,
        devTools: true,
        preload: "/real/preload.cjs",
        sandbox: true,
        contextIsolation: true,
        partition: "persist:real-preview",
      },
    };
    const { window } = fakeWindow();
    browserWindow.mockImplementation(function () {
      return window;
    });
    expect(createDesktopBrowserWindow(options)).toBe(window);
    expect(browserWindow).toHaveBeenCalledWith({
      ...options,
      show: false,
      fullscreen: false,
      kiosk: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        ...options.webPreferences,
        offscreen: true,
        devTools: false,
        disableDialogs: true,
        backgroundThrottling: false,
      },
    });
    expect(options.show).toBe(true);
    expect(options.webPreferences.offscreen).toBe(false);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('"event":"window-created"'),
    );
  });

  it("keeps windows invisible through splash, ready, activation, restore and focus calls", () => {
    const { window } = fakeWindow();
    const realGetters = [window.isVisible, window.isFocused, window.webContents.isOffscreen];
    const presentation = [
      window.show,
      window.showInactive,
      window.focus,
      window.restore,
      window.maximize,
      window.moveTop,
      window.webContents.focus,
      window.webContents.openDevTools,
    ];
    guardDesktopOffscreenWindow(window);
    window.once("ready-to-show", () => {
      window.maximize();
      window.show();
      window.focus();
    });
    window.emit("ready-to-show");
    window.webContents.emit("did-finish-load");
    window.showInactive();
    window.restore();
    window.moveTop();
    window.setFullScreen(true);
    window.setKiosk(true);
    window.setFocusable(true);
    window.webContents.focus();
    window.webContents.openDevTools({ mode: "detach" });
    for (const method of presentation) expect(method).not.toHaveBeenCalled();
    expect([window.isVisible, window.isFocused, window.webContents.isOffscreen]).toEqual(
      realGetters,
    );
    expect(window.isVisible()).toBe(false);
    expect(window.isFocused()).toBe(false);
    expect(window.webContents.isOffscreen()).toBe(true);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it.each(["offscreen", "visible", "focused"] as const)(
    "fails on real %s state violations",
    (key) => {
      const { state, window } = fakeWindow();
      guardDesktopOffscreenWindow(window);
      state[key] = key !== "offscreen";
      expect(() => assertDesktopOffscreenWindow(window)).toThrow(
        "BrowserWindow invariant violated",
      );
      expect(app.exit).toHaveBeenCalledWith(1);
    },
  );

  it.each(["show", "focus"])("fails if a native %s event bypasses the guards", (event) => {
    const { window } = fakeWindow();
    guardDesktopOffscreenWindow(window);
    expect(() => window.emit(event)).toThrow(`BrowserWindow 17 emitted ${event}`);
    expect(app.exit).toHaveBeenCalledWith(1);
  });

  it("asserts new windows before best-effort callers can swallow failures", () => {
    const { state, window } = fakeWindow();
    state.offscreen = false;
    browserWindow.mockImplementation(function () {
      return window;
    });
    expect(() => createDesktopBrowserWindow({})).toThrow("BrowserWindow invariant violated");
    expect(app.exit).toHaveBeenCalledWith(1);
  });

  it("installs software rendering and guards Electron-created popup windows before readiness", () => {
    vi.spyOn(process, "on").mockReturnValue(process);
    const originalDialogs = { ...dialog };
    const errorBox = dialog.showErrorBox;
    try {
      configureDesktopOffscreenTest();
      expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce();
      const created = app.on.mock.calls.find(([event]) => event === "browser-window-created")![1];
      const { window } = fakeWindow();
      created({}, window);
      window.show();
      expect(window.isVisible()).toBe(false);
      expect(() => dialog.showErrorBox("Startup failed", "real backend error")).toThrow(
        "Startup failed: real backend error",
      );
      for (const method of [
        "showMessageBox",
        "showMessageBoxSync",
        "showOpenDialog",
        "showOpenDialogSync",
        "showSaveDialog",
        "showSaveDialogSync",
      ] as const) {
        expect(() => dialog[method]()).toThrow(
          `Native dialog ${method} is unavailable in offscreen tests`,
        );
        expect(originalDialogs[method]).not.toHaveBeenCalled();
      }
      expect(errorBox).not.toHaveBeenCalled();
      expect(app.exit).toHaveBeenCalledWith(1);
    } finally {
      Object.assign(dialog, originalDialogs);
    }
  });
});
