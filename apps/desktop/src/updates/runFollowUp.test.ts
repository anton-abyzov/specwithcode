import { it } from "@effect/vitest";
import type { DesktopUpdateState } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { APP_DID_NOT_APPLY, APP_INSTALL_APPLY_MS } from "./appFollowUp.ts";
import {
  APP_DOWNLOAD_BEAT,
  type AppInstallAnswer,
  appDownloadingMessage,
  installAppRelease,
  makeRunFollowUp,
  retainedRunAppVersion,
} from "./runFollowUp.ts";
import {
  isoAt,
  readRunApp,
  RUN_APP_FILE,
  RUN_FILE,
  type RunAppRecord,
  type UpdateRunRecord,
  writeRunApp,
} from "./updateRun.ts";
import { memoryRunFiles } from "./updateRunTestFiles.ts";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const verified: UpdateRunRecord = {
  schemaVersion: 1,
  runId: "run-a",
  rev: 6,
  createdAt: isoAt(T0),
  createdBy: "desktop",
  targetVersion: "1.0.70",
  fromVersion: "1.0.69",
  appTargetVersion: "1.0.70",
  requestedAt: isoAt(T0),
  deadlineAt: isoAt(T0 + 30 * 60_000),
  phase: "verified",
  owner: null,
  heartbeatAt: null,
  leaseUntil: isoAt(T0),
  message: null,
  receipt: null,
  endedAt: isoAt(T0),
};

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
});

function setup(appVersion: string, answers: AppInstallAnswer[]) {
  const files = memoryRunFiles();
  files.writeAtomic(RUN_FILE, JSON.stringify(verified));
  const installs: string[] = [];
  const followUp = makeRunFollowUp({
    files: Effect.succeed(files),
    appVersion,
    install: (version, beforeApply) =>
      Effect.gen(function* () {
        // Downloading: the record says so, not "relaunching".
        expect(readRunApp(files)).toMatchObject({
          appPhase: "installing",
          message: appDownloadingMessage(version),
        });
        yield* beforeApply;
        installs.push(version);
        // The record says relaunching while the install call runs: an
        // accepted install may quit the app before it returns.
        expect(readRunApp(files)).toMatchObject({ appPhase: "relaunching", message: null });
        return answers.shift() ?? { accepted: false, failed: false, message: "busy" };
      }),
  });
  return { files, installs, followUp };
}

describe("makeRunFollowUp", () => {
  it.effect("installs the app once the service is verified, with no window involved", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 1_000);
      const { files, installs, followUp } = setup("1.0.69", [
        { accepted: true, failed: false, message: null },
      ]);
      yield* followUp.advance(verified);
      yield* settle;
      expect(installs).toEqual(["1.0.70"]);
      expect(readRunApp(files)).toMatchObject({
        runId: "run-a",
        appPhase: "relaunching",
        attempts: 1,
        fromAppVersion: "1.0.69",
      });
      // Still running long after the accepted install: it did not apply.
      yield* TestClock.setTime(T0 + 1_000 + APP_INSTALL_APPLY_MS);
      yield* followUp.advance(verified);
      expect(readRunApp(files)).toMatchObject({ appPhase: "failed", message: APP_DID_NOT_APPLY });
      expect(installs).toHaveLength(1);
    }),
  );

  it.effect("says downloading, and keeps showing life, until the release is on disk", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 1_000);
      const files = memoryRunFiles();
      files.writeAtomic(RUN_FILE, JSON.stringify(verified));
      const ready = yield* Deferred.make<void>();
      const followUp = makeRunFollowUp({
        files: Effect.succeed(files),
        appVersion: "1.0.69",
        install: (_version, beforeApply) =>
          Deferred.await(ready).pipe(
            Effect.andThen(beforeApply),
            Effect.as({ accepted: true, failed: false, message: null }),
          ),
      });
      yield* followUp.advance(verified);
      yield* settle;
      expect(readRunApp(files)).toMatchObject({
        appPhase: "installing",
        message: "Downloading SpecWithCode 1.0.70.",
        updatedAt: isoAt(T0 + 1_000),
      });
      // A slow download: the record keeps moving, so no window shows "no progress".
      yield* TestClock.adjust(APP_DOWNLOAD_BEAT);
      yield* settle;
      expect(readRunApp(files)).toMatchObject({
        appPhase: "installing",
        updatedAt: isoAt(T0 + 21_000),
      });
      yield* Deferred.succeed(ready, undefined);
      yield* settle;
      expect(readRunApp(files)).toMatchObject({ appPhase: "relaunching", attempts: 1 });
    }),
  );

  it.effect("keeps a refused install waiting and asks again; Restart now retries a failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 1_000);
      const { files, installs, followUp } = setup("1.0.69", [
        { accepted: false, failed: false, message: "The app updater is busy." },
        { accepted: false, failed: true, message: "swap failed" },
        { accepted: true, failed: false, message: null },
      ]);
      yield* followUp.advance(verified);
      yield* settle;
      expect(readRunApp(files)).toMatchObject({
        appPhase: "installing",
        message: "The app updater is busy.",
      });
      yield* followUp.advance(verified);
      yield* settle;
      expect(installs).toHaveLength(1);
      yield* TestClock.setTime(T0 + 31_000);
      yield* followUp.advance(verified);
      yield* settle;
      expect(readRunApp(files)).toMatchObject({ appPhase: "failed", message: "swap failed" });
      yield* followUp.retry(verified);
      yield* settle;
      expect(installs).toHaveLength(3);
      expect(readRunApp(files)).toMatchObject({ appPhase: "relaunching" });
    }),
  );

  it.effect("a relaunch on the target settles the run before any check", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 90_000);
      const { files, followUp } = setup("1.0.70", []);
      const relaunching: RunAppRecord = {
        schemaVersion: 1,
        runId: "run-a",
        appTargetVersion: "1.0.70",
        fromAppVersion: "1.0.69",
        appPhase: "relaunching",
        attempts: 1,
        message: null,
        updatedAt: isoAt(T0 + 60_000),
        finishedAt: null,
        reportedAt: null,
      };
      writeRunApp(files, relaunching);
      expect(yield* followUp.reconcile).toMatchObject({ appPhase: "done" });
      expect(readRunApp(files)).toMatchObject({ appPhase: "done", reportedAt: null });
      // Once: a second start finds nothing to settle.
      expect(yield* followUp.reconcile).toBeNull();
    }),
  );

  it.effect("a relaunch still on the old release reports that the app update did not apply", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 90_000);
      const { files, followUp } = setup("1.0.69", []);
      files.writeAtomic(
        RUN_APP_FILE,
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-a",
          appTargetVersion: "1.0.70",
          fromAppVersion: "1.0.69",
          appPhase: "relaunching",
          attempts: 1,
          message: null,
          updatedAt: isoAt(T0 + 60_000),
          finishedAt: null,
          reportedAt: null,
        }),
      );
      expect(yield* followUp.reconcile).toMatchObject({
        appPhase: "failed",
        message: APP_DID_NOT_APPLY,
      });
    }),
  );
});

const appState = (values: Partial<DesktopUpdateState>): DesktopUpdateState =>
  ({
    status: "idle",
    availableVersion: null,
    downloadedVersion: null,
    message: null,
    ...values,
  }) as DesktopUpdateState;

describe("installAppRelease", () => {
  it.effect("downloads a release not yet on disk, then installs it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let state = appState({});
      const install = installAppRelease({
        refreshActivation: Effect.sync(() => void calls.push("gate")),
        getState: Effect.sync(() => state),
        check: () =>
          Effect.sync(() => {
            calls.push("check");
            state = appState({ status: "available", availableVersion: "1.0.70" });
            return { checked: true, state };
          }),
        download: Effect.sync(() => {
          calls.push("download");
          state = appState({ status: "downloaded", downloadedVersion: "1.0.70" });
          return { accepted: true, completed: true, state };
        }),
        installPrepared: (version) =>
          Effect.sync(() => {
            calls.push(`install ${version}`);
            return { accepted: true, completed: false, failed: false, state };
          }),
      });
      const answer = yield* install(
        "1.0.70",
        Effect.sync(() => void calls.push("relaunching")),
      );
      expect(answer).toEqual({ accepted: true, failed: false, message: null });
      expect(calls).toEqual(["gate", "check", "download", "relaunching", "install 1.0.70"]);
    }),
  );

  it.effect("names a refusal instead of installing another release", () =>
    Effect.gen(function* () {
      const install = installAppRelease({
        refreshActivation: Effect.void,
        getState: Effect.succeed(appState({ downloadedVersion: "1.0.70" })),
        check: () => Effect.die("no check"),
        download: Effect.die("no download"),
        installPrepared: () =>
          Effect.succeed({
            accepted: false,
            completed: false,
            failed: false,
            reason: "service-behind" as const,
            state: appState({}),
          }),
      });
      expect(yield* install("1.0.70")).toEqual({
        accepted: false,
        failed: false,
        message: "The app update waits for the service on this Mac.",
      });
    }),
  );
});

describe("retainedRunAppVersion", () => {
  it("reads the release a run is installing from the service's updates folder", () => {
    const record = (appPhase: string) =>
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-a",
        appTargetVersion: "1.0.70",
        fromAppVersion: "1.0.69",
        appPhase,
        attempts: 1,
        message: null,
        updatedAt: isoAt(T0),
        finishedAt: null,
        reportedAt: null,
      });
    const installations = () => [{ studioHome: "/synthetic/.specwithcode/m4" }];
    const read = (text: string | null) => (path: string) =>
      path === "/synthetic/.specwithcode/m4/updates/run-app.json" ? text : null;
    expect(
      retainedRunAppVersion("/synthetic", "1.0.69", read(record("relaunching")), installations),
    ).toBe("1.0.70");
    expect(
      retainedRunAppVersion("/synthetic", "1.0.70", read(record("relaunching")), installations),
    ).toBeNull();
    expect(
      retainedRunAppVersion("/synthetic", "1.0.69", read(record("done")), installations),
    ).toBeNull();
    expect(retainedRunAppVersion("/synthetic", "1.0.69", read(null), installations)).toBeNull();
  });
});
