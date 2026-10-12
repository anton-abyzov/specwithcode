import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";

// Manager.test.ts keeps its harness private, so the few doubles these tests
// need are repeated here in their smallest form.
const { fromId, previewSession } = vi.hoisted(() => ({
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  previewSession: { on: vi.fn() },
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  ClipboardItem: class {},
  clipboard: { write: vi.fn(async () => undefined) },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: {
    fromId,
    getFocusedWebContents: vi.fn(() => null),
  },
}));

const managerLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
  ),
  Layer.provideMerge(DesktopBrowserHost.layer),
  Layer.provideMerge(
    Layer.succeed(
      BrowserSession.BrowserSession,
      BrowserSession.BrowserSession.of({
        getPartition: () => Effect.succeed("persist:studio-preview-test"),
        isPartition: (partition) => partition.startsWith("persist:studio-preview-"),
        getSession: () => Effect.succeed(previewSession as unknown as Electron.Session),
        clearCookies: () => Effect.void,
        clearCache: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        browserArtifactsDir: "/tmp/studio/dev/browser-artifacts",
        dirname: "/tmp/studio/desktop",
        path: {
          join: (...parts: ReadonlyArray<string>) => parts.join("/"),
        },
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
  ),
  Layer.provideMerge(FileSystem.layerNoop({})),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin" as NodeJS.Platform)),
);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(managerLayer), Effect.scoped);

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

/** The page of one app window: what a guest reports as its host. */
const makeHostWebContents = (id: number) => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id,
    mainFrame: { frameTreeNodeId: id },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    setBackgroundThrottling: vi.fn(),
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

type TestHostWebContents = ReturnType<typeof makeHostWebContents>;

/** An app window whose "closed" listener the test fires by hand. */
const makeHostWindow = (hostWebContents: TestHostWebContents) => {
  let destroyed = false;
  let closed: (() => void) | undefined;
  const window = {
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") closed = listener;
    }),
    // Electron throws on a closed window, so reading it there is a test failure.
    get webContents() {
      if (destroyed) throw new Error("Object has been destroyed");
      return hostWebContents;
    },
  };
  return {
    window: window as unknown as Electron.BrowserWindow,
    close: () => {
      destroyed = true;
      closed?.();
    },
  };
};

const makeGuest = (id: number, hostWebContents: TestHostWebContents) => {
  const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
  const guest = {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoading: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling,
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: vi.fn(),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage: vi.fn(async () => ({
      toJPEG: () => Buffer.from("frame"),
      getSize: () => ({ width: 1280, height: 720 }),
    })),
  };
  return guest as unknown as Electron.WebContents & {
    readonly setBackgroundThrottling: typeof setBackgroundThrottling;
  };
};

const serveGuests = (...guests: ReadonlyArray<Electron.WebContents>) => {
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  fromId.mockImplementation((id) => (id === undefined ? null : (byId.get(id) ?? null)));
};

const settle = function* (until: () => boolean) {
  for (let attempt = 0; attempt < 30 && !until(); attempt++) {
    yield* Effect.promise(() => Promise.resolve());
  }
};

const expectWebContentsNotFound = (exit: Exit.Exit<void, PreviewManager.PreviewManagerError>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  const error = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(error) && error.value._tag).toBe("PreviewWebContentsNotFoundError");
};

describe("PreviewManager host windows", () => {
  beforeEach(() => {
    fromId.mockReset();
    fromId.mockReturnValue(null);
    previewSession.on.mockClear();
  });

  effectIt.effect("registers a guest embedded by a project window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const main = makeHostWindow(makeHostWebContents(7));
        const projectHost = makeHostWebContents(21);
        const project = makeHostWindow(projectHost);
        serveGuests(makeGuest(52, projectHost));
        yield* manager.setMainWindow(main.window);
        yield* manager.addHostWindow(project.window);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_project");
        yield* manager.registerWebview("tab_project", 52);

        expect(states.at(-1)?.webContentsId).toBe(52);
        expect(yield* manager.hostWebContentsIdForTab("tab_project")).toEqual(Option.some(21));
      }),
    ),
  );

  effectIt.effect("still rejects a guest embedded by a window that was never added", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const mainHost = makeHostWebContents(7);
        const main = makeHostWindow(mainHost);
        const project = makeHostWindow(makeHostWebContents(21));
        const strangerHost = makeHostWebContents(33);
        serveGuests(makeGuest(41, mainHost), makeGuest(63, strangerHost));
        yield* manager.setMainWindow(main.window);
        yield* manager.addHostWindow(project.window);
        yield* manager.createTab("tab_main");
        yield* manager.createTab("tab_stranger");

        yield* manager.registerWebview("tab_main", 41);
        const rejected = yield* manager.registerWebview("tab_stranger", 63).pipe(Effect.exit);

        expect(yield* manager.hostWebContentsIdForTab("tab_main")).toEqual(Option.some(7));
        expectWebContentsNotFound(rejected);
        expect(yield* manager.hostWebContentsIdForTab("tab_stranger")).toEqual(Option.none());
      }),
    ),
  );

  effectIt.effect("forgets a project window once it has closed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const main = makeHostWindow(makeHostWebContents(7));
        const projectHost = makeHostWebContents(21);
        const project = makeHostWindow(projectHost);
        serveGuests(makeGuest(52, projectHost), makeGuest(53, projectHost));
        yield* manager.setMainWindow(main.window);
        yield* manager.addHostWindow(project.window);
        yield* manager.createTab("tab_before");
        yield* manager.createTab("tab_after");
        yield* manager.registerWebview("tab_before", 52);

        project.close();
        const rejected = yield* manager.registerWebview("tab_after", 53).pipe(Effect.exit);

        expectWebContentsNotFound(rejected);
      }),
    ),
  );

  effectIt.effect("keeps registering project window guests after the main window is gone", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const mainHost = makeHostWebContents(7);
        const main = makeHostWindow(mainHost);
        const projectHost = makeHostWebContents(21);
        const project = makeHostWindow(projectHost);
        serveGuests(makeGuest(41, mainHost), makeGuest(52, projectHost));
        yield* manager.setMainWindow(main.window);
        yield* manager.addHostWindow(project.window);
        yield* manager.createTab("tab_project");
        yield* manager.createTab("tab_main");

        main.close();
        yield* manager.registerWebview("tab_project", 52);
        // The closed main window hosts nothing, and asking must not read it.
        const rejected = yield* manager.registerWebview("tab_main", 41).pipe(Effect.exit);

        expect(yield* manager.hostWebContentsIdForTab("tab_project")).toEqual(Option.some(21));
        expectWebContentsNotFound(rejected);
      }),
    ),
  );

  effectIt.effect("ignores a window that is already closed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const main = makeHostWindow(makeHostWebContents(7));
        const projectHost = makeHostWebContents(21);
        const project = makeHostWindow(projectHost);
        serveGuests(makeGuest(52, projectHost));
        yield* manager.setMainWindow(main.window);
        project.close();

        yield* manager.addHostWindow(project.window);
        yield* manager.createTab("tab_project");
        const rejected = yield* manager.registerWebview("tab_project", 52).pipe(Effect.exit);

        expectWebContentsNotFound(rejected);
      }),
    ),
  );

  effectIt.effect("reports no host for a tab without an attached guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.createTab("tab_empty");

        expect(yield* manager.hostWebContentsIdForTab("tab_empty")).toEqual(Option.none());
        expect(yield* manager.hostWebContentsIdForTab("tab_unknown")).toEqual(Option.none());
      }),
    ),
  );

  effectIt.effect("stops only the closing project window's recordings", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const mainHost = makeHostWebContents(7);
        const main = makeHostWindow(mainHost);
        const projectHost = makeHostWebContents(21);
        const project = makeHostWindow(projectHost);
        const mainGuest = makeGuest(41, mainHost);
        const projectGuest = makeGuest(52, projectHost);
        serveGuests(mainGuest, projectGuest);
        yield* manager.setMainWindow(main.window);
        yield* manager.addHostWindow(project.window);
        yield* manager.createTab("tab_main");
        yield* manager.createTab("tab_project");
        yield* manager.registerWebview("tab_main", 41);
        yield* manager.registerWebview("tab_project", 52);
        yield* manager.startRecording("tab_main");
        // The main window takes its grant, freeing the arm slot for the project window.
        mainHost.displayMediaHandler()?.({ frame: mainHost.mainFrame }, () => {});
        yield* manager.startRecording("tab_project");
        expect(mainGuest.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(projectGuest.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        project.close();
        yield* settle(() => projectGuest.setBackgroundThrottling.mock.calls.length > 1);

        // Recording a tab keeps its guest unthrottled; handing throttling back
        // is how a stopped recording shows up here.
        expect(projectGuest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(mainGuest.setBackgroundThrottling.mock.calls).toEqual([[false]]);
      }),
    ),
  );
});
