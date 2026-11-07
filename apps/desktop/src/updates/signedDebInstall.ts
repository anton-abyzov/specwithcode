// @effect-diagnostics nodeBuiltinImport:off - electron-updater's install is synchronous, because a quit handler cannot wait.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Shipped by the .deb, with a polkit action that lets an active local session run it. */
export const UPDATE_HELPER_PATH = "/usr/lib/specwithcode/update-helper";
const UPDATE_ACTION = "com.specwithcode.studio.update";

const HELPER_NOT_NEWER = 3;
const PKEXEC_DISMISSED = 126;
const PKEXEC_NOT_AUTHORIZED = 127;
const HELPER_TIMEOUT_MS = 10 * 60 * 1000;

export interface SignedDebInstallTools {
  readonly exists: (path: string) => boolean;
  readonly writeSignature: (path: string, signature: Buffer) => void;
  readonly removeSignature: (path: string) => void;
  /** Whether polkit allows this process the helper with nobody there to authenticate. */
  readonly actionAllowed: () => boolean;
  readonly runHelper: (
    deb: string,
    signature: string,
  ) => {
    readonly error?: Error | undefined;
    readonly status: number | null;
    readonly stderr: string;
  };
}

/** The parts of electron-updater's DebUpdater this replaces and reads. */
export interface DebUpdaterInstall {
  doInstall(options: { readonly isForceRunAfter: boolean }): boolean;
  readonly downloadedUpdateHelper?: { readonly file: string | null } | null;
  readonly app: { relaunch(): void };
  on(event: "update-downloaded", listener: (info: DownloadedDeb) => void): unknown;
}

interface DownloadedDeb {
  readonly downloadedFile?: unknown;
  readonly debSignature?: unknown;
}

const liveTools: SignedDebInstallTools = {
  exists: (path) => NodeFS.existsSync(path),
  writeSignature: (path, signature) => NodeFS.writeFileSync(path, signature, { mode: 0o600 }),
  removeSignature: (path) => NodeFS.rmSync(path, { force: true }),
  actionAllowed: () =>
    NodeChildProcess.spawnSync(
      "/usr/bin/pkcheck",
      ["--action-id", UPDATE_ACTION, "--process", String(process.pid)],
      { stdio: "ignore", timeout: 10_000 },
    ).status === 0,
  runHelper: (deb, signature) =>
    NodeChildProcess.spawnSync(
      "/usr/bin/pkexec",
      ["--disable-internal-agent", UPDATE_HELPER_PATH, deb, signature],
      { encoding: "utf8", timeout: HELPER_TIMEOUT_MS },
    ),
};

const signaturePath = (deb: string) => `${deb}.sig`;

export type UnattendedDebInstallReadiness =
  | "ready"
  | "no-helper"
  | "no-signature"
  | "needs-authentication";

/**
 * Whether installing this download can raise no prompt. Anything but "ready" means a person has to
 * be there: an install started anyway may open the password dialog (installSignedDeb). A caller with
 * nobody at the machine asks this first, right before the install, for a version newer than this one.
 */
export function unattendedDebInstallReadiness(
  deb: string,
  tools: SignedDebInstallTools = liveTools,
): UnattendedDebInstallReadiness {
  if (!tools.exists(UPDATE_HELPER_PATH)) return "no-helper";
  if (!tools.exists(signaturePath(deb))) return "no-signature";
  return tools.actionAllowed() ? "ready" : "needs-authentication";
}

/** "installed", or "password" when only the updater's own password prompt can go on. */
export function installSignedDeb(
  deb: string,
  tools: SignedDebInstallTools = liveTools,
): "installed" | "password" {
  if (!tools.exists(UPDATE_HELPER_PATH)) return "password";
  // Never the prompt here: a package that lost its signature must not become a password request.
  if (!tools.exists(signaturePath(deb))) {
    throw new Error(
      `The update ${NodePath.basename(deb)} has no signature, so it was not installed.`,
    );
  }
  const result = tools.runHelper(deb, signaturePath(deb));
  if (result.error !== undefined && result.status === null) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return "password";
    throw result.error;
  }
  switch (result.status) {
    case 0:
      return "installed";
    // Not an active local session, or a downgrade someone chose. Both still need a person.
    case HELPER_NOT_NEWER:
    case PKEXEC_DISMISSED:
    case PKEXEC_NOT_AUTHORIZED:
      return "password";
    default:
      throw new Error(result.stderr.trim() || `The update helper exited with ${result.status}.`);
  }
}

/** Keeps the feed's signature beside the file it signs: the record of the latest check may be newer. */
export function saveFeedSignature(
  info: DownloadedDeb,
  tools: SignedDebInstallTools = liveTools,
): void {
  if (typeof info.downloadedFile !== "string") return;
  const path = signaturePath(info.downloadedFile);
  if (typeof info.debSignature === "string" && info.debSignature !== "") {
    tools.writeSignature(path, Buffer.from(info.debSignature, "base64"));
  } else {
    tools.removeSignature(path);
  }
}

/** Sends a .deb install through the helper; everything else about the updater stays as it is. */
export function useSignedDebInstall(
  updater: DebUpdaterInstall,
  tools: SignedDebInstallTools = liveTools,
): void {
  updater.on("update-downloaded", (info) => saveFeedSignature(info, tools));
  const passwordInstall = updater.doInstall.bind(updater);
  updater.doInstall = (options) => {
    const deb = updater.downloadedUpdateHelper?.file;
    if (typeof deb !== "string" || installSignedDeb(deb, tools) === "password") {
      return passwordInstall(options);
    }
    if (options.isForceRunAfter) updater.app.relaunch();
    return true;
  };
}

/** electron-builder's marker for the package format, the same file electron-updater reads. */
export function isDebInstall(resourcesPath: string): boolean {
  try {
    const marker = NodePath.join(resourcesPath, "package-type");
    return NodeFS.readFileSync(marker, "utf8").trim() === "deb";
  } catch {
    return false;
  }
}
