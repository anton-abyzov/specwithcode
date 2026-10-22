import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";

import {
  appForRun,
  isoAt,
  isoMillis,
  type RunAppRecord,
  type UpdateRunRecord,
} from "./updateRun.ts";

/**
 * The app half of an Update now run (0988), as pure decisions over
 * `updates/run-app.json`. The main process owns that file: once the service
 * reports the run's target `verified`, it installs the app release named by
 * the run and relaunches, whether or not a window is open. A relaunched app
 * reads the file before its first update check and settles the run once.
 */

/** An accepted install quits the app within seconds; still running after this, it did not apply. */
export const APP_INSTALL_APPLY_MS = 75_000;
/** A refused install (updater busy, the gate not open yet) is asked again this often. */
export const APP_INSTALL_RETRY_MS = 30_000;
/** Refused this many times in a row, the follow-up fails with the last reason. */
export const APP_INSTALL_MAX_ATTEMPTS = 10;
export const APP_DID_NOT_APPLY = "App update did not apply.";

const atLeast = (version: string, target: string): boolean => {
  if (parseSemver(version) === null || parseSemver(target) === null) return version === target;
  return compareSemverVersions(version, target) >= 0;
};

export type FollowUpDecision =
  | { readonly type: "none" }
  /** Write this record; then install when `install` is set. */
  | { readonly type: "write"; readonly record: RunAppRecord; readonly install: boolean };

const none: FollowUpDecision = { type: "none" };

function finished(
  own: RunAppRecord,
  appPhase: "done" | "failed",
  nowMs: number,
  message: string | null,
): RunAppRecord {
  const at = isoAt(nowMs);
  return { ...own, appPhase, message, updatedAt: at, finishedAt: at };
}

/** One look at a verified run's app half, made on every tick of the run loop. */
export function decideFollowUp(input: {
  readonly run: UpdateRunRecord;
  readonly app: RunAppRecord | null;
  readonly appVersion: string;
  readonly nowMs: number;
  /** An install call of this process is in flight. */
  readonly installing: boolean;
}): FollowUpDecision {
  const { run, appVersion, nowMs } = input;
  const target = run.appTargetVersion;
  if (run.phase !== "verified" || target === null) return none;
  const own = appForRun(run, input.app);
  if (own === null) {
    const record: RunAppRecord = {
      schemaVersion: 1,
      runId: run.runId,
      appTargetVersion: target,
      fromAppVersion: appVersion,
      appPhase: "installing",
      attempts: 0,
      message: null,
      updatedAt: isoAt(nowMs),
      finishedAt: null,
      reportedAt: null,
    };
    return atLeast(appVersion, target)
      ? { type: "write", record: finished(record, "done", nowMs, null), install: false }
      : { type: "write", record, install: true };
  }
  if (own.appPhase === "done" || own.appPhase === "failed") return none;
  if (atLeast(appVersion, target)) {
    return { type: "write", record: finished(own, "done", nowMs, null), install: false };
  }
  const since = nowMs - (isoMillis(own.updatedAt) ?? 0);
  if (input.installing) return none;
  if (own.appPhase === "relaunching") {
    return since >= APP_INSTALL_APPLY_MS
      ? { type: "write", record: finished(own, "failed", nowMs, APP_DID_NOT_APPLY), install: false }
      : none;
  }
  if (since < APP_INSTALL_RETRY_MS) return none;
  return { type: "write", record: { ...own, updatedAt: isoAt(nowMs) }, install: true };
}

/**
 * Written just before the install call: an accepted install may quit the app
 * before the call returns, so the record already says it is relaunching.
 */
export function beforeInstall(own: RunAppRecord, nowMs: number): RunAppRecord {
  return { ...own, appPhase: "relaunching", updatedAt: isoAt(nowMs) };
}

/** What an install call answered, recorded on the run's app half. */
export function afterInstall(
  own: RunAppRecord,
  result: { readonly accepted: boolean; readonly failed: boolean; readonly message: string | null },
  nowMs: number,
): RunAppRecord {
  const attempts = own.attempts + 1;
  if (result.accepted && !result.failed) {
    // The app quits now; a relaunched app settles the run.
    return { ...own, appPhase: "relaunching", attempts, message: null, updatedAt: isoAt(nowMs) };
  }
  if (result.failed || attempts >= APP_INSTALL_MAX_ATTEMPTS) {
    return finished({ ...own, attempts }, "failed", nowMs, result.message ?? APP_DID_NOT_APPLY);
  }
  return { ...own, attempts, message: result.message, updatedAt: isoAt(nowMs) };
}

/**
 * At startup, before the first update check: a relaunch into the target
 * finishes the run; a relaunch still on the old release reports that the app
 * update did not apply. An install that never got accepted is left to the
 * run loop, which asks again.
 */
export function reconcileOnStartup(input: {
  readonly run: UpdateRunRecord | null;
  readonly app: RunAppRecord | null;
  readonly appVersion: string;
  readonly nowMs: number;
}): RunAppRecord | null {
  const { run, app, appVersion, nowMs } = input;
  if (run === null || app === null) return null;
  const own = appForRun(run, app);
  if (own === null || own.appPhase === "done" || own.appPhase === "failed") return null;
  if (atLeast(appVersion, own.appTargetVersion)) return finished(own, "done", nowMs, null);
  if (own.appPhase === "relaunching") return finished(own, "failed", nowMs, APP_DID_NOT_APPLY);
  return null;
}

/** "Restart now" after a failed app half: the same run installs the app again. */
export function retryFollowUp(
  run: UpdateRunRecord,
  app: RunAppRecord | null,
  nowMs: number,
): RunAppRecord | null {
  const own = run.phase === "verified" ? appForRun(run, app) : null;
  if (own === null || own.appPhase !== "failed") return null;
  return {
    ...own,
    appPhase: "installing",
    attempts: 0,
    message: null,
    // Due at once: the retry interval counts from the last attempt.
    updatedAt: isoAt(nowMs - APP_INSTALL_RETRY_MS),
    finishedAt: null,
    reportedAt: null,
  };
}

/**
 * The app release a run is installing, which the macOS bundle-swap updater
 * keeps staged at startup instead of clearing it as a leftover. Null when no
 * run names one, or the running app already is that release.
 */
export function retainedAppVersion(
  app: RunAppRecord | null,
  runningVersion: string,
): string | null {
  if (app === null || (app.appPhase !== "installing" && app.appPhase !== "relaunching")) {
    return null;
  }
  return atLeast(runningVersion, app.appTargetVersion) ? null : app.appTargetVersion;
}
