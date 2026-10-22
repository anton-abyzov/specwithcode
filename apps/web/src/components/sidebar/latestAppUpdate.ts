import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@specweave-studio/contracts";

type UpdateBridge = Pick<DesktopBridge, "checkForUpdate" | "downloadUpdate" | "getUpdateState">;
type InstallBridge = Pick<DesktopBridge, "installUpdate" | "getUpdateState">;

/** How long a restart waits for a newer release to finish downloading. */
export const LATEST_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;

export type LatestUpdateProgress =
  | { readonly phase: "checking" }
  | { readonly phase: "downloading"; readonly version: string; readonly percent: number | null }
  /** The updater is finishing another step (a check or download) before it installs. */
  | { readonly phase: "waiting"; readonly version: string | null; readonly percent: number | null };

export type LatestUpdateResult =
  /** Install this downloaded version; it is the newest the feed offers. */
  | { readonly kind: "ready"; readonly version: string; readonly state: DesktopUpdateState }
  /** A newer release replaced the download but could not be fetched. */
  | { readonly kind: "failed"; readonly message: string; readonly state: DesktopUpdateState };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the feed for the newest release right before an update restart, so a
 * download that waited (1.0.29) is replaced by the newest one (1.0.30 or
 * later) instead of installing it and updating again. Updates are full app
 * bundles, so versions in between are skipped. When the check cannot run
 * (offline, or the updater is busy) the existing download is used.
 */
export async function ensureLatestAppUpdate(
  bridge: UpdateBridge,
  onProgress: (progress: LatestUpdateProgress) => void = () => undefined,
  timeoutMs = LATEST_DOWNLOAD_TIMEOUT_MS,
): Promise<LatestUpdateResult> {
  onProgress({ phase: "checking" });
  let state = await bridge
    .checkForUpdate()
    .then((result) => result.state)
    .catch(() => null);
  state ??= await bridge.getUpdateState();

  if (state.status === "available" && state.availableVersion !== null) {
    onProgress({ phase: "downloading", version: state.availableVersion, percent: null });
    // Refused when a background download already started; the wait below follows it.
    state = await bridge
      .downloadUpdate()
      .then((result) => result.state)
      .catch(() => state!);
  }

  const deadline = Date.now() + timeoutMs;
  while (state.status === "downloading" || state.status === "checking") {
    if (Date.now() > deadline) {
      return { kind: "failed", message: "The newest release is still downloading.", state };
    }
    if (state.status === "downloading" && state.availableVersion !== null) {
      onProgress({
        phase: "downloading",
        version: state.availableVersion,
        percent: state.downloadPercent,
      });
    }
    await sleep(POLL_MS);
    state = await bridge.getUpdateState();
  }

  if (state.downloadedVersion !== null) {
    return { kind: "ready", version: state.downloadedVersion, state };
  }
  return {
    kind: "failed",
    message: state.message?.trim() || "The newest release could not be downloaded.",
    state,
  };
}

/** How long a restart waits for the updater to finish another step. */
export const UPDATER_BUSY_WAIT_MS = 2 * 60_000;
const BUSY_RETRY_MS = 1_000;

/**
 * Installs the downloaded update, waiting while the updater finishes another
 * step instead of failing with "busy": a background check or download holds
 * the updater for a moment, and the restart goes ahead once it lets go.
 */
export async function installWhenUpdaterFree(
  bridge: InstallBridge,
  expectedVersion: string | null,
  onProgress: (progress: LatestUpdateProgress) => void = () => undefined,
  timeoutMs = UPDATER_BUSY_WAIT_MS,
  // The app installs alone because the service's agent lacks the release:
  // main may then let it go ahead of the service (appActivationGate.ts).
  serviceLacksRelease = false,
): Promise<DesktopUpdateActionResult> {
  const deadline = Date.now() + timeoutMs;
  const options = expectedVersion
    ? { expectedVersion, ...(serviceLacksRelease ? { serviceLacksRelease: true } : {}) }
    : undefined;
  for (;;) {
    const result = await bridge.installUpdate(options);
    if (result.accepted || result.reason !== "busy" || Date.now() >= deadline) return result;
    const state = await bridge.getUpdateState().catch(() => result.state);
    onProgress({
      phase: "waiting",
      version: state.availableVersion ?? expectedVersion,
      percent: state.status === "downloading" ? state.downloadPercent : null,
    });
    await sleep(BUSY_RETRY_MS);
  }
}
