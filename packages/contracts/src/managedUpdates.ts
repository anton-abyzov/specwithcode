import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

export const ManagedInstallationId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  Schema.isMinLength(1),
);
export const ManagedConsentRevision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const ManagedUpdateTarget = Schema.Struct({
  installationId: ManagedInstallationId,
  environmentId: EnvironmentId,
});
export type ManagedUpdateTarget = typeof ManagedUpdateTarget.Type;
export const ManagedUpdateMutation = Schema.Struct({
  ...ManagedUpdateTarget.fields,
  expectedRevision: ManagedConsentRevision,
});
export type ManagedUpdateMutation = typeof ManagedUpdateMutation.Type;
export const ManagedUpdateEnrollment = Schema.Struct({
  ...ManagedUpdateMutation.fields,
  consent: Schema.Literal(true),
});
export type ManagedUpdateEnrollment = typeof ManagedUpdateEnrollment.Type;

/** Reachability is a client transport state. A failed read never means no consent. */
export const ManagedUpdateStatus = Schema.Struct({
  environmentId: EnvironmentId,
  installationId: Schema.NullOr(ManagedInstallationId),
  support: Schema.Literals(["supported", "unsupported", "unmanaged"]),
  localAutomation: Schema.Literals(["enabled", "disabled", "unavailable"]),
  remoteConsent: Schema.Literals(["not-enrolled", "enrolled", "other-controller", "revoked"]),
  revision: ManagedConsentRevision,
  operation: Schema.Literals([
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "downloaded",
    "waiting-for-quiet",
    "installing",
    "installed",
    "manual-required",
    "error",
    "disabled",
  ]),
  currentVersion: Schema.NullOr(Schema.String),
  availableVersion: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  /**
   * Whether launchd has the update agent's job loaded now; null when it could
   * not be read (not macOS). Absent from older services.
   */
  agentLoaded: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** The agent's label is turned off with `launchctl disable`. Absent from older services. */
  agentDisabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /**
   * Automatic checks are on but the agent's last check is older than twice
   * its check interval, so `operation` and `checkedAt` are frozen.
   */
  stale: Schema.optionalKey(Schema.Boolean),
});
export type ManagedUpdateStatus = typeof ManagedUpdateStatus.Type;
export class ManagedUpdateError extends Schema.TaggedError<ManagedUpdateError>()(
  "ManagedUpdateError",
  {
    code: Schema.Literals([
      "unauthorized",
      "unsupported",
      "unmanaged",
      "binding-changed",
      "conflict",
      "approval-required",
      "revoked",
      "busy",
      "unavailable",
    ]),
  },
) {}

export const ManagedUpdateLocalConsentRequest = Schema.Struct({
  ...ManagedUpdateMutation.fields,
  action: Schema.Literals(["enroll", "revoke"]),
});
export type ManagedUpdateLocalConsentRequest = typeof ManagedUpdateLocalConsentRequest.Type;

/**
 * How Studio applies updates, shared by the desktop app and the Studio
 * service it attaches to. Older desktop builds have no preferences.
 */
export interface DesktopUpdatePreferences {
  /** Look for new releases in the background. Off stops every automatic step. */
  checkAutomatically: boolean;
  /** Download a found release in the background instead of waiting for a click. */
  downloadAutomatically: boolean;
  /**
   * Install without asking: the app when it quits, the service at a quiet
   * moment (no session working for a while).
   */
  installAutomatically: boolean;
  /**
   * False when this build keeps self-update off (SPECWITHCODE_DISABLE_AUTO_UPDATE or STUDIO_DISABLE_AUTO_UPDATE),
   * so nothing runs on its own and the switches above report off. Absent on
   * desktop apps from before it was reported.
   */
  automaticUpdatesAllowed?: boolean;
  /**
   * How long "Restart when idle" waits for running work, in minutes. After
   * it, the work is stopped for the update and resumes after the restart.
   * Absent on desktop apps from before it was added (2 minutes).
   */
  forceInstallAfterMinutes?: number;
}

export const DesktopUpdatePreferencesSchema = Schema.Struct({
  checkAutomatically: Schema.Boolean,
  downloadAutomatically: Schema.Boolean,
  installAutomatically: Schema.Boolean,
  automaticUpdatesAllowed: Schema.optionalKey(Schema.Boolean),
  forceInstallAfterMinutes: Schema.optionalKey(Schema.Number),
});

export const DesktopUpdatePreferencesPatchSchema = Schema.Struct({
  checkAutomatically: Schema.optionalKey(Schema.Boolean),
  downloadAutomatically: Schema.optionalKey(Schema.Boolean),
  installAutomatically: Schema.optionalKey(Schema.Boolean),
  forceInstallAfterMinutes: Schema.optionalKey(Schema.Number),
});
export type DesktopUpdatePreferencesPatch = typeof DesktopUpdatePreferencesPatchSchema.Type;

/**
 * Background updates of the fleet-installed Studio service on this computer,
 * applied by its own update agent (a launchd job beside the service). The
 * desktop reports the agent's state file; `not-managed` means no installed
 * service was found here, so there is nothing for this computer to update.
 */
export const StudioServiceUpdateStatusSchema = Schema.Literals([
  "not-managed",
  "starting",
  "disabled",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
  "installed",
  "manual-required",
  "error",
]);
export type StudioServiceUpdateStatus = typeof StudioServiceUpdateStatusSchema.Type;

export const StudioServicePendingInstallSchema = Schema.Struct({
  /** When the request was written (ISO). */
  requestedAt: Schema.String,
  /** `force`: the work was stopped and held for it, so the agent retries until `holdUntil`. */
  mode: Schema.Literals(["normal", "force"]),
  /** The version the request installs; null for requests not tied to one. */
  version: Schema.NullOr(Schema.String),
  holdUntil: Schema.NullOr(Schema.String),
  /** The agent has taken the request up and is installing it. */
  handled: Schema.Boolean,
});
export type StudioServicePendingInstall = typeof StudioServicePendingInstallSchema.Type;

export const StudioServiceUpdateStateSchema = Schema.Struct({
  status: StudioServiceUpdateStatusSchema,
  /** Fleet identity of the service, such as `m4`. */
  identity: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  /** Start of the current quiet period while an install waits for one. */
  quietSince: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  lastInstall: Schema.NullOr(
    Schema.Struct({
      version: Schema.String,
      at: Schema.String,
      result: Schema.Literals(["updated", "failed"]),
    }),
  ),
  /**
   * When the agent last wrote its state. A state older than an install request
   * is the agent's answer to an earlier request. Absent from older desktops.
   */
  updatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * The install request some window wrote that the agent has not finished:
   * every window follows it instead of asking again. Null when there is none
   * (or it was cancelled or lapsed). The renderer is bundled with the desktop
   * and relies on it: that desktop reports it for every installed service, and
   * a state without it (no service here, or a desktop before 1.0.63, which
   * never runs this renderer) reads as no request pending.
   */
  pendingInstall: Schema.optionalKey(Schema.NullOr(StudioServicePendingInstallSchema)),
  /**
   * The error is the desktop's own: it could not start the agent (or save the
   * request), and the agent has written nothing since. False in every other
   * state the desktop reports. The renderer is bundled with the desktop and
   * relies on it: a state without it (from a desktop before this field, which
   * never runs this renderer) reads as no such failure.
   */
  agentStartFailed: Schema.optionalKey(Schema.Boolean),
});
export type StudioServiceUpdateState = typeof StudioServiceUpdateStateSchema.Type;
