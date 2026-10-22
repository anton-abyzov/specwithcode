import * as Schema from "effect/Schema";

import {
  type DesktopRuntimeArch,
  type DesktopUpdateState,
  DesktopUpdateStateSchema,
} from "./desktopUpdateState.ts";

/** What the window asks of the desktop app's own updater, and what it answers. */

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface StudioServiceInstallOptions {
  /**
   * The caller has stopped and held the service's work. The agent retries the
   * install every few seconds until the service is quiet or `holdUntil`
   * passes, rather than waiting for a quiet period on its own schedule.
   */
  readonly force?: boolean;
  /** ISO time the service's update hold expires; the agent stops retrying then. */
  readonly holdUntil?: string;
  /**
   * The service version the user was shown. The agent installs only this
   * version, and only if it starts within 10 minutes; older desktops ignore it.
   */
  readonly version?: string;
  /**
   * The run (updates/run.json) this request belongs to, made by the window's
   * `serviceUpdateRun` begin. The desktop then writes the run's deadline as
   * the hold and names the run to the agent; older desktops ignore it.
   */
  readonly runId?: string;
}

/**
 * Why an install request was not accepted: another update step holds the
 * updater (`busy`), the app is already quitting, there is no downloaded
 * update to install (`no-download`), updates are off in this build, or the
 * local service does not run the downloaded release yet (`service-behind`).
 */
export const DesktopUpdateRefusalReasonSchema = Schema.Literals([
  "busy",
  "quitting",
  "no-download",
  "disabled",
  "service-behind",
]);
export type DesktopUpdateRefusalReason = typeof DesktopUpdateRefusalReasonSchema.Type;

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  /** Install only: the accepted install failed and the app stayed open. */
  failed?: boolean;
  /** Install only: why the request was refused. */
  reason?: DesktopUpdateRefusalReason;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  failed: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(DesktopUpdateRefusalReasonSchema),
  state: DesktopUpdateStateSchema,
});

export const DesktopUpdateInstallOptionsSchema = Schema.Struct({
  /**
   * Install only this downloaded version. A request made while a background
   * check runs then waits for the check instead of being refused.
   */
  expectedVersion: Schema.optionalKey(Schema.String),
  /**
   * The press installs the app alone because the service's update agent lacks
   * this release: its request failed for want of it. Main then lets the app
   * swap ahead of the service, but only while the agent's own state agrees it
   * has no such release (appActivationGate.ts, `service-lacks-release`).
   */
  serviceLacksRelease: Schema.optionalKey(Schema.Boolean),
});
export type DesktopUpdateInstallOptions = typeof DesktopUpdateInstallOptionsSchema.Type;

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});
