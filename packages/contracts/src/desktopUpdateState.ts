import * as Schema from "effect/Schema";

import { StudioServiceUpdateStatusSchema } from "./managedUpdates.ts";

/** The desktop app's own update state, as its main process reports it to the window. */

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopUpdateChannel = "latest" | "nightly";

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  omittedReleaseCount: number;
  downloadPercent: number | null;
  checkedAt: string | null;
  /**
   * When the feed last answered (a release found, or none newer). Unlike
   * `checkedAt`, a check that failed or is still running leaves it as it was.
   * Absent from older desktops.
   */
  feedCheckedAt?: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  /**
   * The running app is a packaged production build. A dev or unpackaged build
   * reports its plain package version, which may not be released yet.
   */
  productionBuild?: boolean;
  /**
   * Whether the downloaded release may replace the app now. The local service
   * updates first: until it runs this release, the app neither installs on
   * quit nor restarts into it. Absent from older desktops.
   */
  swapGate?: DesktopAppSwapGate;
}

/**
 * `closed` holds the app swap only; the app keeps running against the older
 * service. `service-unknown`: a managed service exists but its version could
 * not be read. `service-manual`: the service needs a manual step, so the app
 * no longer waits for it. `service-lacks-release`: a press installs the app
 * alone because the service's agent has no such release to install.
 */
export const DesktopAppSwapGateSchema = Schema.Struct({
  gate: Schema.Literals(["open", "closed"]),
  reason: Schema.Literals([
    "no-local-service",
    "not-a-release",
    "service-current",
    "service-behind",
    "service-unknown",
    "service-manual",
    "service-lacks-release",
  ]),
  targetVersion: Schema.NullOr(Schema.String),
  serviceVersion: Schema.NullOr(Schema.String),
  serviceStatus: Schema.NullOr(StudioServiceUpdateStatusSchema),
  serviceMessage: Schema.NullOr(Schema.String),
});
export type DesktopAppSwapGate = typeof DesktopAppSwapGateSchema.Type;

export interface DesktopUpdateReleaseNote {
  version: string;
  items: ReadonlyArray<string>;
  totalItems: number;
}

export const DesktopUpdateReleaseNoteSchema = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.String),
  totalItems: Schema.Number,
});

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  releaseNotes: Schema.Array(DesktopUpdateReleaseNoteSchema),
  omittedReleaseCount: Schema.Number,
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  feedCheckedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
  productionBuild: Schema.optionalKey(Schema.Boolean),
  swapGate: Schema.optionalKey(DesktopAppSwapGateSchema),
});
