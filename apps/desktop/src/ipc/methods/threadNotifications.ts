import * as DateTime from "effect/DateTime";
import {
  DesktopThreadNotificationInputSchema,
  type DesktopThreadNotificationInput,
  type DesktopThreadNotificationTarget,
} from "@specweave-studio/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native notification identifiers must retain their existing platform hash format.
import * as NodeCrypto from "node:crypto";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  CLOSE_THREAD_NOTIFICATION_CHANNEL,
  SHOW_THREAD_NOTIFICATION_CHANNEL,
  THREAD_NOTIFICATION_OPEN_CHANNEL,
  TAKE_THREAD_NOTIFICATION_OPEN_CHANNEL,
} from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** The part of a native notification the center drives. */
export interface NativeThreadNotification {
  readonly show: () => void;
  readonly close: () => void;
  readonly onClick: (listener: () => void) => void;
  readonly onClose: (listener: () => void) => void;
  /** The system posted it. */
  readonly onShow: (listener: () => void) => void;
  /** The system refused it, for example when the app may not notify. */
  readonly onFailed: (listener: (error: string) => void) => void;
}

export interface ThreadNotificationCenterDeps {
  readonly isSupported: () => boolean;
  readonly create: (input: { id: string; title: string; body: string }) => NativeThreadNotification;
  /**
   * Tells a live window, preferring `sender`, the renderer that raised the
   * notification, that a clicked thread is waiting, and brings it forward.
   * `exclude` is a renderer that just went away. Returns the chosen window's
   * renderer id, or null when there is no window.
   */
  readonly deliver: (sender: number, exclude?: number) => number | null;
  /** Opens a window when there is none to take the click, and tells every window it waits. */
  readonly revealFallback: () => void;
  readonly onRefused: (error: string) => void;
  /** How long to wait for the system to answer before counting it as shown. */
  readonly answerTimeoutMs?: number;
  readonly now?: () => number;
}

/** A click nobody took by then is dropped rather than replayed much later. */
const PENDING_OPEN_TTL_MS = 60_000;

/**
 * Native ids stay short and unique per post: a Windows toast tag holds at
 * most 64 characters, and a notification object Electron collects later
 * withdraws its id, which must not be a newer alert's.
 */
const nativeId = (tag: string, sequence: number) =>
  `${NodeCrypto.createHash("sha256").update(tag).digest("hex").slice(0, 32)}-${sequence}`;

/**
 * Native notifications for threads that need the user, kept by tag so a newer
 * alert for the same thread replaces the older one. Each shown notification
 * stays referenced until it is clicked or closed, since a collected
 * notification no longer reports clicks.
 *
 * A click is held here until a renderer takes it, so it survives a reload or
 * a window that is still opening: the chosen window is told to ask for it,
 * and every window asks once its preload loads.
 */
export function makeThreadNotificationCenter(deps: ThreadNotificationCenterDeps) {
  const now = deps.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const shown = new Map<string, NativeThreadNotification>();
  let sequence = 0;
  let pendingOpen: {
    readonly target: DesktopThreadNotificationTarget;
    readonly forId: number | null;
    readonly at: number;
  } | null = null;

  const close = (tag: string) => {
    const notification = shown.get(tag);
    if (!notification) return;
    shown.delete(tag);
    notification.close();
  };

  return {
    /** Resolves false when the system will not show it. */
    show: (sender: number, input: DesktopThreadNotificationInput): Promise<boolean> => {
      if (!deps.isSupported()) return Promise.resolve(false);
      close(input.tag);
      sequence += 1;
      const notification = deps.create({
        id: nativeId(input.tag, sequence),
        title: input.title,
        body: input.body,
      });
      shown.set(input.tag, notification);
      notification.onClose(() => {
        if (shown.get(input.tag) === notification) shown.delete(input.tag);
      });
      notification.onClick(() => {
        if (shown.get(input.tag) === notification) shown.delete(input.tag);
        const forId = deps.deliver(sender);
        pendingOpen = { target: input.target, forId, at: now() };
        if (forId === null) deps.revealFallback();
      });
      return new Promise<boolean>((resolve) => {
        // Some systems never confirm; a notification that did not fail by
        // then is taken as shown.
        // @effect-diagnostics-next-line globalTimers:off -- The native notification callback owns and cancels this timer on show or failure.
        const timer = setTimeout(() => resolve(true), deps.answerTimeoutMs ?? 3_000);
        notification.onShow(() => {
          clearTimeout(timer);
          resolve(true);
        });
        notification.onFailed((error) => {
          clearTimeout(timer);
          if (shown.get(input.tag) === notification) shown.delete(input.tag);
          deps.onRefused(error);
          resolve(false);
        });
        notification.show();
      });
    },
    /** Moves a waiting click off a window that closed or crashed before taking it. */
    windowGone: (id: number) => {
      if (pendingOpen?.forId !== id) return;
      const forId = deps.deliver(-1, id);
      pendingOpen = { ...pendingOpen, forId };
      if (forId === null) deps.revealFallback();
    },
    close,
    closeAll: () => {
      for (const tag of Array.from(shown.keys())) close(tag);
    },
    /**
     * Hands the clicked thread to `sender`, unless it was meant for another
     * window that is still alive.
     */
    takePendingOpen: (
      sender: number,
      isLive: (id: number) => boolean,
    ): DesktopThreadNotificationTarget | null => {
      if (!pendingOpen) return null;
      if (now() - pendingOpen.at > PENDING_OPEN_TTL_MS) {
        pendingOpen = null;
        return null;
      }
      if (pendingOpen.forId !== null && pendingOpen.forId !== sender && isLive(pendingOpen.forId)) {
        return null;
      }
      const { target } = pendingOpen;
      pendingOpen = null;
      return target;
    },
    shownTags: () => [...shown.keys()],
  };
}

export const installThreadNotifications = Effect.fn("desktop.ipc.installThreadNotifications")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);
    const runFork = Effect.runForkWith(context);

    // Windows whose loss moves a waiting click elsewhere.
    const watched = new Set<number>();
    const watch = (contents: Electron.WebContents) => {
      const id = contents.id;
      if (watched.has(id)) return;
      watched.add(id);
      contents.on("render-process-gone", () => center.windowGone(id));
      contents.once("destroyed", () => {
        watched.delete(id);
        center.windowGone(id);
      });
    };
    const pingAll = () => {
      for (const window of runSync(electronWindow.appWindows)) {
        if (!window.isDestroyed()) window.webContents.send(THREAD_NOTIFICATION_OPEN_CHANNEL);
      }
    };

    const center = makeThreadNotificationCenter({
      isSupported: () => Electron.Notification.isSupported(),
      create: ({ id, title, body }) => {
        // Silent: the renderer plays Studio's own sound when one is chosen.
        const notification = new Electron.Notification({ id, title, body, silent: true });
        return {
          show: () => notification.show(),
          close: () => notification.close(),
          onClick: (listener) => notification.on("click", listener),
          onClose: (listener) => notification.on("close", listener),
          onShow: (listener) => notification.on("show", listener),
          onFailed: (listener) => notification.on("failed", (_event, error) => listener(error)),
        };
      },
      deliver: (sender, exclude) => {
        try {
          const windows = runSync(electronWindow.appWindows);
          const main = Option.getOrNull(runSync(electronWindow.main));
          const window = [
            windows.find((candidate) => candidate.webContents.id === sender),
            main ?? undefined,
            ...windows,
          ].find(
            (candidate) =>
              candidate !== undefined &&
              !candidate.isDestroyed() &&
              candidate.webContents.id !== exclude &&
              !candidate.webContents.isCrashed(),
          );
          if (!window) return null;
          watch(window.webContents);
          window.webContents.send(THREAD_NOTIFICATION_OPEN_CHANNEL);
          runFork(electronWindow.reveal(window).pipe(Effect.ignoreCause));
          return window.webContents.id;
        } catch (error) {
          runSync(Effect.logWarning("Could not open the thread from a notification", error));
          return null;
        }
      },
      revealFallback: () => {
        runFork(
          desktopWindow.revealOrCreateMain.pipe(
            // A window that opens asks on load; one already open has to be told.
            Effect.andThen(Effect.sync(pingAll)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not open a window for a notification", cause),
            ),
          ),
        );
      },
      // macOS answers "Notifications are not allowed for this application"
      // when the app's signature does not match its bundle or the user
      // turned Studio's notifications off.
      onRefused: (error) => {
        runSync(Effect.logWarning("The system did not show a thread notification", { error }));
      },
    });

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SHOW_THREAD_NOTIFICATION_CHANNEL,
        payload: DesktopThreadNotificationInputSchema,
        result: Schema.Boolean,
        handler: (input, event) =>
          Effect.promise(() =>
            center.show(event?.sender.id ?? -1, input).catch((error: unknown) => {
              runSync(Effect.logWarning("Could not show a thread notification", error));
              return false;
            }),
          ),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: CLOSE_THREAD_NOTIFICATION_CHANNEL,
        payload: Schema.String,
        result: Schema.Void,
        handler: (tag) => Effect.sync(() => center.close(tag)),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: TAKE_THREAD_NOTIFICATION_OPEN_CHANNEL,
        payload: Schema.Void,
        result: Schema.NullOr(
          Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
        ),
        handler: (_input, event) =>
          Effect.sync(() =>
            center.takePendingOpen(event?.sender.id ?? -1, (id) => {
              const contents = Electron.webContents.fromId(id);
              return contents !== undefined && !contents.isDestroyed() && !contents.isCrashed();
            }),
          ),
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(center.closeAll));
  },
);
