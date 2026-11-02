// @effect-diagnostics-next-line nodeBuiltinImport:off -- Reading the system journal needs a child process.
import { execFile } from "node:child_process";

import type { DesktopUpdateInstallFailure } from "@specweave-studio/contracts";
import { compareSemverVersions } from "@specweave-studio/shared/semver";

import { scrubUpdateText } from "./desktopUpdateErrors.ts";

/**
 * What an install left behind for the next launch. electron-updater quits the app even when the
 * package manager refused the file (DebUpdater then runs `apt-get install -f`, which succeeds), so
 * the only sign of that failure is the relaunched app still running the old version.
 */
export interface DesktopInstallAttempt {
  readonly targetVersion: string;
  readonly fromVersion: string;
  readonly at: string;
}

export const INSTALL_ATTEMPT_FILE = "update-install-attempt.json";
export const INSTALL_FAILURE_FILE = "update-install-failure.json";

const NO_EVIDENCE = "The installer ended without installing it and left no error on this machine.";
const MAX_REASON_LENGTH = 400;
const JOURNAL_WINDOW_SECONDS = 180;
const INSTALLER_ERROR =
  /^(dpkg(-deb)?: .*error|E: |rpm: |Command (pkexec|sudo|gksudo|kdesudo) exited with code|dpkg installation failed)/i;

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function serializeInstallRecord(
  record: DesktopInstallAttempt | DesktopUpdateInstallFailure,
): string {
  return JSON.stringify(record);
}

export function parseInstallAttempt(text: string): DesktopInstallAttempt | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return isString(value.targetVersion) && isString(value.fromVersion) && isString(value.at)
      ? { targetVersion: value.targetVersion, fromVersion: value.fromVersion, at: value.at }
      : null;
  } catch {
    return null;
  }
}

export function parseInstallFailure(text: string): DesktopUpdateInstallFailure | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return isString(value.targetVersion) && isString(value.reason) && isString(value.at)
      ? { targetVersion: value.targetVersion, reason: value.reason, at: value.at }
      : null;
  } catch {
    return null;
  }
}

/** The installer's own words out of the journal: its errors first, then its exit lines. */
export function installerErrorFromLog(log: string): string | null {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => INSTALLER_ERROR.test(line));
  const line = lines.find((candidate) => /error/i.test(candidate)) ?? lines[0];
  return line === undefined ? null : scrubUpdateText(line).slice(0, MAX_REASON_LENGTH);
}

/** What the relaunch learned: null when the attempted version is the one running. */
export function diagnoseInstallAttempt(input: {
  readonly attempt: DesktopInstallAttempt;
  readonly runningVersion: string;
  readonly installerError: string | null;
}): DesktopUpdateInstallFailure | null {
  const { attempt, runningVersion, installerError } = input;
  if (versionReached(runningVersion, attempt.targetVersion)) return null;
  return {
    targetVersion: attempt.targetVersion,
    at: attempt.at,
    reason: `${attempt.targetVersion} did not install, this app still runs ${runningVersion}. ${
      installerError ?? NO_EVIDENCE
    }`,
  };
}

/** True once `running` has reached `target`, so a failure to install `target` no longer applies. */
export function versionReached(running: string, target: string): boolean {
  return compareSemverVersions(running, target) >= 0;
}

export type ReadJournal = (sinceSeconds: number, untilSeconds: number) => Promise<string>;

const readJournal: ReadJournal = (sinceSeconds, untilSeconds) =>
  new Promise((resolve) => {
    execFile(
      "journalctl",
      [
        `--since=@${sinceSeconds}`,
        `--until=@${untilSeconds}`,
        // Only this user's processes: apt-daily and the like hold their own errors.
        ...(process.getuid ? [`_UID=${process.getuid()}`] : []),
        "--no-pager",
        "-q",
        "-o",
        "cat",
      ],
      { timeout: 2_000, maxBuffer: 8 << 20, windowsHide: true },
      (_error, stdout) => resolve(String(stdout ?? "")),
    );
  });

/** Looks on this machine for why the attempt failed. Linux keeps the installer's output in the journal. */
export async function investigateInstallAttempt(
  attempt: DesktopInstallAttempt,
  platform: string,
  read: ReadJournal = readJournal,
): Promise<string | null> {
  if (platform !== "linux") return null;
  const since = Math.floor(Date.parse(attempt.at) / 1000);
  if (!Number.isFinite(since)) return null;
  return installerErrorFromLog(await read(since, since + JOURNAL_WINDOW_SECONDS));
}
