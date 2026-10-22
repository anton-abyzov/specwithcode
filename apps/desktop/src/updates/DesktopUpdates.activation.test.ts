import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import type { LocalServiceSnapshot } from "./appActivationGate.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

// The local service activates first: the app swaps itself for a downloaded
// release only once the service runs it (appActivationGate.ts).
describe("DesktopUpdates app activation", () => {
  const serviceOn = (version: string, status: "error" | "installed" = "installed") => {
    let snapshot: LocalServiceSnapshot = {
      state: {
        status,
        installedVersion: version,
        message:
          status === "error"
            ? "The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update"
            : null,
      },
      runningVersion: version,
    };
    return {
      probe: Effect.sync(() => snapshot),
      set: (next: string, nextStatus: "error" | "installed" = "installed") => {
        snapshot = {
          state: { status: nextStatus, installedVersion: next, message: null },
          runningVersion: next,
        };
      },
    };
  };

  it.effect("does not stage install-on-quit while the service runs an older release", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const service = serviceOn("1.2.3", "error");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(service.probe);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          // Squirrel reads the flag when the download finishes: it must be off.
          assert.isFalse(harness.installOnQuit());
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.equal(state.swapGate?.gate, "closed");
          assert.equal(state.swapGate?.reason, "service-behind");
          assert.equal(state.swapGate?.serviceVersion, "1.2.3");
          assert.isFalse(harness.installOnQuit());
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("refuses a restart into a release the service does not run, then allows it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const service = serviceOn("1.2.3", "error");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(service.probe);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const refused = yield* updates.installPrepared("1.2.4");
          assert.isFalse(refused.accepted);
          assert.equal(refused.reason, "service-behind");
          assert.equal(harness.quitAndInstalls(), 0);

          // The service installs 1.2.4 (the one-press flow does this first).
          service.set("1.2.4");
          const accepted = yield* updates.installPrepared("1.2.4");
          assert.isTrue(accepted.accepted);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("installs the app alone when the press says the agent lacks the release", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      // The agent's feed has no 1.2.4: it is up to date on 1.2.3.
      const service = serviceOn("1.2.3");
      service.set("1.2.3", "installed");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(service.probe);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          // Any other press still waits for the service.
          const refused = yield* updates.installPrepared("1.2.4");
          assert.isFalse(refused.accepted);
          assert.equal(refused.reason, "service-behind");
          assert.equal(harness.quitAndInstalls(), 0);
          // The app-only press made because the agent lacks the release installs.
          const accepted = yield* updates.installPrepared("1.2.4", { serviceLacksRelease: true });
          assert.isTrue(accepted.accepted);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("stages the download again once the service catches up", () =>
    Effect.gen(function* () {
      // Like electron-updater: a check re-announces the release on disk, and a
      // download of it (served from the cache) ends with update-downloaded.
      let emit: (event: string, info: unknown) => void = () => {};
      const installOnQuitAtDownload: Array<boolean | undefined> = [];
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() => emit("update-available", { version: "1.2.4" })),
        downloadUpdate: Effect.sync(() => {
          installOnQuitAtDownload.push(harness.installOnQuit());
          emit("update-downloaded", { version: "1.2.4" });
        }),
      });
      emit = (event, info) => harness.emit(event, info);
      const service = serviceOn("1.2.3", "error");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(service.probe);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          yield* flushCallbacks;
          assert.equal((yield* updates.getState).status, "downloaded");
          assert.deepEqual(installOnQuitAtDownload, [false]);
          const checksBefore = harness.checkCount();

          service.set("1.2.4");
          yield* updates.refreshActivation;
          for (let i = 0; i < 20; i += 1) yield* flushCallbacks;
          assert.isTrue(harness.installOnQuit());
          const state = yield* updates.getState;
          assert.equal(state.swapGate?.gate, "open");
          assert.equal(state.status, "downloaded");
          // A check, then a second download that finishes with the flag on, so
          // Squirrel stages it for the next quit.
          assert.isAbove(harness.checkCount(), checksBefore);
          assert.equal(harness.downloadCount(), 2);
          assert.deepEqual(installOnQuitAtDownload, [false, true]);

          // Only once per opened gate.
          yield* updates.refreshActivation;
          for (let i = 0; i < 20; i += 1) yield* flushCallbacks;
          assert.equal(harness.downloadCount(), 2);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps install-on-quit as before on a machine without a managed service", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.registerLocalServiceProbe(Effect.succeed(null));
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* updates.download;
          assert.isTrue(harness.installOnQuit());
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const result = yield* updates.installPrepared("1.2.4");
          assert.isTrue(result.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});
