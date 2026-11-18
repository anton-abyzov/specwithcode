import * as Schema from "effect/Schema";

/**
 * Whether agents on a machine may read other apps' data (macOS Full Disk
 * Access). macOS judges the process that is responsible for the agents, not
 * the window: SpecWithCode.app when the app started the service, otherwise
 * the service's own executable (a launchd job). Only the user can grant it,
 * in System Settings; SpecWithCode never edits TCC itself.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const PrivacyAccessInput = Schema.Struct({});
export type PrivacyAccessInput = typeof PrivacyAccessInput.Type;

export const PrivacyAgentHost = Schema.Struct({
  /** "app" when SpecWithCode.app started the agents, else the bare executable a launchd job runs. */
  kind: Schema.Literals(["app", "executable"]),
  /** The item to add in System Settings: an .app bundle or an executable file. */
  path: bounded(4096),
  /** What System Settings lists it as. */
  name: bounded(255),
});
export type PrivacyAgentHost = typeof PrivacyAgentHost.Type;

export const PrivacyAccessState = Schema.Literals([
  /** New agent runs can read protected data. */
  "allowed",
  /** macOS refused the probe. */
  "not-allowed",
  /** Not a Mac: same-user processes already read other apps' data. */
  "not-applicable",
  /** The probe could not tell (no protected folder found, or the probe failed). */
  "unknown",
]);
export type PrivacyAccessState = typeof PrivacyAccessState.Type;

export const PrivacyAccess = Schema.Struct({
  checkedAt: bounded(64),
  fullDiskAccess: PrivacyAccessState,
  /** Absent off macOS. */
  agentHost: Schema.NullOr(PrivacyAgentHost),
  /**
   * New agent runs have access but this service process does not: agents that
   * were already running keep the old answer until their thread restarts.
   */
  runningAgentsNeedRestart: Schema.Boolean,
});
export type PrivacyAccess = typeof PrivacyAccess.Type;

/** What Full Disk Access unlocks, in the order the UI lists it. */
export const FULL_DISK_ACCESS_UNLOCKS = [
  "Chrome and Safari profiles and history",
  "Mail",
  "Messages",
  "Notes",
  "Photos library",
  "Time Machine backups",
  "Other apps' data",
] as const;

/** The one risk line every Full Disk Access surface shows. */
export const fullDiskAccessRiskLine = (machine: string) =>
  `Every agent on ${machine}, in every project and with every provider, gets this until you turn it off in System Settings.`;
