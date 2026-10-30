import { DESKTOP_INSTALL_APPLY_MS } from "@specweave-studio/contracts";
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
export const APP_INSTALL_APPLY_MS = DESKTOP_INSTALL_APPLY_MS;
/** A refused install (the release not on disk yet, say) is asked again this often. */
export const APP_INSTALL_RETRY_MS = 30_000;
/**
 * Refused this many times in a row at that interval, the follow-up fails with
 * the last reason. The waits between those attempts are the follow-up's whole
 * budget for refusals, whatever their interval.
 */
export const APP_INSTALL_MAX_ATTEMPTS = 10;
export const APP_INSTALL_RETRY_BUDGET_MS = (APP_INSTALL_MAX_ATTEMPTS - 1) * APP_INSTALL_RETRY_MS;
/**
 * A busy updater, or a gate that has not seen the verified service yet, lets
 * go within seconds: those refusals are asked again after 1, 2, then every 5
 * seconds instead of 30, inside the same budget.
 */
export const APP_INSTALL_QUICK_RETRY_MS: ReadonlyArray<number> = [1_000, 2_000, 5_000];
const QUICK_REFUSALS: ReadonlySet<string> = new Set(["busy", "service-behind"]);
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
  if (since < (own.retryDelayMs ?? APP_INSTALL_RETRY_MS)) return none;
  return { type: "write", record: { ...own, updatedAt: isoAt(nowMs) }, install: true };
}

/**
 * Written just before the install call: an accepted install may quit the app
 * before the call returns, so the record already says it is relaunching.
 */
export function beforeInstall(own: RunAppRecord, nowMs: number): RunAppRecord {
  return { ...own, appPhase: "relaunching", updatedAt: isoAt(nowMs) };
}

/**
 * The wait before the next attempt after a refusal: quick for a refusal that
 * clears within seconds, counting the quick refusals in a row, else the
 * regular interval.
 */
export function retryDelayAfter(
  own: Pick<RunAppRecord, "retryDelayMs">,
  reason: string | null | undefined,
): number {
  if (reason === undefined || reason === null || !QUICK_REFUSALS.has(reason)) {
    return APP_INSTALL_RETRY_MS;
  }
  const quick = APP_INSTALL_QUICK_RETRY_MS;
  const previous = own.retryDelayMs === undefined ? -1 : quick.indexOf(own.retryDelayMs);
  return quick[Math.min(previous + 1, quick.length - 1)]!;
}

/** What an install call answered, recorded on the run's app half. */
export function afterInstall(
  own: RunAppRecord,
  result: {
    readonly accepted: boolean;
    readonly failed: boolean;
    readonly message: string | null;
    /** Why main refused it ("busy", "service-behind", ...), when it said. */
    readonly reason?: string | null;
  },
  nowMs: number,
): RunAppRecord {
  const attempts = own.attempts + 1;
  if (result.accepted && !result.failed) {
    // The app quits now; a relaunched app settles the run.
    return { ...own, appPhase: "relaunching", attempts, message: null, updatedAt: isoAt(nowMs) };
  }
  const retryDelayMs = retryDelayAfter(own, result.reason);
  // A record from before quick retries waited the regular interval each time.
  const retryWaitMs = (own.retryWaitMs ?? own.attempts * APP_INSTALL_RETRY_MS) + retryDelayMs;
  if (result.failed || retryWaitMs > APP_INSTALL_RETRY_BUDGET_MS) {
    return finished({ ...own, attempts }, "failed", nowMs, result.message ?? APP_DID_NOT_APPLY);
  }
  return {
    ...own,
    attempts,
    message: result.message,
    updatedAt: isoAt(nowMs),
    retryDelayMs,
    retryWaitMs,
  };
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
  // A new budget: the waits of the failed attempts are over.
  const { retryDelayMs: _delay, retryWaitMs: _waited, ...rest } = own;
  return {
    ...rest,
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
