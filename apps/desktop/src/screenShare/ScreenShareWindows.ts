/**
 * The two windows the viewed machine shows for screen sharing (1490): the
 * prompt and the banner. Both belong to the main process: frameless, always
 * on top, on every desktop, with one small preload and no bridge to anything
 * else. An answer counts only when it comes from that window's own frame.
 *
 * A click here is not approval by itself: `ScreenShareSessions` asks the
 * system to authenticate a person before anything is allowed.
 */
import * as Electron from "electron";

import { createDesktopBrowserWindow } from "../electron/DesktopOffscreen.ts";
import { SCREEN_SHARE_WINDOW_CHANNEL } from "../ipc/channels.ts";
import type { ScreenShareBannerView, ScreenSharePromptView } from "./screenShareSession.logic.ts";
import {
  bannerHtml,
  bannerPosition,
  parseWindowAction,
  promptHtml,
  SCREEN_SHARE_BANNER_SIZE,
  SCREEN_SHARE_PROMPT_SIZE,
} from "./screenShareWindows.logic.ts";

export interface ScreenShareWindowHandlers {
  readonly answer: (sid: string, answer: "deny" | "once" | "always") => void;
  readonly stop: () => void;
  /** A banner went away without this code closing it. */
  readonly bannerLost: () => void;
}

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const overEverything = (window: Electron.BrowserWindow) => {
  window.setAlwaysOnTop(true, "screen-saver");
  // Every desktop and over full-screen apps, without turning the app into an accessory.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
};

export class ScreenShareWindows {
  private prompt: Electron.BrowserWindow | undefined;
  private banners: Array<Electron.BrowserWindow> = [];
  private readonly onMessage: (event: Electron.IpcMainEvent, message: unknown) => void;
  private readonly preload: string;
  private readonly handlers: ScreenShareWindowHandlers;

  constructor(preload: string, handlers: ScreenShareWindowHandlers) {
    this.preload = preload;
    this.handlers = handlers;
    this.onMessage = (event, message) => {
      const action = parseWindowAction(message);
      if (action === null) return;
      const from = (window: Electron.BrowserWindow | undefined) =>
        window !== undefined &&
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame;
      if (action.window === "prompt") {
        if (from(this.prompt)) this.handlers.answer(action.sid, action.answer);
      } else if (this.banners.some(from)) {
        this.handlers.stop();
      }
    };
    Electron.ipcMain.on(SCREEN_SHARE_WINDOW_CHANNEL, this.onMessage);
  }

  private webPreferences(): Electron.WebPreferences {
    return { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false };
  }

  showPrompt(view: ScreenSharePromptView): void {
    let window = this.prompt;
    if (window === undefined || window.isDestroyed()) {
      const area = Electron.screen.getPrimaryDisplay().workArea;
      window = createDesktopBrowserWindow({
        ...SCREEN_SHARE_PROMPT_SIZE,
        x: Math.round(area.x + (area.width - SCREEN_SHARE_PROMPT_SIZE.width) / 2),
        y: Math.round(area.y + area.height / 5),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        title: "Screen sharing request",
        webPreferences: this.webPreferences(),
      });
      overEverything(window);
      // The code on it is for eyes at this machine: keep it out of screenshots and recordings.
      window.setContentProtection(true);
      const created = window;
      window.once("closed", () => {
        if (this.prompt === created) this.prompt = undefined;
      });
      this.prompt = window;
    }
    const shown = window;
    void shown.loadURL(dataUrl(promptHtml(view))).then(
      () => {
        if (!shown.isDestroyed() && this.prompt === shown) shown.showInactive();
      },
      () => undefined,
    );
  }

  hidePrompt(): void {
    const window = this.prompt;
    this.prompt = undefined;
    if (window !== undefined && !window.isDestroyed()) window.destroy();
  }

  /** One banner per display. False when none could be put up. */
  showBanner(view: ScreenShareBannerView): boolean {
    this.hideBanner();
    const html = dataUrl(bannerHtml(view));
    try {
      for (const display of Electron.screen.getAllDisplays()) {
        const window = createDesktopBrowserWindow({
          ...SCREEN_SHARE_BANNER_SIZE,
          ...bannerPosition(display.workArea, SCREEN_SHARE_BANNER_SIZE),
          show: false,
          frame: false,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          closable: false,
          focusable: false,
          skipTaskbar: true,
          title: "Screen sharing",
          webPreferences: this.webPreferences(),
        });
        overEverything(window);
        this.banners.push(window);
        const lost = () => {
          if (this.banners.includes(window)) this.handlers.bannerLost();
        };
        window.once("closed", lost);
        window.on("hide", lost);
        window.webContents.once("render-process-gone", lost);
        void window.loadURL(html).catch(lost);
        window.showInactive();
      }
    } catch {
      this.hideBanner();
      return false;
    }
    return this.banners.length > 0 && this.banners.every((window) => window.isVisible());
  }

  hideBanner(): void {
    const windows = this.banners;
    // Emptied first, so their closing is not taken for a lost banner.
    this.banners = [];
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
  }

  dispose(): void {
    Electron.ipcMain.removeListener(SCREEN_SHARE_WINDOW_CHANNEL, this.onMessage);
    this.hidePrompt();
    this.hideBanner();
  }
}
