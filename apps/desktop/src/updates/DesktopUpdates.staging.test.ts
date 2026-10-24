import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import type { LocalServiceSnapshot } from "./appActivationGate.ts";
import { APP_INSTALL_APPLY_MS } from "./appFollowUp.ts";
import { installAppRelease } from "./runFollowUp.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

// The M4 stall of October 22, 2026: a release downloaded while the app swap
// gate was closed is not staged by Squirrel.Mac, and quitAndInstall on an
// unstaged bundle with install-on-quit set returns without quitting.
describe("DesktopUpdates Squirrel staging", () => {
  const serviceOn = (version: string) => {
    let snapshot: LocalServiceSnapshot = {
      state: { status: "installed", installedVersion: version, message: null },
      runningVersion: version,
    };
    return {
      probe: Effect.sync(() => snapshot),
      set: (next: string) => {
        snapshot = {
          state: { status: "installed", installedVersion: next, message: null },
          runningVersion: next,
        };
      },
    };
  };

  const settle = Effect.gen(function* () {
    for (let i = 0; i < 40; i++) yield* flushCallbacks;
  });

  // Downloads 1.2.4 while the service still runs 1.2.3, so Squirrel never stages it.
  const downloadWhileGateClosed = (
    harness: ReturnType<typeof makeHarness>,
    service: ReturnType<typeof serviceOn>,
  ) =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* updates.registerLocalServiceProbe(service.probe);
      harness.emit("update-available", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* updates.download;
      yield* settle;
      assert.isFalse(harness.installOnQuit());
      return updates;
    });

  it.effect("the run follow-up install in the gate-opening tick restages before quitting", () =>
    Effect.gen(function* () {
      const service = serviceOn("1.2.3");
      const harness = makeHarness({
        squirrel: true,
        // Squirrel unpacks after electron-updater's download resolves.
        squirrelUnpack: Duration.seconds(3),
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* downloadWhileGateClosed(harness, service);
          service.set("1.2.4");
          // runFollowUp's install: refreshActivation opens the gate and forks
          // the restage, then installPrepared runs in the same tick.
          const checks = harness.checkCount();
          const install = yield* installAppRelease(updates)("1.2.4").pipe(Effect.forkScoped);
          for (let second = 0; second < 5; second++) {
            yield* settle;
            yield* TestClock.adjust(Duration.seconds(1));
          }
          const answer = yield* Fiber.join(install);
          yield* settle;
          assert.isTrue(answer.accepted);
          assert.isFalse(answer.failed);
          // The restage ran (its fresh check too), and the install waited for
          // it and for Squirrel's unpack instead of fetching again.
          assert.equal(harness.checkCount(), checks + 1);
          assert.equal(harness.downloadCount(), 2);
          assert.equal(harness.quits(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an install restages an unstaged download instead of a no-op quitAndInstall", () =>
    Effect.gen(function* () {
      let downloads = 0;
      const service = serviceOn("1.2.3");
      const harness = makeHarness({
        squirrel: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.gen(function* () {
          // The gate-opening restage fails; Squirrel stays unstaged.
          if (++downloads === 2) {
            return yield* new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
              channel: "latest",
              cause: new Error("restage failed"),
            });
          }
          harness.emit("update-downloaded", { version: "1.2.4" });
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* downloadWhileGateClosed(harness, service);
          service.set("1.2.4");
          yield* updates.refreshActivation;
          yield* settle;
          assert.equal(downloads, 2);
          assert.isTrue(harness.installOnQuit());

          const result = yield* updates.installPrepared("1.2.4");
          assert.isTrue(result.accepted);
          assert.isFalse(result.failed);
          assert.equal(downloads, 3);
          assert.equal(harness.quits(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an install with manual install preferences stages before quitting", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        squirrel: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setUpdatePreferences({ installAutomatically: false });
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          yield* settle;
          assert.isFalse(harness.installOnQuit());

          // quitAndInstall on the unstaged bundle would leave a native listener
          // that quits on any later staging; the install stages first instead.
          assert.isTrue((yield* updates.install).accepted);
          assert.equal(harness.downloadCount(), 2);
          assert.equal(harness.quitAndInstalls(), 1);
          assert.equal(harness.quits(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("the activation poll does not undo install-on-quit while an install stages", () =>
    Effect.gen(function* () {
      const staging = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let downloads = 0;
      const harness = makeHarness({
        squirrel: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.gen(function* () {
          harness.emit("update-downloaded", { version: "1.2.4" });
          if (++downloads === 2) {
            yield* Deferred.succeed(staging, undefined);
            yield* Deferred.await(release);
          }
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setUpdatePreferences({ installAutomatically: false });
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          yield* settle;

          const install = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(staging);
          // serviceUpdates.ts refreshes activation every 20 seconds.
          yield* updates.refreshActivation;
          yield* settle;
          assert.isTrue(harness.installOnQuit());
          yield* Deferred.succeed(release, undefined);
          assert.isFalse((yield* Fiber.join(install)).failed);
          assert.equal(harness.quits(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an install that cannot stage fails without quitting or stopping backends", () =>
    Effect.gen(function* () {
      let downloads = 0;
      const service = serviceOn("1.2.3");
      const harness = makeHarness({
        squirrel: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.gen(function* () {
          if (++downloads > 1) {
            return yield* new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
              channel: "latest",
              cause: new Error("staging failed"),
            });
          }
          harness.emit("update-downloaded", { version: "1.2.4" });
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* downloadWhileGateClosed(harness, service);
          service.set("1.2.4");
          yield* updates.refreshActivation;
          yield* settle;

          const result = yield* updates.installPrepared("1.2.4");
          assert.isTrue(result.failed);
          assert.equal(result.state.errorContext, "install");
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.equal(harness.quitAndInstalls(), 0);
          assert.isFalse(yield* updates.isActionActive);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an install that never quits releases the updater and restarts backends", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() => harness.emit("update-not-available")),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          // The test process is the app, and it does not quit.
          assert.isTrue((yield* updates.install).accepted);
          assert.isTrue(yield* Ref.get(desktopState.quitting));

          // The updater's quit began, so only the backstop takes it back.
          assert.isTrue(yield* Ref.get(desktopState.shutdownBegun));
          yield* TestClock.adjust(Duration.seconds(5));
          yield* settle;
          assert.isTrue(yield* updates.isInstallActive);

          yield* TestClock.adjust(Duration.millis(APP_INSTALL_APPLY_MS));
          yield* settle;
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.isFalse(yield* Ref.get(desktopState.shutdownBegun));
          assert.isFalse(yield* updates.isActionActive);
          assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
          assert.equal((yield* updates.getState).errorContext, "install");

          const checks = harness.checkCount();
          assert.isTrue((yield* updates.check("after stalled install")).checked);
          assert.equal(harness.checkCount(), checks + 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  // The M4 no-quit of October 22, 2026: quitAndInstall returned, nothing quit,
  // and `quitting` refused every check for 4.5 hours.
  it.effect("an install whose quitAndInstall never quits is taken back within 5 seconds", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        quitAndInstallDoesNothing: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-not-available")),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* settle;
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          yield* TestClock.adjust(Duration.millis(4_900));
          yield* settle;
          assert.isTrue(yield* Ref.get(desktopState.quitting));

          yield* TestClock.adjust(Duration.millis(100));
          const result = yield* Fiber.join(install);
          assert.isTrue(result.accepted);
          assert.isTrue(result.failed);
          assert.equal(result.state.errorContext, "install");
          assert.equal(result.state.message, "SpecWithCode did not restart to install the update.");
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.isFalse(yield* updates.isActionActive);
          yield* settle;
          assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

          const checks = harness.checkCount();
          assert.isTrue((yield* updates.check("after an install that did not quit")).checked);
          assert.equal(harness.checkCount(), checks + 1);

          // "Restart now" is admitted again, and the first install's backstop
          // (75 s after it, 70 s from here) leaves it alone.
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const again = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* settle;
          assert.isTrue(yield* updates.isInstallActive);
          yield* Ref.set(desktopState.shutdownBegun, true);
          yield* TestClock.adjust(Duration.millis(100));
          const second = yield* Fiber.join(again);
          assert.isTrue(second.accepted);
          assert.isFalse(second.failed);
          yield* TestClock.adjust(Duration.millis(APP_INSTALL_APPLY_MS - 5_000));
          yield* settle;
          assert.isTrue(yield* updates.isInstallActive);
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          assert.equal(harness.quitAndInstalls(), 2);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an install whose quit begins within 5 seconds is not taken back", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ quitAndInstallDoesNothing: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* settle;
          yield* TestClock.adjust(Duration.seconds(2));
          // Electron's before-quit-for-update, as the lifecycle records it.
          yield* Ref.set(desktopState.shutdownBegun, true);
          yield* TestClock.adjust(Duration.millis(100));
          const result = yield* Fiber.join(install);
          assert.isTrue(result.accepted);
          assert.isFalse(result.failed);

          yield* TestClock.adjust(Duration.seconds(10));
          yield* settle;
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          assert.isTrue(yield* updates.isInstallActive);
          assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("an older install's watch leaves a later install alone", () =>
    Effect.gen(function* () {
      const secondStop = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      let stops = 0;
      const harness = makeHarness({
        stopBackend: Effect.suspend(() =>
          ++stops === 2
            ? Deferred.succeed(secondStop, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStop)),
              )
            : Effect.void,
        ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          assert.isTrue((yield* updates.install).accepted);
          harness.emit("error", new Error("native installer refused"));
          yield* settle;
          assert.isFalse(yield* updates.isInstallActive);

          const second = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(secondStop);
          yield* TestClock.adjust(Duration.millis(APP_INSTALL_APPLY_MS));
          yield* settle;
          assert.isTrue(yield* updates.isInstallActive);
          assert.isTrue(yield* Ref.get(desktopState.quitting));

          yield* Deferred.succeed(releaseStop, undefined);
          assert.isTrue((yield* Fiber.join(second)).accepted);
          assert.equal(harness.quitAndInstalls(), 2);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("a newer download made while the gate was closed is restaged over the staged one", () =>
    Effect.gen(function* () {
      let feed = "1.2.4";
      const service = serviceOn("1.2.4");
      const harness = makeHarness({
        squirrel: true,
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: feed })),
        downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: feed })),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(service.probe);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          yield* settle;
          // Downloaded with the gate open: Squirrel staged 1.2.4.
          assert.isTrue(harness.installOnQuit());

          feed = "1.2.5";
          harness.emit("update-available", { version: "1.2.5" });
          yield* flushCallbacks;
          yield* updates.download;
          yield* settle;
          assert.isFalse(harness.installOnQuit());
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.5");

          // Squirrel still holds 1.2.4, so the opening gate stages 1.2.5.
          service.set("1.2.5");
          yield* updates.refreshActivation;
          yield* settle;
          assert.equal(harness.downloadCount(), 3);
          assert.isTrue(harness.installOnQuit());

          const result = yield* updates.installPrepared("1.2.5");
          assert.isTrue(result.accepted);
          assert.isFalse(result.failed);
          assert.equal(harness.downloadCount(), 3);
          assert.equal(harness.quits(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("a refused install whose quit began gives later quits back to the app", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ quitAndInstallDoesNothing: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* settle;
          // Electron's before-quit-for-update, as the lifecycle records it.
          yield* Ref.set(desktopState.updaterQuitAllowed, true);
          yield* Ref.set(desktopState.shutdownBegun, true);
          yield* TestClock.adjust(Duration.millis(100));
          assert.isTrue((yield* Fiber.join(install)).accepted);

          // Squirrel.Mac: "No update available, can't quit and install".
          harness.emit("error", new Error("No update available, can't quit and install"));
          yield* settle;
          assert.isFalse(yield* updates.isInstallActive);
          assert.isFalse(yield* Ref.get(desktopState.shutdownBegun));
          assert.isFalse(yield* Ref.get(desktopState.updaterQuitAllowed));
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});
