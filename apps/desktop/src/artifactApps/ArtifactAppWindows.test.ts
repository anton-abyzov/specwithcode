import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const idFor = (index: number) => index.toString(16).padStart(32, "0");
const ID = "a".repeat(32);
const WINDOW_URL = `studio://app/#/artifact-app/${ID}`;

describe("canOpenAnotherArtifactAppWindow", () => {
  it("allows up to ten windows", () => {
    assert.isTrue(ArtifactAppWindows.canOpenAnotherArtifactAppWindow(0));
    assert.isTrue(ArtifactAppWindows.canOpenAnotherArtifactAppWindow(9));
    assert.isFalse(ArtifactAppWindows.canOpenAnotherArtifactAppWindow(10));
    assert.isFalse(ArtifactAppWindows.canOpenAnotherArtifactAppWindow(11));
  });
});

describe("isArtifactAppWindowNavigationAllowed", () => {
  const allowed = (targetUrl: string) =>
    ArtifactAppWindows.isArtifactAppWindowNavigationAllowed({ windowUrl: WINDOW_URL, targetUrl });

  it("allows only the window's own route", () => {
    assert.isTrue(allowed(WINDOW_URL));
  });

  it("refuses other routes, origins, schemes and credentials", () => {
    for (const target of [
      "studio://app/",
      "studio://app/#/",
      `studio://app/#/artifact-app/${"b".repeat(32)}`,
      `studio://app/?x=1#/artifact-app/${ID}`,
      `studio://app/index.html#/artifact-app/${ID}`,
      `studio-dev://app/#/artifact-app/${ID}`,
      `studio://other/#/artifact-app/${ID}`,
      `studio://user@app/#/artifact-app/${ID}`,
      "https://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "not a url",
    ]) {
      assert.isFalse(allowed(target), target);
    }
  });

  it("refuses everything when the window URL has no host", () => {
    assert.isFalse(
      ArtifactAppWindows.isArtifactAppWindowNavigationAllowed({
        windowUrl: "data:text/html,x",
        targetUrl: "data:text/html,x",
      }),
    );
  });
});

describe("isArtifactAppFrameNavigationAllowed", () => {
  const VERSION = "http://127.0.0.1:3773/assets/page?token=t";
  const allowed = (targetUrl: string, versionUrl: string | null = VERSION) =>
    ArtifactAppWindows.isArtifactAppFrameNavigationAllowed({ versionUrl, targetUrl });

  it("allows only the version's own address, whatever its fragment", () => {
    assert.isTrue(allowed(VERSION));
    assert.isTrue(allowed(`${VERSION}#theme=dark`));
  });

  it("refuses every other address and everything when no version is set", () => {
    for (const target of [
      "http://127.0.0.1:3773/assets/page",
      "http://127.0.0.1:3773/assets/page?token=other",
      "http://127.0.0.1:3773/assets/page?token=t&x=1",
      "http://127.0.0.1:3773/assets/other?token=t",
      "http://127.0.0.1:3774/assets/page?token=t",
      "https://127.0.0.1:3773/assets/page?token=t",
      "http://localhost:3773/assets/page?token=t",
      "http://user@127.0.0.1:3773/assets/page?token=t",
      "https://example.com/",
      "data:text/html,<p>x</p>",
      "blob:null/0f8fad5b-d9cb-469f-a165-70867728950e",
      "about:blank",
      "about:srcdoc",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "studio://app/",
      "not a url",
      "",
    ]) {
      assert.isFalse(allowed(target), target);
    }
    assert.isFalse(allowed(VERSION, null));
  });
});

describe("artifactAppExternalUrl", () => {
  it("passes web addresses only", () => {
    assert.equal(
      ArtifactAppWindows.artifactAppExternalUrl("https://example.com/a"),
      "https://example.com/a",
    );
    assert.equal(
      ArtifactAppWindows.artifactAppExternalUrl("http://example.com"),
      "http://example.com/",
    );
    for (const url of [
      "vscode://file/x",
      "zed://ssh/x",
      "file:///x",
      "studio://app/",
      "mailto:a@b",
      "x",
    ]) {
      assert.isNull(ArtifactAppWindows.artifactAppExternalUrl(url), url);
    }
  });
});

type Listener = (...args: Array<any>) => unknown;

interface FakeWindow {
  readonly window: Electron.BrowserWindow;
  readonly options: Electron.BrowserWindowConstructorOptions;
  readonly windowListeners: Map<string, Array<Listener>>;
  readonly contentsListeners: Map<string, Array<Listener>>;
  readonly loaded: Array<string>;
  readonly appDetails: Array<Electron.AppDetailsOptions>;
  openHandler: ((details: { url: string }) => { action: string }) | undefined;
  destroyed: boolean;
  closed: number;
}

let nextWebContentsId = 100;

const fakeWindow = (options: Electron.BrowserWindowConstructorOptions): FakeWindow => {
  const windowListeners = new Map<string, Array<Listener>>();
  const contentsListeners = new Map<string, Array<Listener>>();
  const add = (map: Map<string, Array<Listener>>) => (event: string, listener: Listener) => {
    map.set(event, [...(map.get(event) ?? []), listener]);
  };
  const fake: FakeWindow = {
    options,
    windowListeners,
    contentsListeners,
    loaded: [],
    appDetails: [],
    openHandler: undefined,
    destroyed: false,
    closed: 0,
    window: undefined as unknown as Electron.BrowserWindow,
  };
  const webContents = {
    id: nextWebContentsId++,
    on: add(contentsListeners),
    once: add(contentsListeners),
    setWindowOpenHandler: (handler: FakeWindow["openHandler"]) => {
      fake.openHandler = handler;
    },
  };
  (fake as { window: unknown }).window = {
    webContents,
    on: add(windowListeners),
    once: add(windowListeners),
    isDestroyed: () => fake.destroyed,
    setAppDetails: (details: Electron.AppDetailsOptions) => fake.appDetails.push(details),
    loadURL: (url: string) => {
      fake.loaded.push(url);
      return Promise.resolve();
    },
    close: () => {
      fake.closed += 1;
      fake.destroyed = true;
      for (const listener of windowListeners.get("closed") ?? []) listener();
    },
  };
  return fake;
};

const app = (installId: string): DesktopArtifactApp => ({
  installId,
  name: `Board ${installId.slice(-2)}`,
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Board",
  installedAt: "2026-11-24T12:00:00.000Z",
});

const setup = (input: {
  readonly platform?: NodeJS.Platform;
  readonly known: ReadonlyArray<string>;
}) => {
  const created: Array<FakeWindow> = [];
  const registered: Array<{ window: Electron.BrowserWindow; role: string | undefined }> = [];
  const revealed: Array<Electron.BrowserWindow> = [];
  const external: Array<string> = [];
  const messages: Array<Electron.MessageBoxOptions> = [];
  const apps = new Map(input.known.map((installId) => [installId, app(installId)]));

  const layer = ArtifactAppWindows.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            platform: input.platform ?? "darwin",
            isDevelopment: false,
            preloadPath: "/app/preload.js",
            appUserModelId: "com.specweave.studio",
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.mock(DesktopAssets.DesktopAssets)({
          iconPaths: Effect.succeed({
            ico: Option.some("/app/icon.ico"),
            icns: Option.some("/app/icon.icns"),
            png: Option.some("/app/icon.png"),
          }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          create: (options) =>
            Effect.sync(() => {
              const fake = fakeWindow(options);
              created.push(fake);
              return fake.window;
            }),
          registerSecondary: (window, options) =>
            Effect.sync(() => {
              registered.push({ window, role: options?.role });
            }),
          reveal: (window) =>
            Effect.sync(() => {
              revealed.push(window);
            }),
        }),
        Layer.mock(ElectronDialog.ElectronDialog)({
          showMessageBox: (options) =>
            Effect.sync(() => {
              messages.push(options);
              return { response: 0, checkboxChecked: false };
            }),
        }),
        Layer.mock(ElectronShell.ElectronShell)({
          openExternal: (url) =>
            Effect.sync(() => {
              external.push(String(url));
              return true;
            }),
        }),
        Layer.mock(ElectronTheme.ElectronTheme)({ shouldUseDarkColors: Effect.succeed(true) }),
        Layer.mock(ArtifactAppRecords.ArtifactAppRecords)({
          get: (installId) => Effect.succeed(Option.fromNullishOr(apps.get(installId))),
        }),
      ),
    ),
  );
  return { layer, created, registered, revealed, external, messages };
};

const emit = (map: Map<string, Array<Listener>>, event: string, ...args: Array<unknown>) => {
  for (const listener of map.get(event) ?? []) listener(...args);
};

describe("ArtifactAppWindows", () => {
  it.effect("opens a sandboxed window locked to the install's route", () => {
    const fixture = setup({ known: [ID] });
    return Effect.gen(function* () {
      const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
      assert.equal(yield* windows.open(ID), "opened");
      const [fake] = fixture.created;
      assert.isDefined(fake);
      if (fake === undefined) return;

      const { options } = fake;
      assert.equal(options.title, "Board aa");
      assert.equal(options.width, 1000);
      assert.equal(options.height, 720);
      assert.equal(options.minWidth, 360);
      assert.equal(options.minHeight, 300);
      assert.equal(options.show, false);
      assert.deepEqual(options.webPreferences, {
        preload: "/app/preload.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: ["--studio-window-role=artifact-app", `--studio-artifact-app=${ID}`],
      });
      assert.notProperty(options, "icon");
      assert.notProperty(options, "titleBarOverlay");
      // The header runs under the buttons, as in the main window.
      assert.equal(options.titleBarStyle, "hiddenInset");
      assert.deepEqual(options.trafficLightPosition, { x: 16, y: 15 });
      // Registered as a page window, so it never stands in for the app.
      assert.deepEqual(fixture.registered, [{ window: fake.window, role: "page" }]);
      assert.deepEqual(fake.loaded, [WINDOW_URL]);
      assert.deepEqual(fake.appDetails, []);
      assert.deepEqual(
        yield* windows.installIdForWebContents(fake.window.webContents.id),
        Option.some(ID),
      );

      // Navigation away is stopped and web addresses go to the browser.
      let prevented = 0;
      const event = { preventDefault: () => (prevented += 1) };
      emit(fake.contentsListeners, "will-navigate", event, WINDOW_URL);
      assert.equal(prevented, 0);
      emit(fake.contentsListeners, "will-navigate", event, "https://example.com/next");
      emit(
        fake.contentsListeners,
        "will-redirect",
        { ...event, url: "studio://app/#/", isMainFrame: true },
        "studio://app/#/",
      );
      // A frame inside the page redirecting is stopped and opens nothing.
      emit(
        fake.contentsListeners,
        "will-redirect",
        { ...event, url: "https://example.com/framed", isMainFrame: false },
        "https://example.com/framed",
      );
      assert.equal(prevented, 3);
      emit(fake.contentsListeners, "will-navigate", event, "file:///etc/hosts");
      assert.equal(prevented, 4);
      assert.deepEqual(fake.openHandler?.({ url: "https://example.com/popup" }), {
        action: "deny",
      });
      assert.deepEqual(fake.openHandler?.({ url: "vscode://file/x" }), { action: "deny" });
      emit(fake.windowListeners, "page-title-updated", event);
      assert.equal(prevented, 5);
      yield* Effect.yieldNow;
      assert.deepEqual(fixture.external, ["https://example.com/next", "https://example.com/popup"]);

      // Shown once its page is ready.
      emit(fake.windowListeners, "ready-to-show");
      yield* Effect.yieldNow;
      assert.deepEqual(fixture.revealed, [fake.window]);

      // A second open focuses the same window.
      assert.equal(yield* windows.open(ID), "focused");
      assert.equal(fixture.created.length, 1);
      assert.deepEqual(fixture.revealed, [fake.window, fake.window]);

      yield* windows.close(ID);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.equal(fake.closed, 1);
      assert.deepEqual(
        yield* windows.installIdForWebContents(fake.window.webContents.id),
        Option.none(),
      );
      assert.equal(yield* windows.open(ID), "opened");
      assert.equal(fixture.created.length, 2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("holds every frame in the window to the version it shows", () => {
    const fixture = setup({ known: [ID] });
    const VERSION = "http://127.0.0.1:3773/assets/page?token=t";
    return Effect.gen(function* () {
      const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
      yield* windows.open(ID);
      const [fake] = fixture.created;
      if (fake === undefined) return assert.fail("no window");
      const blocked = (eventName: string, url: string, isMainFrame: unknown = false) => {
        let prevented = false;
        emit(fake.contentsListeners, eventName, {
          url,
          isMainFrame,
          preventDefault: () => {
            prevented = true;
          },
        });
        return prevented;
      };
      const landed = (url: unknown, isMainFrame = false) =>
        emit(fake.contentsListeners, "did-frame-navigate", {}, url, 200, "OK", isMainFrame);

      // Before a version is set no frame may load anything, the page's own address included.
      assert.isTrue(blocked("will-frame-navigate", VERSION));
      assert.isFalse(yield* windows.isFrameOnVersion(ID));

      yield* windows.setVersionUrl(ID, Option.some(`${VERSION}#theme=dark`));
      assert.isTrue(yield* windows.isFrameOnVersion(ID));
      // The frame's own load, a reload and a theme fragment are the version.
      assert.isFalse(blocked("will-frame-navigate", VERSION));
      assert.isFalse(blocked("will-frame-navigate", `${VERSION}#theme=light`));
      assert.isFalse(blocked("will-redirect", VERSION));
      // A script, a form, a refresh or a nested frame going anywhere else is stopped.
      for (const target of [
        "https://example.com/next",
        "http://127.0.0.1:3773/assets/other?token=t",
        "http://127.0.0.1:3773/assets/page",
        "data:text/html,<p>x</p>",
        "blob:null/0f8fad5b-d9cb-469f-a165-70867728950e",
        "about:blank",
        "not a url",
      ]) {
        assert.isTrue(blocked("will-frame-navigate", target), target);
        assert.isTrue(blocked("will-redirect", target), target);
      }
      // An event that does not say which frame it is for is treated as a frame's.
      for (const unknown of [null, "yes", 0, 1]) {
        assert.isTrue(blocked("will-frame-navigate", "https://example.com/next", unknown));
        assert.isTrue(blocked("will-redirect", "https://example.com/next", unknown));
      }
      // The window's own document is not this guard's: `will-navigate` decides it.
      assert.isFalse(blocked("will-frame-navigate", "https://example.com/next", true));
      // Stopped frame navigations open nothing in the browser.
      yield* Effect.yieldNow;
      assert.deepEqual(fixture.external, []);

      // The version loading, and inline frames, leave the window on its version.
      landed(`${VERSION}#theme=dark`);
      landed("about:srcdoc");
      landed("about:blank");
      landed("https://example.com/top", true);
      assert.isTrue(yield* windows.isFrameOnVersion(ID));
      // A frame seen anywhere else ends it, until a version is set again.
      landed("https://example.com/next");
      assert.isFalse(yield* windows.isFrameOnVersion(ID));
      landed(VERSION);
      assert.isFalse(yield* windows.isFrameOnVersion(ID));
      yield* windows.setVersionUrl(ID, Option.some(VERSION));
      assert.isTrue(yield* windows.isFrameOnVersion(ID));
      landed(undefined);
      assert.isFalse(yield* windows.isFrameOnVersion(ID));

      // An address that is not a web address sets no version at all.
      for (const bad of ["file:///etc/passwd", "studio://app/", "data:text/html,x", "nope"]) {
        yield* windows.setVersionUrl(ID, Option.some(bad));
        assert.isFalse(yield* windows.isFrameOnVersion(ID), bad);
        assert.isTrue(blocked("will-frame-navigate", bad), bad);
      }
      yield* windows.setVersionUrl(ID, Option.some(VERSION));
      yield* windows.setVersionUrl(ID, Option.none());
      assert.isTrue(blocked("will-frame-navigate", VERSION));

      // Unknown installs have no window and no version.
      const other = "b".repeat(32);
      yield* windows.setVersionUrl(other, Option.some(VERSION));
      assert.isFalse(yield* windows.isFrameOnVersion(other));
      assert.deepEqual(yield* windows.windowForInstall(other), Option.none());
      assert.deepEqual(yield* windows.windowForInstall(ID), Option.some(fake.window));

      // Closing tells the listeners once and forgets the version.
      const closed: Array<string> = [];
      yield* windows.onClosed(() => {
        throw new Error("a listener that fails");
      });
      yield* windows.onClosed((installId) => closed.push(installId));
      yield* windows.setVersionUrl(ID, Option.some(VERSION));
      fake.window.close();
      assert.deepEqual(closed, [ID]);
      assert.isFalse(yield* windows.isFrameOnVersion(ID));
      assert.isTrue(blocked("will-frame-navigate", VERSION));

      // The install's next window starts with no version: the closed one's does not carry over.
      assert.equal(yield* windows.open(ID), "opened");
      const next = fixture.created[1];
      if (next === undefined) return assert.fail("no second window");
      assert.isFalse(yield* windows.isFrameOnVersion(ID));
      let prevented = false;
      emit(next.contentsListeners, "will-frame-navigate", {
        url: VERSION,
        isMainFrame: false,
        preventDefault: () => {
          prevented = true;
        },
      });
      assert.isTrue(prevented);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("gives each window its own taskbar identity and icon on Windows", () => {
    const fixture = setup({ platform: "win32", known: [ID] });
    return Effect.gen(function* () {
      const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
      yield* windows.open(ID);
      const [fake] = fixture.created;
      assert.deepEqual(fake?.appDetails, [{ appId: `com.specweave.studio.artifactapp.${ID}` }]);
      assert.equal(fake?.options.icon, "/app/icon.ico");
      // The app's appearance sync updates this overlay on every app window.
      assert.equal(fake?.options.titleBarStyle, "hidden");
      assert.deepEqual(fake?.options.titleBarOverlay, {
        color: "#01000000",
        height: 40,
        symbolColor: "#f8fafc",
      });
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("ignores installs that are not recorded or malformed", () => {
    const fixture = setup({ known: [] });
    return Effect.gen(function* () {
      const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
      assert.equal(yield* windows.open(ID), "unknown");
      assert.equal(yield* windows.open("../../etc"), "unknown");
      assert.equal(fixture.created.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("opens at most ten windows and says so on the eleventh", () => {
    const ids = Array.from({ length: 11 }, (_, index) => idFor(index + 1));
    const fixture = setup({ known: ids });
    return Effect.gen(function* () {
      const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
      const results = yield* Effect.forEach(ids, (installId) => windows.open(installId));
      assert.deepEqual(results, [...Array.from({ length: 10 }, () => "opened"), "limit"]);
      assert.equal(fixture.created.length, 10);
      yield* Effect.yieldNow;
      assert.equal(fixture.messages.length, 1);
      assert.equal(fixture.messages[0]?.message, "Too many installed pages are open");

      // Closing one makes room.
      fixture.created[0]?.window.close();
      assert.equal(yield* windows.open(ids[10]!), "opened");
    }).pipe(Effect.provide(fixture.layer));
  });
});
