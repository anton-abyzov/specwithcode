// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

export const pathExists = (path: string): boolean => NodeFS.existsSync(path);

/** Null off Linux, or when the link cannot be read. */
export const readRunningExecutableLink = (): string | null => {
  if (process.platform !== "linux") return null;
  try {
    return NodeFS.readlinkSync("/proc/self/exe");
  } catch {
    return null;
  }
};

export const runningInstallReplaced = (
  executableLink: string | null = readRunningExecutableLink(),
  execPath: string = process.execPath,
  fileExists: (path: string) => boolean = pathExists,
): boolean => Boolean(executableLink?.endsWith(" (deleted)")) && fileExists(execPath);

/**
 * A package install (`dpkg -i`, `apt`) replaced this app's binary while it ran.
 * The running code stays old until the app restarts, and its updater can only
 * repeat what failed, so restarting is what finishes the update. Runs in place
 * of the updater's install, after the update flow's gates and restart marker.
 * Returns false, leaving the install to the updater, when there is nothing to
 * relaunch into: the package moved or was removed.
 */
export function relaunchIntoReplacedInstall(input: {
  readonly executableLink: string | null;
  readonly execPath: string;
  readonly fileExists: (path: string) => boolean;
  readonly relaunch: () => void;
}): boolean {
  if (!runningInstallReplaced(input.executableLink, input.execPath, input.fileExists)) return false;
  input.relaunch();
  return true;
}
