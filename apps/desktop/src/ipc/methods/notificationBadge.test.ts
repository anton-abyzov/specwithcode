import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

const native = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getFocusedWindow: vi.fn(() => null as object | null),
  image: { isEmpty: vi.fn(() => false) },
  createFromDataURL: vi.fn(),
  webContents: { send: vi.fn() },
  listeners: new Map<string, () => void>(),
  fromId: vi.fn(),
  destroyListeners: new Map<number, () => void>(),
}));
vi.mock("electron", () => ({
  app: {
    setBadgeCount: native.setBadgeCount,
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
  nativeImage: { createFromDataURL: native.createFromDataURL },
  webContents: { fromId: native.fromId },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  applyNotificationBadge,
  installNotificationBadge,
  makeNotificationBadgeController,
  resolveNotificationOwner,
} from "./notificationBadge.ts";

const badge = { count: 2, image: "data:image/png;base64,aGVsbG8=" };
const noBadge = { count: 0, image: null };

interface FakeAppWindow {
  readonly webContents: {
    readonly id: number;
    readonly send: ReturnType<typeof vi.fn>;
    readonly on: (event: string, listener: () => void) => void;
  };
  readonly isDestroyed: () => boolean;
  readonly once: (event: string, listener: () => void) => void;
  readonly close: () => void;
  /** The page reloads (did-navigate) or its process dies (render-process-gone). */
  readonly restartPage: (event: "did-navigate" | "render-process-gone") => void;
}

const appWindow = (id: number): FakeAppWindow => {
  const listeners = new Map<string, () => void>();
  const pageListeners = new Map<string, () => void>();
  return {
    webContents: {
      id,
      send: vi.fn(),
      on: (event, listener) => {
        pageListeners.set(event, listener);
      },
    },
    isDestroyed: () => false,
    once: (event, listener) => {
      listeners.set(event, listener);
    },
    close: () => listeners.get("closed")?.(),
    restartPage: (event) => pageListeners.get(event)?.(),
  };
};

// The app windows the install sees; tests swap them as windows open and close.
const appWindows = {
  main: null as FakeAppWindow | null,
  all: [] as FakeAppWindow[],
};
const layerAppWindows = Layer.succeed(ElectronWindow.ElectronWindow, {
  main: Effect.sync(() => Option.fromNullishOr(appWindows.main)),
  appWindows: Effect.sync(() => appWindows.all),
} as unknown as ElectronWindow.ElectronWindow["Service"]);

// Installs the badge with the registered methods captured as they are, so a
// test can call them with or without a sending window.
const withInstalledBadge = <A, E>(
  body: (methods: {
    readonly setBadge: (
      report: typeof badge | typeof noBadge,
      sender?: number,
    ) => Effect.Effect<unknown, Schema.SchemaError>;
    readonly isOwner: (sender?: number) => Effect.Effect<unknown, Schema.SchemaError>;
  }) => Effect.Effect<A, E>,
) => {
  const invoke = new Map<string, DesktopIpc.DesktopIpcMethod<Schema.SchemaError, never>>();
  const sync = new Map<string, DesktopIpc.DesktopSyncIpcMethod<Schema.SchemaError, never>>();
  const event = (sender?: number) =>
    sender === undefined ? undefined : { sender: { id: sender } };
  return Effect.scoped(
    Effect.gen(function* () {
      yield* installNotificationBadge();
      return yield* body({
        setBadge: (report, sender) =>
          invoke.get("desktop:set-notification-badge")!.handler(report, event(sender)),
        isOwner: (sender) => sync.get("desktop:get-notification-owner")!.handler(event(sender)),
      });
    }),
  ).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provide([
      ElectronApp.layer,
      layerAppWindows,
      Layer.succeed(
        DesktopIpc.DesktopIpc,
        DesktopIpc.DesktopIpc.of({
          handle: (method) =>
            Effect.sync(() => {
              invoke.set(method.channel, method as never);
            }),
          handleSync: (method) =>
            Effect.sync(() => {
              sync.set(method.channel, method as never);
            }),
        }),
      ),
    ]),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromDataURL.mockReturnValue(native.image);
  native.setBadgeCount.mockImplementation(() => true);
  native.listeners.clear();
  native.destroyListeners.clear();
  native.fromId.mockImplementation((id: number) => ({
    once: (_event: string, listener: () => void) => native.destroyListeners.set(id, listener),
  }));
  appWindows.main = null;
  appWindows.all = [];
});

it.each(["darwin", "linux"] as const)("sets and clears the native %s count", (platform) => {
  applyNotificationBadge(platform, badge);
  applyNotificationBadge(platform, { count: 0, image: null });
  expect(native.setBadgeCount.mock.calls).toEqual([[2], [0]]);
  expect(native.createFromDataURL).not.toHaveBeenCalled();
});

it("sets and clears the Windows taskbar overlay", () => {
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
    native.image,
    "2 threads with new notifications",
  );
  applyNotificationBadge("win32", { count: 0, image: null });
  expect(native.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
});

it.each(["win32", "darwin", "linux"] as const)(
  "rejects a late positive count while %s is focused",
  (platform) => {
    native.getFocusedWindow.mockReturnValue({});
    applyNotificationBadge(platform, badge);
    if (platform === "win32") expect(native.setOverlayIcon).toHaveBeenCalledWith(null, "");
    else expect(native.setBadgeCount).toHaveBeenCalledWith(0);
    expect(native.createFromDataURL).not.toHaveBeenCalled();
  },
);

it("ignores destroyed windows and clears invalid images", () => {
  native.isDestroyed.mockReturnValue(true);
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon).not.toHaveBeenCalled();
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(true);
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon.mock.calls[0]?.[0]).toBeNull();
});

it("keeps notifications working when the native badge API fails", () => {
  native.setBadgeCount.mockImplementation(() => {
    throw new Error("Unavailable");
  });
  expect(() => applyNotificationBadge("linux", badge)).not.toThrow();
});

it.effect("validates IPC and clears on native focus, quit, and disposal", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installNotificationBadge();
        const handler = handlers.get("desktop:set-notification-badge")!;
        const event = { sender: { id: 1 } };
        for (const invalid of [
          { ...badge, count: -1 },
          { ...badge, count: 0.5 },
          { ...badge, count: Infinity },
          { ...badge, image: "https://example.com/icon.png" },
          { ...badge, image: `data:image/png;base64,${"a".repeat(16_384)}` },
        ]) {
          yield* Effect.promise(() => expect(handler(event, invalid)).rejects.toBeDefined());
        }
        expect(native.setBadgeCount).not.toHaveBeenCalled();
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
        native.listeners.get("browser-window-focus")!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.webContents.send).toHaveBeenCalledWith("desktop:set-notification-badge");
        native.getFocusedWindow.mockReturnValue({});
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.webContents.send).toHaveBeenCalledTimes(2);
        yield* Effect.promise(() => Promise.resolve(handler(event, { count: 0, image: null })));
        expect(native.webContents.send).toHaveBeenCalledTimes(2);
        native.getFocusedWindow.mockReturnValue(null);
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        native.listeners.get("before-quit")!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
      }),
    ).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide([
        ElectronApp.layer,
        layerAppWindows,
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);

describe("badge from several windows", () => {
  it("shows the highest report instead of the sum", () => {
    const apply = vi.fn();
    const controller = makeNotificationBadgeController(apply);
    controller.set(1, badge);
    controller.set(2, noBadge);
    expect(apply).toHaveBeenLastCalledWith(badge);
    controller.set(2, { count: 5, image: null });
    expect(apply).toHaveBeenLastCalledWith({ count: 5, image: null });
    controller.release(2);
    expect(apply).toHaveBeenLastCalledWith(badge);
    controller.release(2);
    expect(apply).toHaveBeenCalledTimes(4);
    controller.set(3, { count: 1, image: null });
    controller.clear();
    expect(apply).toHaveBeenLastCalledWith(noBadge);
    expect(controller.current()).toEqual(noBadge);
  });

  it.effect("keeps one window's count when another reports none", () =>
    withInstalledBadge(({ setBadge }) =>
      Effect.gen(function* () {
        yield* setBadge(badge, 1);
        yield* setBadge(noBadge, 2);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
        yield* setBadge({ count: 1, image: null }, 2);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
        yield* setBadge(badge, 1);
        expect(native.fromId.mock.calls).toEqual([[1], [2]]);
      }),
    ),
  );

  it.effect("drops a window's count when it closes or crashes", () =>
    withInstalledBadge(({ setBadge }) =>
      Effect.gen(function* () {
        yield* setBadge(badge, 1);
        yield* setBadge({ count: 1, image: null }, 2);
        native.destroyListeners.get(1)!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(1);
        native.destroyListeners.get(2)!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        // A window that is already gone cannot leave a count behind.
        native.fromId.mockReturnValue(undefined);
        yield* setBadge(badge, 3);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
      }),
    ),
  );

  it.effect("forgets every window's count once a window is focused", () =>
    withInstalledBadge(({ setBadge }) =>
      Effect.gen(function* () {
        yield* setBadge(badge, 1);
        yield* setBadge({ count: 1, image: null }, 2);
        native.listeners.get("browser-window-focus")!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.webContents.send).toHaveBeenCalledWith("desktop:set-notification-badge");
        yield* setBadge({ count: 1, image: null }, 2);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(1);
        native.getFocusedWindow.mockReturnValue({});
        yield* setBadge(badge, 1);
        native.getFocusedWindow.mockReturnValue(null);
        yield* setBadge(noBadge, 1);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
      }),
    ),
  );

  it.effect("counts a report without a sending window as one window", () =>
    withInstalledBadge(({ setBadge }) =>
      Effect.gen(function* () {
        yield* setBadge(badge);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
        yield* setBadge({ count: 1, image: null });
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(1);
        yield* setBadge(noBadge);
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.fromId).not.toHaveBeenCalled();
      }),
    ),
  );
});

describe("alert owner", () => {
  it("is the focused app window", () => {
    expect(resolveNotificationOwner(20, 10, [10, 20])).toBe(20);
  });

  it("is the main window when no app window is focused", () => {
    expect(resolveNotificationOwner(null, 10, [10, 20])).toBe(10);
    // A focused helper window is not an app window.
    expect(resolveNotificationOwner(99, 10, [10, 20])).toBe(10);
  });

  it("is the oldest project window when the main window is closed", () => {
    expect(resolveNotificationOwner(null, null, [20, 30])).toBe(20);
    expect(resolveNotificationOwner(null, 10, [20, 30])).toBe(20);
  });

  it("is nobody when no app window is open", () => {
    expect(resolveNotificationOwner(null, null, [])).toBeNull();
  });

  it.effect("answers each window for itself", () =>
    withInstalledBadge(({ isOwner }) =>
      Effect.gen(function* () {
        const main = appWindow(10);
        const project = appWindow(20);
        appWindows.main = main;
        appWindows.all = [main, project];
        expect(yield* isOwner(10)).toBe(true);
        expect(yield* isOwner(20)).toBe(false);
        native.getFocusedWindow.mockReturnValue(project);
        expect(yield* isOwner(20)).toBe(true);
        expect(yield* isOwner(10)).toBe(false);
        // Not one of the app windows, so nothing changes for it.
        expect(yield* isOwner(99)).toBe(true);
        expect(yield* isOwner()).toBe(true);
        appWindows.main = null;
        appWindows.all = [project];
        native.getFocusedWindow.mockReturnValue(null);
        expect(yield* isOwner(20)).toBe(true);
      }),
    ),
  );

  it.effect("tells only the windows whose answer changed", () =>
    withInstalledBadge(({ isOwner }) =>
      Effect.gen(function* () {
        const main = appWindow(10);
        const project = appWindow(20);
        appWindows.main = main;
        appWindows.all = [main, project];
        expect(yield* isOwner(10)).toBe(true);
        expect(yield* isOwner(20)).toBe(false);
        // The reply carries the answer, so the asking window gets no push, and
        // a window that has not asked yet has nobody listening for one.
        expect(main.webContents.send).not.toHaveBeenCalled();
        expect(project.webContents.send).not.toHaveBeenCalled();

        native.getFocusedWindow.mockReturnValue(project);
        native.listeners.get("browser-window-focus")!();
        native.listeners.get("browser-window-focus")!();
        expect(main.webContents.send.mock.calls).toEqual([["desktop:notification-owner", false]]);
        expect(project.webContents.send.mock.calls).toEqual([["desktop:notification-owner", true]]);

        native.getFocusedWindow.mockReturnValue(null);
        native.listeners.get("browser-window-blur")!();
        native.listeners.get("browser-window-blur")!();
        expect(main.webContents.send).toHaveBeenLastCalledWith("desktop:notification-owner", true);
        expect(project.webContents.send).toHaveBeenLastCalledWith(
          "desktop:notification-owner",
          false,
        );
        expect(main.webContents.send).toHaveBeenCalledTimes(2);
        expect(project.webContents.send).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect.each(["did-navigate", "render-process-gone"] as const)(
    "starts a window over when its page restarts (%s)",
    (event) =>
      withInstalledBadge(({ isOwner }) =>
        Effect.gen(function* () {
          const main = appWindow(10);
          const project = appWindow(20);
          appWindows.main = main;
          appWindows.all = [main, project];
          expect(yield* isOwner(10)).toBe(true);
          native.getFocusedWindow.mockReturnValue(project);
          expect(yield* isOwner(20)).toBe(true);
          expect(main.webContents.send.mock.calls).toEqual([["desktop:notification-owner", false]]);

          // The focused window reloads: until its new page asks, the main
          // window alerts again and the reloading page is sent nothing.
          project.restartPage(event);
          expect(main.webContents.send).toHaveBeenLastCalledWith(
            "desktop:notification-owner",
            true,
          );
          native.listeners.get("browser-window-blur")!();
          native.listeners.get("browser-window-focus")!();
          expect(project.webContents.send).not.toHaveBeenCalled();
          expect(main.webContents.send).toHaveBeenCalledTimes(2);

          expect(yield* isOwner(20)).toBe(true);
          expect(main.webContents.send).toHaveBeenLastCalledWith(
            "desktop:notification-owner",
            false,
          );
        }),
      ),
  );

  it.effect("leaves alerts with a ready window while a new one is loading", () =>
    withInstalledBadge(({ isOwner }) =>
      Effect.gen(function* () {
        const main = appWindow(10);
        appWindows.main = main;
        appWindows.all = [main];
        expect(yield* isOwner(10)).toBe(true);

        // The project window is focused as it opens, before its page has asked.
        const project = appWindow(20);
        appWindows.all = [main, project];
        native.getFocusedWindow.mockReturnValue(project);
        native.listeners.get("browser-window-focus")!();
        expect(main.webContents.send).not.toHaveBeenCalled();
        expect(project.webContents.send).not.toHaveBeenCalled();

        expect(yield* isOwner(20)).toBe(true);
        expect(main.webContents.send.mock.calls).toEqual([["desktop:notification-owner", false]]);

        // Once it closes, a window reusing its id is loading again.
        appWindows.all = [main];
        project.close();
        expect(main.webContents.send).toHaveBeenLastCalledWith("desktop:notification-owner", true);
        const reopened = appWindow(20);
        appWindows.all = [main, reopened];
        native.getFocusedWindow.mockReturnValue(reopened);
        native.listeners.get("browser-window-focus")!();
        expect(main.webContents.send).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect("hands alerts over when the owning window closes", () =>
    withInstalledBadge(({ isOwner }) =>
      Effect.gen(function* () {
        const first = appWindow(20);
        const second = appWindow(30);
        appWindows.all = [first, second];
        expect(yield* isOwner(20)).toBe(true);
        expect(yield* isOwner(30)).toBe(false);
        expect(first.webContents.send).not.toHaveBeenCalled();
        expect(second.webContents.send).not.toHaveBeenCalled();

        appWindows.all = [second];
        first.close();
        expect(second.webContents.send.mock.calls).toEqual([["desktop:notification-owner", true]]);
        expect(first.webContents.send).not.toHaveBeenCalled();

        // A later window that reuses the closed one's id starts from scratch.
        const reopened = appWindow(20);
        appWindows.all = [second, reopened];
        native.listeners.get("browser-window-blur")!();
        expect(reopened.webContents.send).not.toHaveBeenCalled();
        expect(yield* isOwner(20)).toBe(false);
        expect(second.webContents.send).toHaveBeenCalledTimes(1);
        appWindows.all = [second];
        reopened.close();
        expect(second.webContents.send).toHaveBeenCalledTimes(1);
      }),
    ),
  );
});
