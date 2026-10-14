import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  screen: {
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const BACKEND_URL = new URL("http://127.0.0.1:8319");
const ATLAS_URL = "studio-dev://app/#/projects/atlas";

type Listener = (...args: readonly unknown[]) => void;

function makeFakeWindow(id: number) {
  const windowListeners = new Map<string, Listener[]>();
  const webContentsListeners = new Map<string, Listener[]>();
  const add = (listeners: Map<string, Listener[]>) => (eventName: string, listener: Listener) => {
    listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
  };
  let bounds = { x: 0, y: 0, width: 1100, height: 780 };
  let url = "";
  let destroyed = false;
  const webContents = {
    id: id + 1000,
    focus: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    getURL: vi.fn(() => url),
    getZoomLevel: vi.fn(() => 0),
    getZoomFactor: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn(add(webContentsListeners)),
    once: vi.fn(add(webContentsListeners)),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    id,
    getBounds: vi.fn(() => bounds),
    getNormalBounds: vi.fn(() => bounds),
    isDestroyed: vi.fn(() => destroyed),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn((next: string) => {
      url = next;
      return Promise.resolve();
    }),
    maximize: vi.fn(),
    on: vi.fn(add(windowListeners)),
    once: vi.fn(add(windowListeners)),
    setAutoHideCursor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    webContents,
  };
  return {
    window: window as unknown as Electron.BrowserWindow,
    raw: window,
    emit: (eventName: string) => {
      for (const listener of windowListeners.get(eventName) ?? []) listener();
    },
    emitWith: (eventName: string, ...args: readonly unknown[]) => {
      for (const listener of windowListeners.get(eventName) ?? []) listener(...args);
    },
    moveTo: (next: typeof bounds) => {
      bounds = next;
      for (const listener of windowListeners.get("move") ?? []) listener();
    },
    navigateTo: (next: string) => {
      url = next;
    },
    close: () => {
      for (const listener of windowListeners.get("close") ?? []) listener();
      destroyed = true;
      for (const listener of windowListeners.get("closed") ?? []) listener();
    },
  };
}

function makeHarness(input: { readonly settings?: DesktopAppSettings.DesktopSettings } = {}) {
  const created: ReturnType<typeof makeFakeWindow>[] = [];
  const createdOptions: Electron.BrowserWindowConstructorOptions[] = [];
  const revealed: Electron.BrowserWindow[] = [];
  const secondary = new Set<Electron.BrowserWindow>();
  const previewMainWindows: Electron.BrowserWindow[] = [];
  const previewHostWindows: Electron.BrowserWindow[] = [];
  const surfaces: string[] = [];
  let main: Option.Option<Electron.BrowserWindow> = Option.none();
  let focused: Option.Option<Electron.BrowserWindow> = Option.none();

  const liveMain = Effect.sync(() =>
    Option.isSome(main) && !main.value.isDestroyed() ? main : Option.none<Electron.BrowserWindow>(),
  );
  const appWindows = Effect.map(liveMain, (current) => [
    ...Option.toArray(current),
    ...[...secondary].filter((window) => !window.isDestroyed()),
  ]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        const fake = makeFakeWindow(created.length + 1);
        created.push(fake);
        createdOptions.push(options);
        return fake.window;
      }),
    main: liveMain,
    // Like the real service: project windows are never "main or first".
    currentMainOrFirst: liveMain,
    focusedMainOrFirst: Effect.flatMap(
      Effect.sync(() => focused),
      (window) => (Option.isSome(window) ? Effect.succeed(window) : liveMain),
    ),
    setMain: (window) =>
      Effect.sync(() => {
        main = Option.some(window);
      }),
    clearMain: (window) =>
      Effect.sync(() => {
        if (Option.isSome(main) && Option.isSome(window) && main.value === window.value) {
          main = Option.none();
        }
      }),
    registerSecondary: (window) =>
      Effect.sync(() => {
        secondary.add(window);
      }),
    appWindows,
    appWindowForWebContents: (webContentsId) =>
      Effect.map(appWindows, (windows) =>
        Option.fromNullishOr(
          windows.find((window) => window.webContents.id === webContentsId) ?? null,
        ),
      ),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) =>
      Effect.sync(() => {
        revealed.push(window);
      }),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const layer = DesktopWindow.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.none<string>(),
            icns: Option.none<string>(),
            png: Option.none<string>(),
          }),
          resolveResourcePath: () => Effect.succeed(Option.none<string>()),
        } satisfies DesktopAssets.DesktopAssets["Service"]),
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: (_webContents, identity) =>
            Effect.sync(() => {
              surfaces.push(identity.surface);
            }),
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/Users/alice",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: false,
          resourcesPath: "/repo/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              DesktopConfig.layerTest({
                STUDIO_PORT: "8319",
                VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
        DesktopAppSettings.layerTest(input.settings),
        Layer.mock(DesktopClientSettings.DesktopClientSettings)({ get: Effect.succeedNone }),
        Layer.mock(DesktopServerExposure.DesktopServerExposure)({}),
        DesktopState.layer,
        Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          popupTemplate: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
        } satisfies ElectronMenu.ElectronMenu["Service"]),
        Layer.mock(ElectronShell.ElectronShell)({}),
        Layer.succeed(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(false),
          setSource: () => Effect.void,
          onUpdated: () => Effect.void,
        } satisfies ElectronTheme.ElectronTheme["Service"]),
        layerElectronWindow,
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: (window) =>
            Effect.sync(() => {
              previewMainWindows.push(window);
            }),
          addHostWindow: (window) =>
            Effect.sync(() => {
              previewHostWindows.push(window);
            }),
          prepareWebview: () => Effect.void,
          isBrowserPartition: () => true,
          reapplyZoom: () => Effect.void,
        }),
      ),
    ),
  );

  return {
    layer,
    created,
    createdOptions,
    revealed,
    secondary,
    previewMainWindows,
    previewHostWindows,
    surfaces,
    main: () => main,
    focus: (window: Electron.BrowserWindow | null) => {
      focused = Option.fromNullishOr(window);
    },
  };
}

const openMain = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.handleBackendReady(BACKEND_URL);
  return desktopWindow;
});

describe("DesktopWindow project windows", () => {
  it.effect("opens a project in its own window on the project route", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const window = yield* desktopWindow.openProjectWindow({
        projectKey: "atlas",
        title: "Atlas",
      });

      assert.equal(harness.created.length, 2);
      const [mainFake, projectFake] = harness.created;
      assert.equal(window, projectFake?.window);
      assert.deepEqual(projectFake?.raw.loadURL.mock.calls, [[ATLAS_URL]]);
      assert.deepEqual(mainFake?.raw.loadURL.mock.calls, [["studio-dev://app/"]]);

      const options = harness.createdOptions[1];
      assert.equal(options?.title, "Atlas - SpecWithCode (Dev)");
      assert.equal(options?.show, false);
      assert.equal(options?.minWidth, 840);
      assert.equal(options?.minHeight, 620);
      // Same hardening as the main window; only the role argument differs.
      assert.deepEqual(
        { ...options?.webPreferences, additionalArguments: undefined },
        { ...harness.createdOptions[0]?.webPreferences, additionalArguments: undefined },
      );
      assert.deepEqual(options?.webPreferences?.additionalArguments, [
        "--studio-window-role=project",
        "--studio-window-project=atlas",
      ]);
      assert.deepEqual(harness.createdOptions[0]?.webPreferences?.additionalArguments, [
        "--studio-window-role=main",
      ]);
      assert.equal(options?.webPreferences?.sandbox, true);
      assert.equal(options?.webPreferences?.contextIsolation, true);
      assert.equal(options?.webPreferences?.nodeIntegration, false);

      // It is an app window, but never the main one.
      assert.isTrue(harness.secondary.has(window));
      assert.equal(Option.getOrNull(harness.main()), mainFake?.window);
      assert.deepEqual(harness.surfaces, ["main", "project"]);
      assert.deepEqual(harness.previewMainWindows, [mainFake?.window]);
      assert.deepEqual(harness.previewHostWindows, [window]);
      // Development tools open for the main window only.
      assert.equal(mainFake?.raw.webContents.openDevTools.mock.calls.length, 1);
      assert.equal(projectFake?.raw.webContents.openDevTools.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reuses a legacy project window after handoff canonicalizes its route", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const legacy = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      const canonical = "logical-project:one";
      harness.created[1]?.navigateTo(
        `studio-dev://app/#/projects/${encodeURIComponent(canonical)}?thread=worker&threadEnvironment=m1`,
      );
      const current = yield* desktopWindow.openProjectWindow({ projectKey: canonical });
      assert.equal(current, legacy);
      assert.equal(harness.created.length, 2);
      assert.equal(harness.created[1]?.raw.loadURL.mock.calls.length, 1);
      assert.equal(yield* desktopWindow.openProjectWindow({ projectKey: canonical }), legacy);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("encodes project keys that contain path and fragment characters", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      yield* desktopWindow.openProjectWindow({ projectKey: "env:/Users/a b/#repo::apps/web" });
      assert.deepEqual(harness.created[1]?.raw.loadURL.mock.calls, [
        ["studio-dev://app/#/projects/env%3A%2FUsers%2Fa%20b%2F%23repo%3A%3Aapps%2Fweb"],
      ]);
      assert.equal(harness.createdOptions[1]?.title, "SpecWithCode (Dev)");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("brings the open window forward instead of opening the project twice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const first = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      const second = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });

      assert.equal(second, first);
      assert.equal(harness.created.length, 2);
      assert.deepEqual(harness.revealed, [first]);
      // Still on the project: nothing is reloaded.
      assert.equal(harness.created[1]?.raw.loadURL.mock.calls.length, 1);

      harness.created[1]?.navigateTo("studio-dev://app/#/settings");
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      assert.deepEqual(harness.created[1]?.raw.loadURL.mock.calls, [[ATLAS_URL], [ATLAS_URL]]);

      const other = yield* desktopWindow.openProjectWindow({ projectKey: "borealis" });
      assert.notEqual(other, first);
      assert.equal(harness.created.length, 3);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells apart projects whose keys extend one another", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const repo = yield* desktopWindow.openProjectWindow({ projectKey: "acme/mono" });
      const repoFake = harness.created[1];

      // The window moved to a longer key that starts with this project's key.
      repoFake?.navigateTo("studio-dev://app/#/projects/acme%2Fmono%3A%3Apackages%2Fweb");
      assert.equal(yield* desktopWindow.openProjectWindow({ projectKey: "acme/mono" }), repo);
      assert.equal(repoFake?.raw.loadURL.mock.calls.length, 2);

      // A deeper route or search on the same project is still the project.
      repoFake?.navigateTo("studio-dev://app/#/projects/acme%2Fmono?tab=plan");
      yield* desktopWindow.openProjectWindow({ projectKey: "acme/mono" });
      assert.equal(repoFake?.raw.loadURL.mock.calls.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("picks up a renamed project the next time its window is requested", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas", title: "Atlas" });
      const fake = harness.created[1];
      fake?.raw.setTitle.mockClear();

      yield* desktopWindow.openProjectWindow({ projectKey: "atlas", title: "Atlas Web" });
      assert.deepEqual(fake?.raw.setTitle.mock.calls, [["Atlas Web - SpecWithCode (Dev)"]]);

      // The page cannot put its own title back.
      fake?.raw.setTitle.mockClear();
      fake?.emitWith("page-title-updated", { preventDefault: () => undefined });
      assert.deepEqual(fake?.raw.setTitle.mock.calls, [["Atlas Web - SpecWithCode (Dev)"]]);

      // A request without a title keeps the current one.
      fake?.raw.setTitle.mockClear();
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      assert.deepEqual(fake?.raw.setTitle.mock.calls, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends capture events to the main window while a project window has focus", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const project = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      harness.focus(project);
      harness.revealed.length = 0;

      yield* desktopWindow.dispatchSnapShotEvent({ type: "started" } as never);

      const [mainFake, projectFake] = harness.created;
      assert.equal(mainFake?.raw.webContents.send.mock.calls.length, 1);
      assert.equal(projectFake?.raw.webContents.send.mock.calls.length, 0);
      assert.deepEqual(harness.revealed, [mainFake?.window]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("moves only the zoomed window's buttons when a helper window has focus", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const project = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      const [mainFake, projectFake] = harness.created;
      mainFake?.raw.setWindowButtonPosition.mockClear();
      projectFake?.raw.setWindowButtonPosition.mockClear();

      harness.focus(makeFakeWindow(99).window);
      yield* desktopWindow.zoomMain("in");
      assert.equal(mainFake?.raw.setWindowButtonPosition.mock.calls.length, 0);
      assert.equal(projectFake?.raw.setWindowButtonPosition.mock.calls.length, 0);

      // Zoom is shared by the app windows, so both follow a zoom in either.
      harness.focus(project);
      yield* desktopWindow.zoomMain("in");
      assert.equal(mainFake?.raw.setWindowButtonPosition.mock.calls.length, 1);
      assert.equal(projectFake?.raw.setWindowButtonPosition.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("opens one window when the same project is requested twice at once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const [first, second] = yield* Effect.all(
        [
          desktopWindow.openProjectWindow({ projectKey: "atlas" }),
          desktopWindow.openProjectWindow({ projectKey: "atlas" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(first, second);
      assert.equal(harness.created.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("remembers each project window's position without touching the main window's", () => {
    const harness = makeHarness({
      settings: {
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        mainWindowBounds: { x: 40, y: 40, width: 1200, height: 800 },
        projectWindowBounds: [
          {
            projectKey: "atlas",
            bounds: { x: 300, y: 120, width: 1300, height: 900 },
            maximized: true,
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });

      const options = harness.createdOptions[1];
      assert.deepEqual(
        { x: options?.x, y: options?.y, width: options?.width, height: options?.height },
        { x: 300, y: 120, width: 1300, height: 900 },
      );
      harness.created[1]?.emit("ready-to-show");
      assert.equal(harness.created[1]?.raw.maximize.mock.calls.length, 1);

      harness.created[1]?.moveTo({ x: 500, y: 200, width: 1000, height: 700 });
      yield* TestClock.adjust(500);
      yield* Effect.promise(() => Promise.resolve());

      const saved = yield* settings.get;
      assert.deepEqual(saved.projectWindowBounds, [
        {
          projectKey: "atlas",
          bounds: { x: 500, y: 200, width: 1000, height: 700 },
          maximized: false,
        },
      ]);
      assert.deepEqual(saved.mainWindowBounds, { x: 40, y: 40, width: 1200, height: 800 });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("places a first-time project window beside the main window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      harness.created[0]?.moveTo({ x: 100, y: 60, width: 1100, height: 780 });
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });

      const options = harness.createdOptions[1];
      assert.deepEqual(
        { x: options?.x, y: options?.y, width: options?.width, height: options?.height },
        { x: 132, y: 92, width: 1100, height: 780 },
      );

      // The next one steps further, so it does not cover the first.
      yield* desktopWindow.openProjectWindow({ projectKey: "borealis" });
      const next = harness.createdOptions[2];
      assert.deepEqual(
        { x: next?.x, y: next?.y, width: next?.width, height: next?.height },
        { x: 164, y: 124, width: 1100, height: 780 },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cascades a project window whose saved position is off every display", () => {
    const harness = makeHarness({
      settings: {
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        projectWindowBounds: [
          {
            projectKey: "atlas",
            bounds: { x: 9000, y: 9000, width: 1200, height: 800 },
            maximized: false,
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      harness.created[0]?.moveTo({ x: 100, y: 60, width: 1100, height: 780 });
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });

      const options = harness.createdOptions[1];
      assert.deepEqual(
        { x: options?.x, y: options?.y, width: options?.width, height: options?.height },
        { x: 132, y: 92, width: 1100, height: 780 },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("saves the pending position of every open window on quit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      yield* desktopWindow.openProjectWindow({ projectKey: "borealis" });

      harness.created[0]?.moveTo({ x: 10, y: 20, width: 1100, height: 780 });
      harness.created[1]?.moveTo({ x: 200, y: 100, width: 1000, height: 700 });
      harness.created[2]?.moveTo({ x: 400, y: 150, width: 900, height: 650 });
      // No debounce has elapsed: only an explicit flush can have saved these.
      yield* desktopWindow.flushMainWindowBounds;

      const saved = yield* settings.get;
      assert.deepEqual(saved.mainWindowBounds, { x: 10, y: 20, width: 1100, height: 780 });
      assert.deepEqual(
        saved.projectWindowBounds.map((entry) => [entry.projectKey, entry.bounds]),
        [
          ["atlas", { x: 200, y: 100, width: 1000, height: 700 }],
          ["borealis", { x: 400, y: 150, width: 900, height: 650 }],
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reopens a project after its window was closed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      harness.created[1]?.moveTo({ x: 250, y: 90, width: 1000, height: 700 });
      harness.created[1]?.close();
      yield* Effect.promise(() => Promise.resolve());
      assert.deepEqual(
        DesktopAppSettings.findProjectWindowState(yield* settings.get, "atlas")?.bounds,
        { x: 250, y: 90, width: 1000, height: 700 },
      );

      const reopened = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      assert.equal(harness.created.length, 3);
      assert.equal(reopened, harness.created[2]?.window);
      const options = harness.createdOptions[2];
      assert.deepEqual({ x: options?.x, y: options?.y }, { x: 250, y: 90 });
      // The closed window is no longer flushed: nothing looks at it again.
      const probes = harness.created[1]!.raw.isDestroyed.mock.calls.length;
      yield* desktopWindow.flushMainWindowBounds;
      assert.equal(harness.created[1]!.raw.isDestroyed.mock.calls.length, probes);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recreates the main window when only a project window is left open", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const project = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      harness.created[0]?.close();
      yield* Effect.promise(() => Promise.resolve());
      assert.isTrue(Option.isNone(harness.main()));

      yield* desktopWindow.activate;

      assert.equal(harness.created.length, 3);
      assert.equal(Option.getOrNull(harness.main()), harness.created[2]?.window);
      assert.notEqual(Option.getOrNull(harness.main()), project);
      assert.deepEqual(harness.created[2]?.raw.loadURL.mock.calls, [["studio-dev://app/"]]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "leaves the main window closed when the backend restarts under a project window",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const desktopWindow = yield* openMain;
        yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
        harness.created[0]?.close();
        yield* Effect.promise(() => Promise.resolve());

        yield* desktopWindow.handleBackendNotReady;
        yield* desktopWindow.handleBackendReady(BACKEND_URL);
        assert.equal(harness.created.length, 2);
        assert.isTrue(Option.isNone(harness.main()));

        // With every window closed it opens as before.
        harness.created[1]?.close();
        yield* Effect.promise(() => Promise.resolve());
        yield* desktopWindow.handleBackendReady(BACKEND_URL);
        assert.equal(harness.created.length, 3);
        assert.equal(Option.getOrNull(harness.main()), harness.created[2]?.window);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("tells a project window which project it is, whatever the key contains", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      yield* desktopWindow.openProjectWindow({ projectKey: "env 1:/Users/a b/Orbit API" });
      assert.deepEqual(harness.createdOptions[1]?.webPreferences?.additionalArguments, [
        "--studio-window-role=project",
        "--studio-window-project=env%201%3A%2FUsers%2Fa%20b%2FOrbit%20API",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a project window alone while it is still starting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const first = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      const fake = harness.created[1]!;
      harness.revealed.length = 0;

      // A double click: the first page has not committed, so there is no URL yet.
      fake.navigateTo("");
      fake.raw.webContents.isLoadingMainFrame.mockReturnValue(true);
      const second = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      assert.equal(second, first);
      assert.equal(fake.raw.loadURL.mock.calls.length, 1);
      assert.deepEqual(harness.revealed, []);

      // Once it has shown itself, asking again brings it forward.
      fake.navigateTo(ATLAS_URL);
      fake.raw.webContents.isLoadingMainFrame.mockReturnValue(false);
      fake.emit("ready-to-show");
      yield* Effect.promise(() => Promise.resolve());
      harness.revealed.length = 0;
      fake.raw.webContents.isLoadingMainFrame.mockReturnValue(true);
      yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });
      assert.deepEqual(harness.revealed, [first]);
      assert.equal(fake.raw.loadURL.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends menu actions to the project window the user is working in", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const desktopWindow = yield* openMain;
      const project = yield* desktopWindow.openProjectWindow({ projectKey: "atlas" });

      harness.focus(project);
      yield* desktopWindow.dispatchMenuAction("paste-as-text", { reveal: false });
      assert.deepEqual(harness.created[1]?.raw.webContents.send.mock.calls, [
        [MENU_ACTION_CHANNEL, "paste-as-text"],
      ]);
      assert.equal(harness.created[0]?.raw.webContents.send.mock.calls.length, 0);

      // A focused helper window is not an app window: the main window gets it.
      harness.focus(makeFakeWindow(99).window);
      yield* desktopWindow.dispatchMenuAction("paste-as-text", { reveal: false });
      assert.deepEqual(harness.created[0]?.raw.webContents.send.mock.calls, [
        [MENU_ACTION_CHANNEL, "paste-as-text"],
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("resolveProjectWindowFallbackBounds", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };

  it("offsets from the main window when the result fits on a display", () => {
    assert.deepEqual(
      DesktopWindow.resolveProjectWindowFallbackBounds(
        { x: 100, y: 60, width: 1400, height: 900 },
        [display],
      ),
      { x: 132, y: 92, width: 1100, height: 780 },
    );
  });

  it("centers when there is no main window or the offset would leave the display", () => {
    assert.isNull(DesktopWindow.resolveProjectWindowFallbackBounds(null, [display]));
    assert.isNull(
      DesktopWindow.resolveProjectWindowFallbackBounds(
        { x: 800, y: 280, width: 1100, height: 780 },
        [display],
      ),
    );
    assert.isNull(
      DesktopWindow.resolveProjectWindowFallbackBounds(
        { x: 100, y: 60, width: 1100, height: 780 },
        [],
      ),
    );
  });
});

describe("isProjectWindowOnUrl", () => {
  const project = "studio://app/#/projects/acme%2Fmono";

  it("accepts the project route, its sub-routes and its search", () => {
    assert.isTrue(DesktopWindow.isProjectWindowOnUrl(project, project));
    assert.isTrue(DesktopWindow.isProjectWindowOnUrl(`${project}/plan`, project));
    assert.isTrue(DesktopWindow.isProjectWindowOnUrl(`${project}?tab=usage`, project));
  });

  it("rejects another route and a longer key with the same start", () => {
    assert.isFalse(DesktopWindow.isProjectWindowOnUrl("studio://app/#/settings", project));
    assert.isFalse(DesktopWindow.isProjectWindowOnUrl(`${project}%3A%3Apackages%2Fweb`, project));
    assert.isFalse(DesktopWindow.isProjectWindowOnUrl(`${project}-server`, project));
  });
});

describe("resolveProjectWindowTitle", () => {
  it("leads with the project name and falls back to the app name", () => {
    assert.equal(DesktopWindow.resolveProjectWindowTitle("Studio", "Atlas"), "Atlas - Studio");
    assert.equal(DesktopWindow.resolveProjectWindowTitle("Studio", "  "), "Studio");
    assert.equal(DesktopWindow.resolveProjectWindowTitle("Studio", undefined), "Studio");
  });
});
