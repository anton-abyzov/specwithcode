import type {
  DesktopUpdatePreferences,
  DesktopUpdatePreferencesPatch,
  ManagedUpdateLocalConsentRequest,
  ManagedUpdateStatus,
  StudioServiceUpdateState,
} from "./managedUpdates.ts";
import type { DesktopUpdateChannel, DesktopUpdateState } from "./desktopUpdateState.ts";
import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopRestartTraceMark,
  DesktopUpdateInstallOptions,
  StudioServiceInstallOptions,
} from "./desktopUpdateActions.ts";
import type {
  StudioServiceUpdateRunAction,
  StudioServiceUpdateRunResult,
} from "./serviceUpdateRun.ts";

/**
 * The desktop bridge's update methods: the app's own updater, its update
 * preferences, and the update agent of the Studio service on this computer.
 * Split from DesktopBridge (ipc.ts), which extends it.
 */
export interface DesktopUpdateBridge {
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  /**
   * Checks only when the last check is over a minute old and automatic checks
   * are on; for opening the Settings page with the version row. Absent on
   * desktop builds predating it.
   */
  checkForUpdateIfStale?: () => Promise<void>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: (options?: DesktopUpdateInstallOptions) => Promise<DesktopUpdateActionResult>;
  /**
   * Writes one timed step of a "Restart to update" press to the desktop's
   * trace, so a press can be timed afterwards. Absent on older desktops.
   */
  markRestartTrace?: (mark: DesktopRestartTraceMark) => Promise<void>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /** Update preferences; absent on desktop builds predating them. */
  requestManagedUpdateConsent?: (
    input: ManagedUpdateLocalConsentRequest,
  ) => Promise<ManagedUpdateStatus | null>;
  getUpdatePreferences?: () => Promise<DesktopUpdatePreferences>;
  setUpdatePreferences?: (
    patch: DesktopUpdatePreferencesPatch,
  ) => Promise<DesktopUpdatePreferences>;
  /** Background updates of the Studio service installed on this computer. */
  getServiceUpdateState?: () => Promise<StudioServiceUpdateState>;
  checkServiceUpdate?: () => Promise<StudioServiceUpdateState>;
  /**
   * Asks the update agent to install now. `force` keeps it retrying until the
   * drained service is quiet enough to snapshot, instead of waiting for quiet.
   */
  installServiceUpdate?: (
    options?: StudioServiceInstallOptions,
  ) => Promise<StudioServiceUpdateState>;
  /**
   * Withdraws a pending install request; absent on older desktop builds.
   * Rejects when the withdrawal could not be saved.
   */
  cancelServiceUpdate?: () => Promise<StudioServiceUpdateState>;
  /**
   * Settings' Repair of this Mac's update agent (launchctl enable, bootstrap,
   * kickstart), only on a person's click; absent on desktops without Repair.
   */
  repairServiceUpdateAgent?: () => Promise<StudioServiceUpdateState>;
  /**
   * "Later" on an automatic install waiting for running work: the agent pauses
   * that work no sooner than an hour from now. Writes the agent's config only
   * and starts nothing. Absent on desktops before automatic pauses; rejects
   * when the postponement could not be saved.
   */
  postponeAutomaticServiceUpdate?: () => Promise<StudioServiceUpdateState>;
  onServiceUpdateState?: (listener: (state: StudioServiceUpdateState) => void) => () => void;
  /**
   * One Update now press as a durable run (updates/run.json): `begin` creates
   * it, or answers the run already going; absent on desktops before runs.
   * `supported: false` means this Mac's update agent is older: the window
   * then updates the way it did before runs.
   */
  serviceUpdateRun?: (
    action: StudioServiceUpdateRunAction,
  ) => Promise<StudioServiceUpdateRunResult>;
}
