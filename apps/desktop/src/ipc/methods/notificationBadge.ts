import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  GET_NOTIFICATION_OWNER_CHANNEL,
  NOTIFICATION_OWNER_CHANNEL,
  SET_NOTIFICATION_BADGE_CHANNEL,
} from "../channels.ts";

const NotificationBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })),
  image: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
    ),
  ),
});

export type NotificationBadgeReport = typeof NotificationBadge.Type;

const NO_BADGE: NotificationBadgeReport = { count: 0, image: null };

// Renderer ids start at 1, so this never collides with a real window's report.
const ANONYMOUS_SENDER = -1;

export function applyNotificationBadge(
  platform: NodeJS.Platform,
  { count, image }: NotificationBadgeReport,
): void {
  try {
    if (Electron.BrowserWindow.getFocusedWindow()) count = 0;
    if (platform === "win32") {
      const overlay = count > 0 && image ? Electron.nativeImage.createFromDataURL(image) : null;
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.setOverlayIcon(
            overlay?.isEmpty() ? null : overlay,
            count > 0 ? `${count} threads with new notifications` : "",
          );
        }
      }
    } else if (platform === "darwin" || platform === "linux") {
      Electron.app.setBadgeCount(count);
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update notification badge", error));
  }
}

/**
 * One badge for the whole app, fed by every window. Windows watch the same
 * threads, so the highest report is shown rather than the sum, which would
 * count a thread once per open window. A window that closes or crashes stops
 * counting, so its last report never outlives it.
 */
export function makeNotificationBadgeController(apply: (badge: NotificationBadgeReport) => void) {
  const reports = new Map<number, NotificationBadgeReport>();
  const current = (): NotificationBadgeReport => {
    let highest = NO_BADGE;
    for (const report of reports.values()) {
      if (report.count > highest.count) highest = report;
    }
    return highest;
  };
  const sync = () => apply(current());
  return {
    set: (sender: number, badge: NotificationBadgeReport) => {
      if (badge.count > 0) reports.set(sender, badge);
      else reports.delete(sender);
      sync();
    },
    release: (sender: number) => {
      if (reports.delete(sender)) sync();
    },
    clear: () => {
      reports.clear();
      sync();
    },
    current,
  };
}

/**
 * Which app window may raise thread alerts when several are open, so one
 * thread never alerts once per window. Windows are identified by the id of
 * their renderer. The window the user is in wins; with none focused the main
 * window answers, and with no main window the oldest project window does.
 */
export function resolveNotificationOwner(
  focusedAppWindow: number | null,
  mainWindow: number | null,
  appWindows: ReadonlyArray<number>,
): number | null {
  if (focusedAppWindow !== null && appWindows.includes(focusedAppWindow)) return focusedAppWindow;
  if (mainWindow !== null && appWindows.includes(mainWindow)) return mainWindow;
  return appWindows[0] ?? null;
}

export const installNotificationBadge = Effect.fn("desktop.ipc.installNotificationBadge")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const platform = yield* HostProcessPlatform;
    const runSync = Effect.runSyncWith(yield* Effect.context<never>());
    const controller = makeNotificationBadgeController((badge) =>
      applyNotificationBadge(platform, badge),
    );
    const clear = () => {
      controller.clear();
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SET_NOTIFICATION_BADGE_CHANNEL);
      }
    };
    const badgeSenders = new Set<number>();
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_NOTIFICATION_BADGE_CHANNEL,
        payload: NotificationBadge,
        result: Schema.Void,
        handler: (badge, event) =>
          Effect.sync(() => {
            if (badge.count > 0 && Electron.BrowserWindow.getFocusedWindow()) {
              clear();
              return;
            }
            if (event === undefined) {
              controller.set(ANONYMOUS_SENDER, badge);
              return;
            }
            const senderId = event.sender.id;
            if (!badgeSenders.has(senderId)) {
              const contents = Electron.webContents.fromId(senderId);
              if (contents === undefined) return;
              badgeSenders.add(senderId);
              contents.once("destroyed", () => {
                badgeSenders.delete(senderId);
                controller.release(senderId);
              });
            }
            controller.set(senderId, badge);
          }),
      }),
    );

    // The last answer each renderer was given, so a focus change only reaches
    // the windows whose answer actually changed.
    const ownerAnswers = new Map<number, boolean>();
    const ownerWindows = new Set<number>();
    // Renderers that have asked since their page loaded. A window that is
    // still loading cannot alert, so it does not take ownership away from one
    // that can, and it has nobody listening for a pushed answer yet.
    const readyWindows = new Set<number>();
    // Works out every app window's answer, pushes the ones that changed and
    // returns the answer for the renderer that is asking right now (its reply
    // carries the answer, so it gets no push).
    const refreshOwner = (asking: number | null): boolean => {
      let answer = true;
      try {
        const windows = runSync(electronWindow.appWindows).map((window) => ({
          window,
          id: window.webContents.id,
        }));
        const ids = windows.map(({ id }) => id);
        if (asking !== null && ids.includes(asking)) readyWindows.add(asking);
        const ready = ids.filter((id) => readyWindows.has(id));
        const main = Option.getOrNull(runSync(electronWindow.main));
        const focused = Electron.BrowserWindow.getFocusedWindow();
        const owner = resolveNotificationOwner(
          windows.find(({ window }) => window === focused)?.id ?? null,
          main === null ? null : main.webContents.id,
          ready.length > 0 ? ready : ids,
        );
        for (const id of ownerAnswers.keys()) {
          if (!ids.includes(id)) ownerAnswers.delete(id);
        }
        for (const { window, id } of windows) {
          if (!ownerWindows.has(id)) {
            ownerWindows.add(id);
            // A closed window may have been the owner; someone else takes over.
            window.once("closed", () => {
              ownerWindows.delete(id);
              readyWindows.delete(id);
              refreshOwner(null);
            });
            // A reloaded or crashed page starts over and asks again. Route
            // changes inside the app are same-document and do not count.
            const startOver = () => {
              if (!readyWindows.delete(id)) return;
              ownerAnswers.delete(id);
              refreshOwner(null);
            };
            window.webContents.on("did-navigate", startOver);
            window.webContents.on("render-process-gone", startOver);
          }
          const isOwner = windows.length < 2 || id === owner;
          if (id === asking) {
            answer = isOwner;
            ownerAnswers.set(id, isOwner);
          } else if (readyWindows.has(id) && ownerAnswers.get(id) !== isOwner) {
            ownerAnswers.set(id, isOwner);
            window.webContents.send(NOTIFICATION_OWNER_CHANNEL, isOwner);
          }
        }
      } catch (error) {
        runSync(Effect.logWarning("Could not update the notification owner", error));
      }
      return answer;
    };
    yield* ipc.handleSync(
      DesktopIpc.makeSyncIpcMethod({
        channel: GET_NOTIFICATION_OWNER_CHANNEL,
        result: Schema.Boolean,
        // Anything that is not one of several app windows keeps alerting as
        // it always has.
        handler: (event) => Effect.sync(() => refreshOwner(event?.sender.id ?? null)),
      }),
    );

    yield* app.on("browser-window-focus", () => {
      clear();
      refreshOwner(null);
    });
    yield* app.on("browser-window-blur", () => {
      refreshOwner(null);
    });
    yield* app.on("before-quit", clear);
    yield* Effect.addFinalizer(() => Effect.sync(clear));
  },
);
