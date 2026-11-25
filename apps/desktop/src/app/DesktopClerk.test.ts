// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeHttp from "node:http";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  codexAuthHandoffUrl,
  readCodexAuthDelivery,
} from "@specweave-studio/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import { assert, describe, it, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, electronMock, storageAdapter, storageMock } = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener[]>();
  // Electron's ipcMain and app, as far as the Clerk wiring touches them.
  const electronMock = {
    handlers,
    listeners,
    ipcMain: {
      handle: (channel: string, listener: Listener) => {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handlers.set(channel, listener);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    },
    app: {
      on: (name: string, listener: Listener) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeListener: (name: string, listener: Listener) => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((candidate) => candidate !== listener),
        );
      },
    },
  };
  return {
    electronMock,
    createClerkBridgeMock: vi.fn(),
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    storageMock: vi.fn(),
  };
});

vi.mock("electron", () => ({ ipcMain: electronMock.ipcMain, app: electronMock.app }));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import type * as Electron from "electron";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import { CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL } from "./DesktopClerkOAuthTransport.ts";
import { CONNECT_SIGN_IN_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

const layerDesktopClerk = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
  shell: ElectronShell.ElectronShell["Service"] = {
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
  },
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/studio-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
    electronMock.handlers.clear();
    electronMock.listeners.clear();
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(layerDesktopClerk(true, events)));

      expect(createClerkBridgeMock.mock.calls).toEqual([
        [
          {
            storage: {
              getItem: expect.any(Function),
              setItem: expect.any(Function),
              removeItem: expect.any(Function),
            },
            passkeys: true,
            renderer: { scheme: "studio-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/studio-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.each([
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/SpecWithCode",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/app-data/studio-dev",
    },
  ])(
    "creates the bridge before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });
      // runSync throws if the layer ever suspends, which would let Electron emit
      // ready before the bridge exists. main.ts provides the same FileSystem.
      // oxlint-disable-next-line studio/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            layerDesktopClerk(isDevelopment, events, platform, DesktopPreReadyFileSystem.layer),
          ),
        ),
      );

      assert.deepEqual(events, [`setPath:userData:${userData}`, "createClerkBridge"]);
    },
  );

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(layerDesktopClerk())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/studio-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/studio-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(layerDesktopClerk(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/studio-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/studio-state" (development: false).',
        );
      }
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["open-url", "second-instance"]);
    }).pipe(
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });
});

// Tests that never launch the app a second time with the main window closed
// do not reach the window service.
const desktopWindow = {} as DesktopWindow.DesktopWindow["Service"];

it.effect("a second launch brings the main window back when only a project window is open", () => {
  storageMock.mockReturnValue(storageAdapter);
  createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const projectWindow = { id: 2 } as Electron.BrowserWindow;
  const recreatedMain = { id: 3 } as Electron.BrowserWindow;
  let main = Option.none<Electron.BrowserWindow>();
  let backendReady = false;
  const revealed: Electron.BrowserWindow[] = [];
  let settled = Promise.withResolvers<void>();
  const electronApp = {
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(name, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const electronWindow = {
    // Project windows never stand in for the main window.
    currentMainOrFirst: Effect.sync(() => main),
    main: Effect.sync(() => main),
    appWindows: Effect.sync(() => [...Option.toArray(main), projectWindow]),
    reveal: (window: Electron.BrowserWindow) =>
      Effect.sync(() => {
        revealed.push(window);
        settled.resolve();
      }),
  } as unknown as ElectronWindow.ElectronWindow["Service"];
  const activatingWindow = {
    activate: Effect.sync(() => {
      if (!backendReady) return;
      main = Option.some(recreatedMain);
      revealed.push(recreatedMain);
      settled.resolve();
    }),
  } as unknown as DesktopWindow.DesktopWindow["Service"];
  return Effect.gen(function* () {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.configure;

    // The main window cannot be opened yet: the project window comes forward.
    listeners.get("second-instance")!({}, ["specweave-studio"]);
    yield* Effect.promise(() => settled.promise);
    assert.deepEqual(revealed, [projectWindow]);

    revealed.length = 0;
    settled = Promise.withResolvers<void>();
    backendReady = true;
    listeners.get("second-instance")!({}, ["specweave-studio"]);
    yield* Effect.promise(() => settled.promise);
    assert.deepEqual(revealed, [recreatedMain]);

    // With the main window open again, a relaunch reveals it as before.
    revealed.length = 0;
    settled = Promise.withResolvers<void>();
    listeners.get("second-instance")!({}, ["specweave-studio"]);
    yield* Effect.promise(() => settled.promise);
    assert.deepEqual(revealed, [recreatedMain]);
  }).pipe(
    Effect.scoped,
    Effect.provide(layerDesktopClerk()),
    Effect.provideService(ElectronApp.ElectronApp, electronApp),
    Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    Effect.provideService(DesktopWindow.DesktopWindow, activatingWindow),
  );
});

it.effect(
  "provider auth deep links navigate and reveal the running desktop without handling Clerk URLs",
  () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL };
    const electronApp = {
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.some(window)),
      reveal: () => Effect.sync(() => revealed.resolve()),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const event = { preventDefault: vi.fn() };
      listeners.get("open-url")!(event, "studio-dev://app/auth/callback?code=clerk-code");
      listeners.get("open-url")!(event, "studio://app/welcome");
      assert.equal(loadURL.mock.calls.length, 0);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      listeners.get("second-instance")!({}, [
        "specweave-studio",
        "studio-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => revealed.promise);
      assert.deepEqual(loadURL.mock.calls, [
        ["studio-dev://app/settings/providers?instanceId=work"],
      ]);
      listeners.get("open-url")!(event, "studio-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  },
);

it.effect("a second launch from an installed page's launcher leaves the main window alone", () => {
  storageMock.mockReturnValue(storageAdapter);
  createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const mainWindow = { id: 1 } as Electron.BrowserWindow;
  const revealed: Electron.BrowserWindow[] = [];
  const settled = Promise.withResolvers<void>();
  const electronApp = {
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(name, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const electronWindow = {
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    reveal: (window: Electron.BrowserWindow) =>
      Effect.sync(() => {
        revealed.push(window);
        settled.resolve();
      }),
  } as unknown as ElectronWindow.ElectronWindow["Service"];
  const installId = "0123456789abcdef0123456789abcdef";
  return Effect.gen(function* () {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.configure;
    // A plain relaunch reveals the main window, and does so before the listener returns.
    listeners.get("second-instance")!({}, ["specweave-studio"]);
    assert.deepEqual(revealed, [mainWindow]);
    yield* Effect.promise(() => settled.promise);
    // Both schemes, so the case holds for a development and a packaged build alike.
    listeners.get("second-instance")!({}, [
      "specweave-studio",
      `studio://app/artifact-app/${installId}`,
      `studio-dev://app/artifact-app/${installId}`,
    ]);
    assert.deepEqual(revealed, [mainWindow]);
  }).pipe(
    Effect.scoped,
    Effect.provide(layerDesktopClerk()),
    Effect.provideService(ElectronApp.ElectronApp, electronApp),
    Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
  );
});

it.effect.each(["startup", "open-url"] as const)(
  "receives web client sign-in through the desktop %s handler",
  (entry) =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const port = yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      });
      const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
      authorize.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const request = {
        authorizationUrl: authorize.toString(),
        returnUrl: "http://localhost:5733/welcome#agents:remote-one",
        environmentId: EnvironmentId.make("remote-one"),
        instanceId: ProviderInstanceId.make("work"),
        flowId: "flow-one",
      };
      const link = codexAuthHandoffUrl(request, true);
      const delivered = Promise.withResolvers<string>();
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (value) =>
          Effect.promise(async () => {
            const url = new URL(String(value));
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.search = new URLSearchParams({
              state: url.searchParams.get("state")!,
              code: "test-code",
              client_id: "oaiapp_test",
            }).toString();
            const response = await fetch(callback, { redirect: "manual" });
            delivered.resolve(response.headers.get("location")!);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const electronApp = {
        whenReady: Effect.void,
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        if (entry === "open-url") {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, link);
          assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        }
        const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
        assert.strictEqual(delivery?.environmentId, request.environmentId);
        assert.strictEqual(delivery?.instanceId, request.instanceId);
        assert.strictEqual(delivery?.flowId, request.flowId);
        assert.strictEqual(delivery?.returnUrl, request.returnUrl);
      }).pipe(
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell)),
        Effect.provideService(
          HostProcessArguments,
          entry === "startup" ? ["specweave-studio", link] : ["specweave-studio"],
        ),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(
          ElectronWindow.ElectronWindow,
          {} as ElectronWindow.ElectronWindow["Service"],
        ),
        Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
      );
    }).pipe(Effect.scoped),
);

describe("DesktopClerk Connect sign-in handler", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
    electronMock.handlers.clear();
    electronMock.listeners.clear();
  });

  const appListenerCounts = () => [
    electronMock.listeners.get("open-url")?.length ?? 0,
    electronMock.listeners.get("second-instance")?.length ?? 0,
  ];
  const makeWindowSender = () => {
    const sender = {
      id: 7,
      getType: () => "window",
      mainFrame: { frame: "main" },
      isDestroyed: () => false,
      send: vi.fn<(channel: string, state: string) => void>(),
    };
    return { sender, event: { sender, senderFrame: sender.mainFrame } };
  };
  const scopedAppListeners = {
    on: () => Effect.void,
  } as unknown as ElectronApp.ElectronApp["Service"];

  it.effect(
    "takes over the SDK's open channel in the primary instance and releases it before the bridge",
    () => {
      const order: string[] = [];
      const sdkHandler = vi.fn();
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        // The SDK registers its own handler when the bridge is created.
        electronMock.ipcMain.handle(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL, sdkHandler);
        return {
          isPrimaryInstance: true,
          cleanup: () => {
            order.push(
              `bridge cleanup, handler ${electronMock.handlers.has(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL) ? "present" : "gone"}, listeners ${appListenerCounts().join("/")}`,
            );
            electronMock.ipcMain.removeHandler(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL);
          },
        };
      });

      return Effect.gen(function* () {
        yield* Effect.scoped(
          Layer.build(layerDesktopClerk()).pipe(
            Effect.flatMap((context) =>
              Effect.gen(function* () {
                const clerk = yield* DesktopClerk.DesktopClerk;
                yield* clerk.configure;
                const installed = electronMock.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL);
                assert.isDefined(installed);
                assert.notStrictEqual(installed, sdkHandler);
                assert.deepEqual(appListenerCounts(), [1, 1]);
                order.push("configured");
              }).pipe(
                Effect.provide(context),
                Effect.provideService(ElectronApp.ElectronApp, scopedAppListeners),
                Effect.provideService(
                  ElectronWindow.ElectronWindow,
                  {} as ElectronWindow.ElectronWindow["Service"],
                ),
                Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
              ),
            ),
          ),
        );

        assert.deepEqual(order, ["configured", "bridge cleanup, handler gone, listeners 0/0"]);
        assert.equal(electronMock.handlers.size, 0);
      });
    },
  );

  it.effect("leaves the channel alone in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const electronApp = {
      quit: Effect.void,
      on: () => Effect.void,
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* Effect.exit(Effect.scoped(clerk.configure));
      assert.equal(electronMock.handlers.size, 0);
      assert.deepEqual(appListenerCounts(), [0, 0]);
    }).pipe(
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });

  it.effect(
    "opens the browser through the shell, reports to the asking window and reveals it on the callback",
    () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const opened: unknown[] = [];
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (url) =>
          Effect.sync(() => {
            opened.push(url);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      const askingWindow = { id: 70 } as Electron.BrowserWindow;
      const lookedUp: number[] = [];
      const revealed = Promise.withResolvers<Electron.BrowserWindow>();
      const electronWindow = {
        appWindowForWebContents: (webContentsId: number) =>
          Effect.sync(() => {
            lookedUp.push(webContentsId);
            return Option.some(askingWindow);
          }),
        reveal: (window: Electron.BrowserWindow) => Effect.sync(() => revealed.resolve(window)),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        const { sender, event } = makeWindowSender();
        const handler = electronMock.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL)!;

        const signIn = handler(event, "https://accounts.example.com/authorize?state=s") as Promise<{
          callbackUrl: string;
        }>;
        assert.deepEqual(sender.send.mock.calls, [[CONNECT_SIGN_IN_STATE_CHANNEL, "waiting"]]);

        // Development builds use the studio-dev scheme; the production link is not theirs.
        const openUrl = electronMock.listeners.get("open-url")![0]!;
        openUrl({ preventDefault: vi.fn() }, "studio://app/?rotating_token_nonce=n");
        const callback = { preventDefault: vi.fn() };
        openUrl(callback, "studio-dev://app/?rotating_token_nonce=n");

        assert.deepEqual(yield* Effect.promise(() => signIn), {
          callbackUrl: "studio-dev://app/?rotating_token_nonce=n",
        });
        assert.equal(callback.preventDefault.mock.calls.length, 1);
        assert.deepEqual(opened, ["https://accounts.example.com/authorize?state=s"]);
        assert.deepEqual(sender.send.mock.calls, [
          [CONNECT_SIGN_IN_STATE_CHANNEL, "waiting"],
          [CONNECT_SIGN_IN_STATE_CHANNEL, "completed"],
        ]);
        assert.strictEqual(yield* Effect.promise(() => revealed.promise), askingWindow);
        assert.deepEqual(lookedUp, [7]);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell)),
        Effect.provideService(ElectronApp.ElectronApp, scopedAppListeners),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
      );
    },
  );

  it.effect("reports open-failed when the shell cannot open the browser", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const shell = ElectronShell.ElectronShell.of({
      openExternal: () => Effect.succeed(false),
      openSystemSettings: () => Effect.succeed(false),
      copyText: () => Effect.void,
    });

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const { sender, event } = makeWindowSender();
      const handler = electronMock.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL)!;

      const error = yield* Effect.promise(() =>
        (handler(event, "https://accounts.example.com/authorize?state=s") as Promise<unknown>).then(
          () => null,
          (cause: unknown) => cause,
        ),
      );

      assert.instanceOf(error, Error);
      assert.equal(
        (error as Error).message,
        "Clerk: could not open the browser for the OAuth flow.",
      );
      assert.deepEqual(sender.send.mock.calls, [
        [CONNECT_SIGN_IN_STATE_CHANNEL, "waiting"],
        [CONNECT_SIGN_IN_STATE_CHANNEL, "open-failed"],
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell)),
      Effect.provideService(ElectronApp.ElectronApp, scopedAppListeners),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });
});
