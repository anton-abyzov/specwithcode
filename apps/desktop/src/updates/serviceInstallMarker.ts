// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native install-marker discovery runs before the managed service is started.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native install-marker discovery runs before the managed service is started.
import * as NodePath from "node:path";

/**
 * The update agent writes `<studioHome>/updates/install-in-progress.json`
 * before it runs the install helper and removes it once the install settles
 * (scripts/studio-fleet/update_agent.py). While it is there the helper may
 * have stopped the service to restart it on the new release.
 */
const SERVICE_INSTALL_MARKER = NodePath.join("updates", "install-in-progress.json");
const SERVICE_INSTALL_RECEIPTS = NodePath.join("updates", "receipts");

/**
 * The agent waits 40 minutes for the install helper (update_agent.py
 * APPLY_TIMEOUT, 25 minutes in agents up to 1.0.112); inside this window a
 * marker alone means an install is running.
 */
export const SERVICE_INSTALL_WINDOW_MS = 40 * 60_000;

/**
 * Past that the agent stops waiting but leaves the helper to finish its restart
 * or rollback, and keeps the marker until the helper exits. The helper names its
 * own pid in its receipt (update.py `helperPid`); while that process lives the
 * install still runs, up to this age, so a reused pid cannot hold anyone forever.
 */
export const SERVICE_INSTALL_LIMIT_MS = 60 * 60_000;

export interface ServiceInstallMarkerFile {
  readonly text: string;
  readonly mtimeMs: number;
}

export interface ServiceInstallMarkerIo {
  readonly readFile: (path: string) => ServiceInstallMarkerFile | null;
  readonly isProcessAlive: (pid: number) => boolean;
}

function readMarkerFile(path: string): ServiceInstallMarkerFile | null {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) return null;
    return { text: NodeFS.readFileSync(path, "utf8"), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

// The helper runs as the same user as the app, so only a process this user may
// signal counts: EPERM means the pid now belongs to someone else.
function isOwnProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const defaultIo: ServiceInstallMarkerIo = {
  readFile: readMarkerFile,
  isProcessAlive: isOwnProcessAlive,
};

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The helper named in the marker's receipt is still running. */
function helperStillRuns(studioHome: string, receipt: unknown, io: ServiceInstallMarkerIo) {
  if (typeof receipt !== "string" || !NodePath.isAbsolute(receipt)) return false;
  // Only a receipt the agent keeps for this home, never a path pointing elsewhere.
  const resolved = NodePath.resolve(receipt);
  if (NodePath.dirname(resolved) !== NodePath.resolve(studioHome, SERVICE_INSTALL_RECEIPTS)) {
    return false;
  }
  const file = io.readFile(resolved);
  const helperPid = file === null ? undefined : parseObject(file.text)?.helperPid;
  return (
    typeof helperPid === "number" &&
    Number.isSafeInteger(helperPid) &&
    helperPid > 1 &&
    helperPid !== process.pid &&
    io.isProcessAlive(helperPid)
  );
}

/**
 * An update is installing over the service in `studioHome` right now. The
 * marker's `at` dates it; a marker being written, or one without a usable time,
 * dates from its file. A marker inside the install window either side of `now`
 * counts; an older one only while its helper still runs, up to the limit. So a
 * crashed agent, a reused pid or a wrong clock cannot hold anyone forever.
 */
export function serviceInstallInProgress(
  studioHome: string,
  nowMs: number,
  io: ServiceInstallMarkerIo = defaultIo,
): boolean {
  const marker = io.readFile(NodePath.join(studioHome, SERVICE_INSTALL_MARKER));
  if (marker === null) return false;
  const value = parseObject(marker.text);
  let at = typeof value?.at === "string" ? Date.parse(value.at) : Number.NaN;
  // Still being written: its file time stands in.
  if (!Number.isFinite(at)) at = marker.mtimeMs;
  const age = nowMs - at;
  if (age > -SERVICE_INSTALL_WINDOW_MS && age < SERVICE_INSTALL_WINDOW_MS) return true;
  return (
    age >= SERVICE_INSTALL_WINDOW_MS &&
    age < SERVICE_INSTALL_LIMIT_MS &&
    helperStillRuns(studioHome, value?.receipt, io)
  );
}
