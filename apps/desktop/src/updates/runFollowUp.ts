import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import type * as DesktopUpdates from "./DesktopUpdates.ts";
import type { RunFollowUp } from "../ipc/methods/serviceUpdateRuns.ts";
import {
  afterInstall,
  beforeInstall,
  decideFollowUp,
  reconcileOnStartup,
  retainedAppVersion,
  retryFollowUp,
} from "./appFollowUp.ts";
import { findManagedServiceInstallations } from "./studioServiceUpdates.ts";
import {
  appForRun,
  isoAt,
  parseRunApp,
  readRun,
  readRunApp,
  type RunAppRecord,
  type RunFiles,
  RUN_APP_FILE,
  type UpdateRunRecord,
  writeRunApp,
} from "./updateRun.ts";

/**
 * The main process's fiber for the app half of a run (appFollowUp.ts holds
 * the decisions). It needs no window: the run loop calls `advance` every 2
 * seconds while a verified run still has its app to install, and
 * `reconcile` runs once at startup before the first update check.
 */

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("service-update-runs");

export interface AppInstallAnswer {
  readonly accepted: boolean;
  readonly failed: boolean;
  /** Why it was refused or failed, in words a person reads. */
  readonly message: string | null;
  /** Main's refusal reason ("busy", "service-behind", ...): a quick one is asked again sooner. */
  readonly reason?: string | null;
}

export interface RunFollowUpDeps {
  /** The updates folder of this Mac's service, or null when there is none. */
  readonly files: Effect.Effect<RunFiles | null>;
  /** The running app's version. */
  readonly appVersion: string;
  /**
   * Downloads `version` when needed, then installs it and relaunches. Runs
   * `beforeApply` once the release is on disk, right before the install call
   * that may quit the app.
   */
  readonly install: (
    version: string,
    beforeApply: Effect.Effect<void>,
  ) => Effect.Effect<AppInstallAnswer>;
}

/** While the release downloads, the record's `updatedAt` moves this often: main is at work. */
export const APP_DOWNLOAD_BEAT = Duration.seconds(20);
export const appDownloadingMessage = (version: string) => `Downloading SpecWithCode ${version}.`;

const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

export function makeRunFollowUp(deps: RunFollowUpDeps): RunFollowUp & {
  readonly reconcile: Effect.Effect<RunAppRecord | null>;
} {
  // One install call at a time in this process.
  let installing = false;

  // The record while this process still works for it, before it relaunches.
  const ownInstalling = (files: RunFiles, record: RunAppRecord) => {
    const current = readRunApp(files);
    return current !== null && current.runId === record.runId && current.appPhase === "installing"
      ? current
      : null;
  };

  const runInstall = (files: RunFiles, record: RunAppRecord) =>
    Effect.gen(function* () {
      // Downloading first: "relaunching" only once the release is on disk.
      writeRunApp(files, {
        ...record,
        message: appDownloadingMessage(record.appTargetVersion),
        updatedAt: isoAt(yield* nowMillis),
      });
      const beat = yield* Effect.gen(function* () {
        const current = ownInstalling(files, record);
        if (current !== null)
          writeRunApp(files, { ...current, updatedAt: isoAt(yield* nowMillis) });
      }).pipe(Effect.delay(APP_DOWNLOAD_BEAT), Effect.forever, Effect.forkChild);
      // An accepted install may quit the app before the call returns, so the
      // record says relaunching before that call.
      const beforeApply = Effect.gen(function* () {
        yield* Fiber.interrupt(beat);
        const current = ownInstalling(files, record);
        if (current !== null) {
          writeRunApp(files, { ...beforeInstall(current, yield* nowMillis), message: null });
        }
      });
      yield* logInfo("installing the app half of an update run", {
        runId: record.runId,
        appTargetVersion: record.appTargetVersion,
      });
      const answer = yield* deps.install(record.appTargetVersion, beforeApply).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<AppInstallAnswer>({
            accepted: false,
            failed: true,
            message: `The app update could not start: ${String(cause)}`,
          }),
        ),
        Effect.ensuring(Fiber.interrupt(beat)),
      );
      const current = readRunApp(files);
      // A newer run, or a relaunch that already settled it, owns the file now.
      if (
        current === null ||
        current.runId !== record.runId ||
        (current.appPhase !== "relaunching" && current.appPhase !== "installing")
      ) {
        return;
      }
      const next = afterInstall(record, answer, yield* nowMillis);
      writeRunApp(files, next);
      if (next.appPhase === "failed") {
        yield* logWarning("the app half of an update run failed", {
          runId: record.runId,
          message: next.message,
        });
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          installing = false;
        }),
      ),
    );

  const advance = (run: UpdateRunRecord) =>
    Effect.gen(function* () {
      const files = yield* deps.files;
      if (files === null) return;
      const decision = decideFollowUp({
        run,
        app: readRunApp(files),
        appVersion: deps.appVersion,
        nowMs: yield* nowMillis,
        installing,
      });
      if (decision.type === "none") return;
      writeRunApp(files, decision.record);
      if (!decision.install || installing) return;
      installing = true;
      // The tick goes on; an accepted install quits the app from this fiber.
      yield* runInstall(files, decision.record).pipe(Effect.forkDetach);
    });

  const retry = (run: UpdateRunRecord) =>
    Effect.gen(function* () {
      const files = yield* deps.files;
      if (files === null) return;
      const next = retryFollowUp(run, readRunApp(files), yield* nowMillis);
      if (next === null) return;
      writeRunApp(files, next);
      yield* advance(run);
    });

  const reconcile = Effect.gen(function* () {
    const files = yield* deps.files;
    if (files === null) return null;
    const run = readRun(files);
    const settled = reconcileOnStartup({
      run,
      app: readRunApp(files),
      appVersion: deps.appVersion,
      nowMs: yield* nowMillis,
    });
    if (settled === null || run === null || appForRun(run, settled) === null) return null;
    writeRunApp(files, settled);
    yield* logInfo("settled the app half of an update run after relaunch", {
      runId: settled.runId,
      appPhase: settled.appPhase,
    });
    return settled;
  });

  return { advance, retry, reconcile };
}

const REFUSALS: Record<string, string> = {
  busy: "The app updater is busy.",
  quitting: "SpecWithCode is already quitting.",
  "no-download": "The app update is not downloaded.",
  disabled: "App updates are off in this build.",
  "service-behind": "The app update waits for the service on this Mac.",
};

/**
 * Installs app release `version` through the app's own updater: the service
 * was just verified, so the swap gate is read again first; a release not yet
 * on disk is checked for and downloaded.
 */
export const installAppRelease =
  (
    updates: Pick<
      DesktopUpdates.DesktopUpdates["Service"],
      "refreshActivation" | "getState" | "check" | "download" | "installPrepared"
    >,
  ) =>
  (
    version: string,
    beforeApply: Effect.Effect<void> = Effect.void,
  ): Effect.Effect<AppInstallAnswer> =>
    Effect.gen(function* () {
      yield* updates.refreshActivation;
      let state = yield* updates.getState;
      if (state.downloadedVersion !== version) {
        if (state.status !== "available" || state.availableVersion !== version) {
          state = (yield* updates.check("update run app follow-up")).state;
        }
        if (state.status === "available" && state.availableVersion === version) {
          state = (yield* updates.download).state;
        }
        if (state.downloadedVersion !== version) {
          return {
            accepted: false,
            failed: false,
            message:
              state.message ??
              `SpecWithCode ${version} is not downloaded yet${
                state.availableVersion ? ` (the feed offers ${state.availableVersion})` : ""
              }.`,
          };
        }
      }
      yield* beforeApply;
      const result = yield* updates.installPrepared(version);
      const refused = !result.accepted && !result.failed;
      return {
        accepted: result.accepted,
        failed: result.failed,
        message: result.failed
          ? (result.state.message ?? null)
          : result.accepted
            ? null
            : (REFUSALS[result.reason ?? "busy"] ?? null),
        ...(refused ? { reason: result.reason ?? "busy" } : {}),
      };
    });

/**
 * At startup, the app release an update run on this Mac is installing, read
 * from each managed service's updates/run-app.json. The macOS bundle-swap
 * updater keeps that release's staged copy instead of clearing it.
 */
export function retainedRunAppVersion(
  homeDirectory: string,
  runningVersion: string,
  readFile: (path: string) => string | null,
  installations: (
    home: string,
  ) => ReadonlyArray<{ readonly studioHome: string }> = findManagedServiceInstallations,
): string | null {
  for (const installation of installations(homeDirectory)) {
    const app = parseRunApp(readFile(`${installation.studioHome}/updates/${RUN_APP_FILE}`));
    const version = retainedAppVersion(app, runningVersion);
    if (version !== null) return version;
  }
  return null;
}
