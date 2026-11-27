import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppShimRecords from "./ArtifactAppShimRecords.ts";
import * as ArtifactAppShims from "./ArtifactAppShims.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
const HASH = "c".repeat(40);
const BUNDLE = "/Users/test/Applications/SpecWithCode Apps/Board.app";

const recorded = (installId: string): DesktopArtifactApp => ({
  installId,
  name: "Board",
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Board",
  installedAt: "2026-11-27T12:00:00.000Z",
});

interface FakeShim {
  readonly host: Electron.AppShimHost;
  readonly quits: { count: number };
  readonly requirements: Array<string>;
  readonly emit: (event: string) => void;
  connected: boolean;
}

const fakeShim = (input: { bundlePath: string; cdHash: string }): FakeShim => {
  const listeners = new Map<string, Array<() => void>>();
  const quits = { count: 0 };
  const requirements: Array<string> = [];
  const shim: FakeShim = {
    quits,
    requirements,
    connected: true,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    host: undefined as unknown as Electron.AppShimHost,
  };
  (shim as { host: Electron.AppShimHost }).host = {
    bundlePath: input.bundlePath,
    pid: 4242,
    isConnected: () => shim.connected,
    quit: () => {
      quits.count += 1;
      shim.connected = false;
    },
    satisfiesCodeRequirement: (requirement: string) => {
      requirements.push(requirement);
      return requirement === `cdhash H"${input.cdHash}"`;
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  } as unknown as Electron.AppShimHost;
  return shim;
};

const setup = (
  input: {
    readonly platform?: NodeJS.Platform;
    readonly withShims?: boolean;
    readonly mainOpen?: boolean;
    readonly reopen?: ReadonlyArray<string>;
    readonly openResult?: ArtifactAppWindows.ArtifactAppWindowOpenResult;
    readonly startFails?: boolean;
  } = {},
) => {
  const state = {
    main: input.mainOpen ?? true,
    reopen: [...(input.reopen ?? [])],
    written: [] as Array<ReadonlyArray<string>>,
    openInShim: [] as Array<string>,
    started: [] as Array<string>,
    upgrades: 0,
    launched: [] as Array<string>,
    revealed: [] as Array<string>,
    uninstalled: [] as Array<string>,
    messages: [] as Array<string>,
    menus: [] as Array<ReadonlyArray<Electron.MenuItemConstructorOptions>>,
    shimIds: [] as Array<string>,
  };
  const appListeners = new Map<string, Array<(...args: Array<any>) => void>>();
  const connected: Array<(shim: Electron.AppShimHost) => void> = [];
  const mismatch: Array<(bundlePath: string) => void> = [];
  const beforeQuit: Array<() => void> = [];
  const closed: Array<(installId: string) => void> = [];

  const layer = ArtifactAppShims.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ArtifactAppInstaller.ArtifactAppInstallerHost, {
          platform: input.platform ?? "darwin",
          appShim:
            input.withShims === false
              ? Option.none()
              : Option.some({
                  loaderPath: "/Applications/SpecWithCode.app/loader",
                  hostAppPath: "/Applications/SpecWithCode.app",
                  hostBundleId: "com.specweave.studio",
                  serverName: "com.specweave.studio.artifact-apps",
                  minimumSystemVersion: "13.0",
                }),
          showMessageBox: (_owner: unknown, options: Electron.MessageBoxOptions) =>
            Effect.sync(() => {
              state.messages.push(`${options.message} ${options.detail ?? ""}`);
              return 0;
            }),
        } as unknown as ArtifactAppInstaller.ArtifactAppInstallerHost["Service"]),
        Layer.mock(ArtifactAppShims.ArtifactAppShimServer)({
          start: (name) =>
            input.startFails
              ? Effect.fail(
                  new ArtifactAppShims.ArtifactAppShimServerStartError({ cause: "no server" }),
                )
              : Effect.sync(() => {
                  state.started.push(name);
                }),
          onConnected: (listener) => Effect.sync(() => void connected.push(listener)),
          onVersionMismatch: (listener) => Effect.sync(() => void mismatch.push(listener)),
          onBeforeQuit: (listener) => Effect.sync(() => void beforeQuit.push(listener)),
          setMenu: (_shim, template) => Effect.sync(() => void state.menus.push(template)),
        }),
        Layer.mock(ElectronApp.ElectronApp)({
          whenReady: Effect.void,
          on: (eventName, listener) =>
            Effect.sync(() => {
              appListeners.set(eventName, [
                ...(appListeners.get(eventName) ?? []),
                listener as (...args: Array<any>) => void,
              ]);
            }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Effect.sync(() =>
            state.main ? Option.some({} as Electron.BrowserWindow) : Option.none(),
          ),
        }),
        Layer.mock(ArtifactAppInstaller.ArtifactAppInstaller)({
          shimInstallFor: (bundlePath) =>
            Effect.succeed(
              bundlePath === BUNDLE ? Option.some({ installId: ID, cdHash: HASH }) : Option.none(),
            ),
          upgradeLaunchers: Effect.sync(() => {
            state.upgrades += 1;
          }),
          launch: (installId) =>
            Effect.sync(() => {
              state.launched.push(installId);
              return true;
            }),
          reveal: (installId) =>
            Effect.sync(() => {
              state.revealed.push(installId);
              return true;
            }),
          uninstall: (installId) =>
            Effect.sync(() => {
              state.uninstalled.push(installId);
              return true;
            }),
        }),
        Layer.mock(ArtifactAppWindows.ArtifactAppWindows)({
          open: (installId, options) =>
            Effect.sync(() => {
              if (options?.appShim !== undefined) state.openInShim.push(installId);
              if ((input.openResult ?? "opened") === "opened") state.shimIds = [installId];
              return input.openResult ?? "opened";
            }),
          onClosed: (listener) => Effect.sync(() => void closed.push(listener)),
          shimInstallIds: Effect.sync(() => state.shimIds),
        }),
        Layer.mock(ArtifactAppRecords.ArtifactAppRecords)({
          get: (installId) =>
            Effect.succeed(installId === ID ? Option.some(recorded(ID)) : Option.none()),
        }),
        Layer.mock(ArtifactAppShimRecords.ArtifactAppShimRecords)({
          writeReopen: (ids) => Effect.sync(() => void state.written.push([...ids])),
          takeReopen: Effect.sync(() => state.reopen.splice(0)),
        }),
      ),
    ),
  );
  const emitApp = (event: string, ...args: Array<unknown>) => {
    for (const listener of appListeners.get(event) ?? []) listener(...args);
  };
  return {
    layer,
    state,
    emitApp,
    connect: (shim: FakeShim) => {
      for (const listener of connected) listener(shim.host);
    },
    mismatch: (bundlePath: string) => {
      for (const listener of mismatch) listener(bundlePath);
    },
    quit: () => {
      for (const listener of beforeQuit) listener();
    },
    close: (installId: string) => {
      for (const listener of closed) listener(installId);
    },
    listenerCount: () => connected.length,
  };
};

// Lets forked fibers run.
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("artifactAppShimCodeRequirement", () => {
  it("accepts only a 40-hex hash", () => {
    assert.equal(ArtifactAppShims.artifactAppShimCodeRequirement(HASH), `cdhash H"${HASH}"`);
    for (const bad of ["", "C".repeat(40), `${HASH}"`, `${"c".repeat(39)}" or anchor apple`]) {
      assert.throws(() => ArtifactAppShims.artifactAppShimCodeRequirement(bad));
    }
  });
});

describe("artifactAppShimMenuTemplate", () => {
  it("names the app menu after the page and wires its own actions", () => {
    const calls: Array<string> = [];
    const template = ArtifactAppShims.artifactAppShimMenuTemplate("Board", {
      showInFinder: () => calls.push("finder"),
      uninstall: () => calls.push("uninstall"),
    });
    assert.deepEqual(
      template.map((menu) => menu.label),
      ["Board", "Edit", "View", "Window"],
    );
    const appMenu = template[0]!.submenu as Array<Electron.MenuItemConstructorOptions>;
    assert.deepEqual(
      appMenu.filter((item) => item.role !== undefined).map((item) => item.role),
      ["about", "hide", "hideOthers", "unhide", "quit"],
    );
    assert.equal(appMenu.find((item) => item.role === "quit")?.label, "Quit Board");
    for (const item of appMenu) {
      (item.click as (() => void) | undefined)?.();
    }
    assert.deepEqual(calls, ["finder", "uninstall"]);
  });
});

describe("ArtifactAppShims", () => {
  it.effect("does nothing off macOS or without a shim loader", () =>
    Effect.gen(function* () {
      for (const fixture of [setup({ platform: "win32" }), setup({ withShims: false })]) {
        yield* Layer.build(fixture.layer);
        yield* settle;
        assert.deepEqual(fixture.state.started, []);
        assert.equal(fixture.listenerCount(), 0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("starts the server, upgrades launchers, then opens a verified shim's window", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      assert.deepEqual(fixture.state.started, ["com.specweave.studio.artifact-apps"]);
      assert.equal(fixture.state.upgrades, 1);

      const shim = fakeShim({ bundlePath: BUNDLE, cdHash: HASH });
      fixture.connect(shim);
      yield* settle;
      assert.deepEqual(shim.requirements, [`cdhash H"${HASH}"`]);
      assert.deepEqual(fixture.state.openInShim, [ID]);
      assert.equal(shim.quits.count, 0);
      assert.equal(fixture.state.menus.length, 1);
      assert.equal(fixture.state.menus[0]![0]!.label, "Board");
      // The open page is remembered for a restart.
      assert.deepEqual(fixture.state.written.at(-1), [ID]);

      // Its Dock icon clicked: the window comes back in the same shim.
      shim.emit("activate");
      yield* settle;
      assert.deepEqual(fixture.state.openInShim, [ID, ID]);
    }).pipe(Effect.scoped);
  });

  it.effect("turns away an unknown bundle and one whose running hash differs", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      const stranger = fakeShim({ bundlePath: "/tmp/Evil.app", cdHash: HASH });
      const changed = fakeShim({ bundlePath: BUNDLE, cdHash: "d".repeat(40) });
      fixture.connect(stranger);
      fixture.connect(changed);
      yield* settle;
      assert.equal(stranger.quits.count, 1);
      assert.deepEqual(stranger.requirements, []);
      assert.equal(changed.quits.count, 1);
      assert.deepEqual(fixture.state.openInShim, []);
      assert.deepEqual(fixture.state.menus, []);
    }).pipe(Effect.scoped);
  });

  it.effect("quits a shim that got no window", () => {
    const fixture = setup({ openResult: "limit" });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      const shim = fakeShim({ bundlePath: BUNDLE, cdHash: HASH });
      fixture.connect(shim);
      yield* settle;
      assert.equal(shim.quits.count, 1);
    }).pipe(Effect.scoped);
  });

  it.effect("waits for the main window, then reopens last session's pages", () => {
    const fixture = setup({ mainOpen: false, reopen: [ID, OTHER] });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      const shim = fakeShim({ bundlePath: BUNDLE, cdHash: HASH });
      fixture.connect(shim);
      yield* settle;
      assert.deepEqual(fixture.state.openInShim, []);
      assert.deepEqual(fixture.state.launched, []);

      fixture.state.main = true;
      fixture.emitApp("browser-window-focus", {}, {});
      yield* settle;
      assert.deepEqual(fixture.state.launched, [ID, OTHER]);
      assert.deepEqual(fixture.state.openInShim, [ID]);
    }).pipe(Effect.scoped);
  });

  it.effect("keeps the reopen list when the app quits, and updates it on close", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      fixture.connect(fakeShim({ bundlePath: BUNDLE, cdHash: HASH }));
      yield* settle;
      const writes = fixture.state.written.length;

      fixture.state.shimIds = [];
      fixture.close(ID);
      yield* settle;
      assert.deepEqual(fixture.state.written.at(-1), []);

      fixture.state.shimIds = [ID];
      fixture.quit();
      fixture.state.shimIds = [];
      fixture.close(ID);
      yield* settle;
      assert.equal(fixture.state.written.length, writes + 1);
    }).pipe(Effect.scoped);
  });

  it.effect("shows the update message once per bundle, only for an installed page", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      fixture.mismatch(BUNDLE);
      fixture.mismatch(BUNDLE);
      fixture.mismatch("/tmp/Evil.app");
      yield* settle;
      assert.deepEqual(fixture.state.messages, [
        "Board could not open because SpecWithCode was updated. Quit and reopen SpecWithCode, then open Board again.",
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("leaves installed pages as windows when the server cannot start", () => {
    const fixture = setup({ startFails: true, reopen: [ID] });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      yield* settle;
      assert.equal(fixture.state.upgrades, 0);
      assert.deepEqual(fixture.state.launched, []);
    }).pipe(Effect.scoped);
  });
});
