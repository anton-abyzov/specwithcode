
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock, nativeUpdaterMock } = vi.hoisted(() => ({
  // Electron's own autoUpdater (Squirrel.Mac), which MacUpdater feeds.
  nativeUpdaterMock: { on: vi.fn() },
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadedUpdateHelper: null as { versionInfo: unknown } | null,
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  autoUpdater: nativeUpdaterMock,
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadedUpdateHelper = null;
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    nativeUpdaterMock.on.mockClear();
  });

  // Calls every listener `mock` was given for `eventName`.
  const emitOn = (mock: { on: ReturnType<typeof vi.fn> }, eventName: string, payload?: unknown) => {
    for (const [name, listener] of mock.on.mock.calls) {
      if (name === eventName) (listener as (payload?: unknown) => void)(payload);
    }
  };
  const layerOn = (platform: NodeJS.Platform) =>
    ElectronUpdater.layer.pipe(Layer.provide(Layer.succeed(HostProcessPlatform, platform)));

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("forgets the last download's release record before each download", () =>
    Effect.gen(function* () {
      autoUpdaterMock.downloadedUpdateHelper = { versionInfo: { version: "1.2.4" } };
      let recordAtDownload: unknown = "unset";
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => {
        recordAtDownload = autoUpdaterMock.downloadedUpdateHelper?.versionInfo;
        return Promise.resolve([]);
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.downloadUpdate;

      assert.isNull(recordAtDownload);
      // Before any download there is no helper, and nothing to forget.
      autoUpdaterMock.downloadedUpdateHelper = null;
      yield* updater.downloadUpdate;
      assert.equal(autoUpdaterMock.downloadUpdate.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  // electron-updater's own cache check, on the record the private github
  // provider returns: a later check differs only in download_count.
  it.effect("reuses a cached download by its sha512 once the record is forgotten", () =>
    Effect.gen(function* () {
      const { DownloadedUpdateHelper } = (yield* Effect.promise(
        () => import("electron-updater/out/DownloadedUpdateHelper.js"),
      )) as {
        DownloadedUpdateHelper: new (cacheDir: string) => {
          setDownloadedFile: (...args: ReadonlyArray<unknown>) => Promise<void>;
          validateDownloadedPath: (...args: ReadonlyArray<unknown>) => Promise<string | null>;
        };
      };
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-updater-" });
      yield* fileSystem.makeDirectory(`${cacheDir}/pending`, { recursive: true });
      const zipName = "SpecWithCode-1.2.4-arm64.zip";
      const zipPath = `${cacheDir}/pending/${zipName}`;
      yield* fileSystem.writeFileString(zipPath, "the 1.2.4 bundle");
      // sha512 of "the 1.2.4 bundle", as latest-mac.yml writes it.
      const sha512 =
        "SVmU4SNvtUh1PAck09hlTDGY6aqmsyzDC0vz06llemfgEEKn0atNXBA4vjrljEzUEnnRDP/KF741WRl9EInVXA==";
      const fileInfo = {
        url: new URL(`https://example.test/${zipName}`),
        info: { url: zipName, sha512 },
      };
      const record = (downloadCount: number) => ({
        version: "1.2.4",
        files: [{ url: zipName, sha512 }],
        assets: [{ name: zipName, download_count: downloadCount }],
      });
      const silent = { info: () => {}, warn: () => {} };
      const helper = new DownloadedUpdateHelper(cacheDir);
      const validate = Effect.promise(() =>
        helper.validateDownloadedPath(zipPath, record(6), fileInfo, silent),
      );
      yield* Effect.promise(() =>
        helper.setDownloadedFile(zipPath, null, record(5), fileInfo, zipName, true),
      );

      // The record the next check returns: the download raised its count.
      assert.isNull(yield* validate);
      ElectronUpdater.forgetDownloadRecord({ downloadedUpdateHelper: helper });
      // electron-updater joins the cache path itself, with the platform's separator.
      assert.equal(yield* validate, path.normalize(zipPath));

      // A cached file that no longer hashes to the release's sha512 is refused.
      ElectronUpdater.forgetDownloadRecord({ downloadedUpdateHelper: helper });
      yield* fileSystem.writeFileString(zipPath, "tampered");
      assert.isNull(yield* validate);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect.each(["win32", "linux"] as const)("is always ready to install on %s", (platform) =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      // NSIS, AppImage and dpkg install from the download itself.
      assert.isTrue(yield* updater.installReady);
      yield* updater.downloadUpdate;
      assert.isTrue(yield* updater.installReady);
      assert.equal(nativeUpdaterMock.on.mock.calls.length, 0);
    }).pipe(Effect.provide(layerOn(platform))),
  );

  it.effect("is ready on macOS only once Squirrel staged the latest download", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      assert.isFalse(yield* updater.installReady);

      yield* updater.downloadUpdate;
      emitOn(autoUpdaterMock, "update-downloaded", { version: "1.2.4" });
      // Downloaded with install-on-quit off: Squirrel holds nothing yet.
      assert.isFalse(yield* updater.installReady);
      emitOn(nativeUpdaterMock, "update-downloaded");
      assert.isTrue(yield* updater.installReady);

      // A newer download: the bundle Squirrel holds is the older release,
      // although MacUpdater's own flag stays true for good.
      yield* updater.downloadUpdate;
      emitOn(autoUpdaterMock, "update-downloaded", { version: "1.2.5" });
      assert.isFalse(yield* updater.installReady);
      emitOn(nativeUpdaterMock, "update-downloaded");
      assert.isTrue(yield* updater.installReady);
      // Listeners are added once, not per download.
      assert.equal(nativeUpdaterMock.on.mock.calls.length, 1);
    }).pipe(Effect.provide(layerOn("darwin"))),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
