import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

// electron-updater's cache held two 150 MB copies of a release the app already
// ran (pending/ and update.zip) on October 23, 2026.
describe("DesktopUpdates updater cache", () => {
  const settle = Effect.gen(function* () {
    for (let i = 0; i < 40; i++) yield* flushCallbacks;
  });

  // The harness app runs 1.2.3 on macOS from /missing/resources.
  const withCache = (download: string | null) => {
    const harness = makeHarness();
    harness.files.set(
      "/missing/resources/app-update.yml",
      "provider: github\nowner: anton-abyzov\nrepo: specwithcode-dev\nupdaterCacheDirName: studio-updater\n",
    );
    const cache = `${harness.homeDirectory}/Library/Caches/studio-updater`;
    if (download !== null) {
      harness.files.set(
        `${cache}/pending/update-info.json`,
        JSON.stringify({ fileName: download, sha512: "c2hhNTEy", isAdminRightsRequired: false }),
      );
      harness.files.set(`${cache}/pending/${download}`, "zip");
      harness.files.set(`${cache}/update.zip`, "zip");
    }
    return { harness, cache };
  };

  it.effect("removes the running release's download at startup, before the first check", () => {
    const { harness, cache } = withCache("SpecWithCode-1.2.3-x64.zip");
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* settle;
        assert.equal(harness.checkCount(), 0);
        assert.deepEqual(
          [...harness.files.keys()].filter((path) => path.startsWith(cache)),
          [],
        );
        yield* TestClock.adjust(Duration.seconds(15));
        yield* settle;
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a newer release's download for the install", () => {
    const { harness, cache } = withCache("SpecWithCode-1.2.4-x64.zip");
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* settle;
        assert.isTrue(harness.files.has(`${cache}/pending/SpecWithCode-1.2.4-x64.zip`));
        assert.isTrue(harness.files.has(`${cache}/update.zip`));
        assert.equal(yield* updates.appTargetForRun, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("starts without an updater cache", () => {
    const { harness } = withCache(null);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(15));
        yield* settle;
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // MacUpdater copies every download to update.zip only for differential downloads.
  it.effect.each([
    { platform: "darwin", disabled: true },
    { platform: "win32", disabled: false },
  ] as const)("differential downloads off is $disabled on $platform", ({ platform, disabled }) => {
    const harness = makeHarness({ platform });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal(harness.disableDifferentialDownload(), disabled);
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* updates.download;
        assert.equal(harness.disableDifferentialDownload(), disabled);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
