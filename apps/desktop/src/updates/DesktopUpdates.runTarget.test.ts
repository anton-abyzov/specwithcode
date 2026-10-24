import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { newestRelease, parsePendingUpdateInfo, updaterPendingDir } from "./pendingAppUpdate.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

// An Update now run pressed before the first update check (15 seconds after
// launch) still names the app's release: the one electron-updater downloaded
// on an earlier launch, or else the first check runs at once (October 23,
// 2026: a run made 9 s after launch left the app to a manual quit).
describe("DesktopUpdates app release for an update run", () => {
  const settle = Effect.gen(function* () {
    for (let i = 0; i < 40; i++) yield* flushCallbacks;
  });

  // The harness app runs 1.2.3 on macOS from /missing/resources.
  const withCache = (updateInfo: string | null, download: string | null) => {
    const harness = makeHarness();
    harness.files.set(
      "/missing/resources/app-update.yml",
      "provider: github\nowner: anton-abyzov\nrepo: specwithcode-dev\nupdaterCacheDirName: studio-updater\n",
    );
    const pending = `${harness.homeDirectory}/Library/Caches/studio-updater/pending`;
    if (updateInfo !== null) harness.files.set(`${pending}/update-info.json`, updateInfo);
    if (download !== null) harness.files.set(`${pending}/${download}`, "zip");
    return harness;
  };
  const info = (fileName: string) =>
    JSON.stringify({ fileName, sha512: "c2hhNTEy", isAdminRightsRequired: false });

  const oneSecondAfterLaunch = Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    yield* TestClock.adjust(Duration.seconds(1));
    return updates;
  });

  it.effect("names the downloaded release for a run made 1 s after launch", () => {
    const zip = "SpecWithCode-1.2.4-x64.zip";
    const harness = withCache(info(zip), zip);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* oneSecondAfterLaunch;
        assert.equal(yield* updates.appTargetForRun, "1.2.4");
        yield* settle;
        // The feed is still asked at once: 1.2.4 may be gone from it.
        assert.equal(harness.checkCount(), 1);
        yield* TestClock.adjust(Duration.seconds(14));
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each([
    {
      label: "the running release",
      updateInfo: info("SpecWithCode-1.2.3-x64.zip"),
      download: "SpecWithCode-1.2.3-x64.zip",
    },
    {
      label: "an older release",
      updateInfo: info("SpecWithCode-1.2.2-x64.zip"),
      download: "SpecWithCode-1.2.2-x64.zip",
    },
    { label: "malformed JSON", updateInfo: "{not json", download: null },
    {
      label: "no sha512",
      updateInfo: JSON.stringify({ fileName: "SpecWithCode-1.2.4-x64.zip" }),
      download: null,
    },
    {
      label: "a path out of the folder",
      updateInfo: info("../SpecWithCode-1.2.4-x64.zip"),
      download: null,
    },
    {
      label: "a download that is gone",
      updateInfo: info("SpecWithCode-1.2.4-x64.zip"),
      download: null,
    },
    { label: "no cache at all", updateInfo: null, download: null },
    {
      label: "a nightly download on the stable channel",
      updateInfo: info("SpecWithCode-1.2.4-nightly.20261023.1-x64.zip"),
      download: "SpecWithCode-1.2.4-nightly.20261023.1-x64.zip",
    },
  ] as const)("names none for $label and checks at once", ({ updateInfo, download }) => {
    const harness = withCache(updateInfo, download);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* oneSecondAfterLaunch;
        assert.equal(yield* updates.appTargetForRun, null);
        yield* settle;
        assert.equal(harness.checkCount(), 1);
        // That was the startup check: none follows at 15 s.
        yield* TestClock.adjust(Duration.seconds(14));
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("prefers what this launch's check found over the cached download", () => {
    const zip = "SpecWithCode-1.2.4-x64.zip";
    const harness = withCache(info(zip), zip);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* oneSecondAfterLaunch;
        harness.emit("update-available", { version: "1.2.5" });
        yield* settle;
        assert.equal(yield* updates.appTargetForRun, "1.2.5");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("names none once the feed said nothing is newer, whatever the cache holds", () => {
    const zip = "SpecWithCode-1.2.4-x64.zip";
    const harness = withCache(info(zip), zip);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* oneSecondAfterLaunch;
        harness.emit("update-not-available");
        yield* settle;
        assert.equal(yield* updates.appTargetForRun, null);
        yield* settle;
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("names none from a build whose updater is off", () => {
    const zip = "SpecWithCode-1.2.4-x64.zip";
    const harness = makeHarness({ isPackaged: false });
    // A dev build reads its updater config from the app folder; with it and
    // the download in place, only the updater being off names none.
    harness.files.set(
      "/repo/dev-app-update.yml",
      "provider: github\nowner: anton-abyzov\nrepo: specwithcode-dev\nupdaterCacheDirName: studio-updater\n",
    );
    const pending = `${harness.homeDirectory}/Library/Caches/studio-updater/pending`;
    harness.files.set(`${pending}/update-info.json`, info(zip));
    harness.files.set(`${pending}/${zip}`, "zip");
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal(yield* updates.appTargetForRun, null);
        yield* settle;
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

describe("pendingAppUpdate", () => {
  it("reads the version from electron-updater's download name", () => {
    const sha512 = "c2hhNTEy";
    assert.deepEqual(
      parsePendingUpdateInfo(JSON.stringify({ fileName: "SpecWithCode-1.0.74-arm64.zip", sha512 })),
      { version: "1.0.74", fileName: "SpecWithCode-1.0.74-arm64.zip" },
    );
    assert.equal(
      parsePendingUpdateInfo(
        JSON.stringify({ fileName: "SpecWithCode-1.0.75-nightly.20261023.1-x64.exe", sha512 }),
      )?.version,
      "1.0.75-nightly.20261023.1",
    );
    for (const raw of [
      "",
      "[]",
      "null",
      JSON.stringify({ fileName: 7, sha512 }),
      JSON.stringify({ fileName: "SpecWithCode-1.0.74-arm64.zip", sha512: "" }),
      JSON.stringify({ fileName: "SpecWithCode-latest-arm64.zip", sha512 }),
      JSON.stringify({ fileName: "sub\\SpecWithCode-1.0.74-arm64.zip", sha512 }),
    ]) {
      assert.equal(parsePendingUpdateInfo(raw), null, raw);
    }
  });

  it("keeps only releases newer than the running app, newest first", () => {
    assert.equal(newestRelease(["1.0.74", "1.0.75"], "1.0.73"), "1.0.75");
    assert.equal(newestRelease([null, "1.0.73", "1.0.72"], "1.0.73"), null);
    assert.equal(newestRelease(["garbage"], "1.0.73"), null);
  });

  it("finds the folder where electron-updater keeps its downloads", () => {
    const join = (...parts: ReadonlyArray<string>) => parts.join("/");
    const base = {
      homeDirectory: "/home/a",
      localAppData: undefined,
      xdgCacheHome: undefined,
      updaterCacheDirName: "studio-updater",
      join,
    };
    assert.equal(
      updaterPendingDir({ ...base, platform: "darwin" }),
      "/home/a/Library/Caches/studio-updater/pending",
    );
    assert.equal(
      updaterPendingDir({ ...base, platform: "win32", localAppData: "C:/L" }),
      "C:/L/studio-updater/pending",
    );
    assert.equal(
      updaterPendingDir({ ...base, platform: "linux" }),
      "/home/a/.cache/studio-updater/pending",
    );
    assert.equal(
      updaterPendingDir({ ...base, platform: "darwin", updaterCacheDirName: undefined }),
      null,
    );
  });
});
