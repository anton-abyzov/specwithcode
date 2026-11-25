import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppRouting from "./ArtifactAppRouting.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
const url = (installId: string, scheme = "studio") => `${scheme}://app/artifact-app/${installId}`;

describe("resolveArtifactAppLaunch", () => {
  const resolve = (source: ArtifactAppRouting.ArtifactAppLaunchSource, known = [ID]) =>
    ArtifactAppRouting.resolveArtifactAppLaunch({
      source,
      scheme: "studio",
      knownInstallIds: known,
    });

  it("returns a recorded install from a URL or arguments", () => {
    assert.equal(resolve({ url: url(ID) }), ID);
    assert.equal(resolve({ url: `${url(ID)}/` }), ID);
    assert.equal(resolve({ argv: ["/Applications/SpecWithCode.app", "--flag", url(ID)] }), ID);
  });

  it("ignores installs that are not recorded", () => {
    assert.isNull(resolve({ url: url(OTHER) }));
    assert.isNull(resolve({ argv: [url(OTHER)] }));
    assert.isNull(resolve({ url: url(ID) }, []));
  });

  it("ignores anything that is not a well-formed launch URL", () => {
    for (const value of [
      url(ID, "studio-dev"),
      `STUDIO://app/artifact-app/${ID}`,
      `studio://app/artifact-app/${ID}?x=1`,
      `studio://app/artifact-app/${ID}#x`,
      `studio://app/artifact-app/${ID.toUpperCase()}`,
      `studio://app/artifact-app/${ID}/extra`,
      `studio://other/artifact-app/${ID}`,
      "studio://app/",
      "https://example.com/",
    ]) {
      assert.isNull(resolve({ url: value }), value);
      assert.isNull(resolve({ argv: [value] }), value);
    }
  });
});

type OpenUrlListener = (event: { preventDefault(): void }, url: string) => void;

const fakeEmitter = () => {
  const listeners = new Set<OpenUrlListener>();
  return {
    listeners,
    on: (_event: "open-url", listener: OpenUrlListener) => listeners.add(listener),
    removeListener: (_event: "open-url", listener: OpenUrlListener) => listeners.delete(listener),
    emit: (value: string) => {
      let prevented = false;
      for (const listener of listeners)
        listener({ preventDefault: () => (prevented = true) }, value);
      return prevented;
    },
  };
};

describe("bufferEarlyArtifactAppLaunches", () => {
  it("keeps launch URLs for either build until taken, and only those", () => {
    const emitter = fakeEmitter();
    const early = ArtifactAppRouting.bufferEarlyArtifactAppLaunches(emitter);
    assert.isTrue(emitter.emit(url(ID)));
    assert.isTrue(emitter.emit(url(OTHER, "studio-dev")));
    assert.isFalse(emitter.emit("studio://app/settings"));
    assert.deepEqual(early.take(), [url(ID), url(OTHER, "studio-dev")]);
    assert.deepEqual(early.take(), []);
    early.dispose();
    assert.equal(emitter.listeners.size, 0);
  });
});

const recorded = (installId: string): DesktopArtifactApp => ({
  installId,
  name: "Board",
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Board",
  installedAt: "2026-11-24T12:00:00.000Z",
});

const setup = (input: { readonly argv: ReadonlyArray<string>; readonly mainOpen: boolean }) => {
  const appListeners = new Map<string, Array<(...args: Array<any>) => void>>();
  const opened: Array<string> = [];
  const state = { main: input.mainOpen };
  const earlyEmitter = fakeEmitter();
  const early = ArtifactAppRouting.bufferEarlyArtifactAppLaunches(earlyEmitter);
  const layer = ArtifactAppRouting.layer(early).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            isDevelopment: false,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.mock(ElectronApp.ElectronApp)({
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
        Layer.mock(ArtifactAppRecords.ArtifactAppRecords)({
          list: Effect.succeed([recorded(ID)]),
        }),
        Layer.mock(ArtifactAppWindows.ArtifactAppWindows)({
          open: (installId) =>
            Effect.sync(() => {
              opened.push(installId);
              return "opened" as const;
            }),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcessArguments, input.argv)),
  );
  const emit = (event: string, ...args: Array<unknown>) => {
    for (const listener of appListeners.get(event) ?? []) listener(...args);
  };
  return { layer, opened, state, emit, earlyEmitter };
};

// Lets forked launch fibers run.
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("ArtifactAppRouting", () => {
  it.effect("opens recorded installs from open-url and a second launch, nothing else", () => {
    const fixture = setup({ argv: [], mainOpen: true });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      let prevented = false;
      const event = { preventDefault: () => (prevented = true) };
      fixture.emit("open-url", event, url(ID));
      assert.isTrue(prevented);
      prevented = false;
      fixture.emit("open-url", event, "studio://app/settings");
      assert.isFalse(prevented);
      fixture.emit("open-url", event, url(OTHER));
      fixture.emit("second-instance", {}, ["/usr/bin/specwithcode", url(ID)]);
      fixture.emit("second-instance", {}, ["/usr/bin/specwithcode", url(OTHER)]);
      fixture.emit("second-instance", {}, ["/usr/bin/specwithcode"]);
      yield* settle;
      assert.deepEqual(fixture.opened, [ID, ID]);
    }).pipe(Effect.scoped);
  });

  it.effect("opens once a main window exists even if no window event was seen", () => {
    const fixture = setup({ argv: [], mainOpen: false });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      fixture.state.main = true;
      fixture.emit("open-url", { preventDefault: () => undefined }, url(ID));
      yield* settle;
      assert.deepEqual(fixture.opened, [ID]);
    }).pipe(Effect.scoped);
  });

  it.effect("releases held launches when the main window is focused", () => {
    const fixture = setup({ argv: [], mainOpen: false });
    return Effect.gen(function* () {
      yield* Layer.build(fixture.layer);
      fixture.emit("second-instance", {}, [url(ID)]);
      yield* settle;
      assert.deepEqual(fixture.opened, []);
      fixture.state.main = true;
      fixture.emit("browser-window-focus", {}, {});
      yield* settle;
      assert.deepEqual(fixture.opened, [ID]);
    }).pipe(Effect.scoped);
  });

  it.effect("holds a cold-start launch until the main window has loaded", () => {
    const fixture = setup({ argv: ["/opt/SpecWithCode/specwithcode", url(ID)], mainOpen: false });
    return Effect.gen(function* () {
      // The open-url that launched the app arrived before the layer existed.
      assert.isTrue(fixture.earlyEmitter.emit(url(ID)));
      yield* Layer.build(fixture.layer);
      assert.equal(fixture.earlyEmitter.listeners.size, 0);
      yield* settle;
      assert.deepEqual(fixture.opened, []);

      // A splash or helper window that is not the main window keeps waiting.
      const contents = new Map<string, () => void>();
      const window = {
        webContents: {
          once: (event: string, listener: () => void) => contents.set(event, listener),
        },
      };
      fixture.emit("browser-window-created", {}, window);
      contents.get("did-finish-load")?.();
      yield* settle;
      assert.deepEqual(fixture.opened, []);

      fixture.state.main = true;
      fixture.emit("browser-window-created", {}, window);
      contents.get("did-finish-load")?.();
      yield* settle;
      assert.deepEqual(fixture.opened, [ID, ID]);
    }).pipe(Effect.scoped);
  });
});
