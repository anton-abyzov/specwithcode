import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

const trustEverySender: DesktopIpc.DesktopIpcSenderGuard = () => Effect.succeed(true);

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustEverySender);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
        trustEverySender,
      );
      const sender = { sender: { id: 7 } };
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );

  it.effect("forwards the sync sender to the method and answers through returnValue", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          on: (_channel, registered) => {
            listener = registered;
          },
        }),
        trustEverySender,
      );
      const received: Array<DesktopIpc.DesktopIpcInvokeEvent | undefined> = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleSync({
            channel: "desktop.test.sync-sender",
            handler: (event) =>
              Effect.sync(() => {
                received.push(event);
                return event?.sender.id ?? null;
              }),
          });
          const withSender: DesktopIpc.DesktopIpcSyncEvent = {
            returnValue: undefined,
            sender: { id: 7 },
          };
          listener!(withSender);
          assert.strictEqual(withSender.returnValue, 7);

          const withoutSender: DesktopIpc.DesktopIpcSyncEvent = { returnValue: undefined };
          listener!(withoutSender);
          assert.strictEqual(withoutSender.returnValue, null);
        }),
      );

      assert.deepEqual(received, [{ sender: { id: 7 } }, undefined]);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustEverySender);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );

  describe("sender check", () => {
    interface FakeFrame {
      readonly name: string;
    }
    interface FakeWebContents {
      readonly id: number;
      readonly mainFrame: FakeFrame;
      destroyed: boolean;
      isDestroyed(): boolean;
    }
    interface FakeWindow {
      readonly webContents: FakeWebContents;
      destroyed: boolean;
      isDestroyed(): boolean;
    }

    const makeWindow = (id: number): FakeWindow => {
      const webContents: FakeWebContents = {
        id,
        mainFrame: { name: `window-${id}-main-frame` },
        destroyed: false,
        isDestroyed: () => webContents.destroyed,
      };
      const window: FakeWindow = {
        webContents,
        destroyed: false,
        isDestroyed: () => window.destroyed,
      };
      return window;
    };

    const senderOf = (window: FakeWindow) => ({
      sender: { id: window.webContents.id },
      senderFrame: window.webContents.mainFrame,
    });

    // The window list is read live, so windows opened or closed after the
    // handlers are registered are seen by the next call. Like a stale caller
    // it can still hold a destroyed window.
    const installGuardedIpc = (windows: FakeWindow[]) =>
      Effect.gen(function* () {
        const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
        const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
        const ipc = yield* DesktopIpc.DesktopIpc.pipe(
          Effect.provide(
            DesktopIpc.layer({
              removeHandler: (channel) => void invoke.delete(channel),
              handle: (channel, listener) => void invoke.set(channel, listener),
              removeAllListeners: (channel) => void sync.delete(channel),
              on: (channel, listener) => void sync.set(channel, listener),
            }).pipe(
              Layer.provide(
                Layer.succeed(ElectronWindow.ElectronWindow, {
                  appWindows: Effect.sync(() => [...windows]),
                } as unknown as ElectronWindow.ElectronWindow["Service"]),
              ),
            ),
          ),
        );
        yield* ipc.handle({
          channel: "desktop.test.secret",
          handler: () => Effect.succeed("secret"),
        });
        yield* ipc.handleSync({
          channel: "desktop.test.secret-sync",
          handler: () => Effect.succeed("secret"),
        });
        const call = (event: DesktopIpc.DesktopIpcInvokeEvent) =>
          Effect.promise(async () => {
            const syncEvent: DesktopIpc.DesktopIpcSyncEvent = { ...event, returnValue: "unset" };
            sync.get("desktop.test.secret-sync")!(syncEvent);
            const invoked = await Promise.resolve(
              invoke.get("desktop.test.secret")!(event, undefined),
            ).catch(() => "rejected");
            return [invoked, syncEvent.returnValue];
          });
        return call;
      });

    it.effect("answers the main window and every project window, live", () =>
      Effect.gen(function* () {
        const main = makeWindow(1);
        const windows = [main];
        const call = yield* installGuardedIpc(windows);

        assert.deepEqual(yield* call(senderOf(main)), ["secret", "secret"]);

        // A project window opened after the handlers were registered.
        const project = makeWindow(2);
        windows.push(project);
        assert.deepEqual(yield* call(senderOf(project)), ["secret", "secret"]);

        // A second project window.
        const otherProject = makeWindow(3);
        windows.push(otherProject);
        assert.deepEqual(yield* call(senderOf(otherProject)), ["secret", "secret"]);

        // Closing the project window takes it out of the trusted set.
        windows.splice(windows.indexOf(project), 1);
        assert.deepEqual(yield* call(senderOf(project)), ["rejected", undefined]);
        assert.deepEqual(yield* call(senderOf(otherProject)), ["secret", "secret"]);
      }).pipe(Effect.scoped),
    );

    it.effect("ignores preview guests, subframes, destroyed and unknown senders", () =>
      Effect.gen(function* () {
        const main = makeWindow(1);
        const project = makeWindow(2);
        const closing = makeWindow(4);
        const call = yield* installGuardedIpc([main, project, closing]);

        const results: Record<string, unknown> = {};
        // A preview guest has its own webContents and main frame.
        results.previewGuest = yield* call({
          sender: { id: 9 },
          senderFrame: { name: "guest-main-frame" },
        });
        // A guest that reuses an app window's webContents id cannot reuse its frame.
        results.forgedId = yield* call({
          sender: { id: main.webContents.id },
          senderFrame: { name: "guest-main-frame" },
        });
        results.appSubframe = yield* call({
          sender: { id: project.webContents.id },
          senderFrame: { name: "iframe" },
        });
        results.noFrame = yield* call({ sender: { id: main.webContents.id } });

        // A window still listed but already destroyed.
        closing.destroyed = true;
        results.destroyedWindow = yield* call(senderOf(closing));
        // A window whose renderer was destroyed.
        project.webContents.destroyed = true;
        results.destroyedContents = yield* call(senderOf(project));

        assert.deepEqual(results, {
          previewGuest: ["rejected", undefined],
          forgedId: ["rejected", undefined],
          appSubframe: ["rejected", undefined],
          noFrame: ["rejected", undefined],
          destroyedWindow: ["rejected", undefined],
          destroyedContents: ["rejected", undefined],
        });
        assert.deepEqual(yield* call(senderOf(main)), ["secret", "secret"]);
      }).pipe(Effect.scoped),
    );

    it.effect("ignores a sync call that carries no sender", () =>
      Effect.gen(function* () {
        const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
        yield* Effect.gen(function* () {
          const ipc = yield* DesktopIpc.DesktopIpc;
          yield* ipc.handleSync({
            channel: "desktop.test.secret-sync",
            handler: () => Effect.succeed("secret"),
          });
        }).pipe(
          Effect.provide(
            DesktopIpc.layer({
              removeHandler: () => undefined,
              handle: () => undefined,
              removeAllListeners: (channel) => void sync.delete(channel),
              on: (channel, listener) => void sync.set(channel, listener),
            }).pipe(
              Layer.provide(
                Layer.succeed(ElectronWindow.ElectronWindow, {
                  appWindows: Effect.succeed([makeWindow(1)]),
                } as unknown as ElectronWindow.ElectronWindow["Service"]),
              ),
            ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              const event: DesktopIpc.DesktopIpcSyncEvent = { returnValue: "unset" };
              sync.get("desktop.test.secret-sync")!(event);
              assert.strictEqual(event.returnValue, undefined);
            }),
          ),
          Effect.scoped,
        );
      }),
    );
  });
});
