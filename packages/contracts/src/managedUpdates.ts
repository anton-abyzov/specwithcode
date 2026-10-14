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
   * False when this build keeps self-update off (STUDIO_DISABLE_AUTO_UPDATE),
   * so nothing runs on its own and the switches above report off. Absent on
   * desktop apps from before it was reported.
   */
  automaticUpdatesAllowed?: boolean;
}

export const DesktopUpdatePreferencesSchema = Schema.Struct({
  checkAutomatically: Schema.Boolean,
  downloadAutomatically: Schema.Boolean,
  installAutomatically: Schema.Boolean,
  automaticUpdatesAllowed: Schema.optionalKey(Schema.Boolean),
});

export const DesktopUpdatePreferencesPatchSchema = Schema.Struct({
  checkAutomatically: Schema.optionalKey(Schema.Boolean),
  downloadAutomatically: Schema.optionalKey(Schema.Boolean),
  installAutomatically: Schema.optionalKey(Schema.Boolean),
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
});
export type StudioServiceUpdateState = typeof StudioServiceUpdateStateSchema.Type;
