import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PERSONAL_ASSISTANT_SHARED_MAX_MACHINES } from "./settings.ts";
import { ProjectIconOverride } from "./project.ts";
import { LogicalProject, LogicalProjectMember } from "./logicalProject.ts";

/**
 * Protocol version for linking a personal assistant across the owner's own
 * machines. Peers below this version are refused with `version_skew` so the
 * owner sees "Update <machine> to link Percy" rather than silently syncing
 * partial or incompatible shapes. Version 2 is one Percy per Connect account:
 * the per-machine switch and the account's link id (1448 D-11, D-12).
 */
export const PERSONAL_LINK_PROTOCOL_VERSION = 2;

export const PERSONAL_LINK_RPC_METHODS = {
  personalLinkPreview: "personalLink.preview",
  personalLinkJoin: "personalLink.join",
  personalLinkLeave: "personalLink.leave",
  personalLinkSetRoutineOwner: "personalLink.setRoutineOwner",
  personalLinkSetShared: "personalLink.setShared",
  personalLinkShareStatus: "personalLink.shareStatus",
  personalLinkUndo: "personalLink.undo",
} as const;

export const PersonalLinkErrorCode = Schema.Literals([
  "not_found",
  "not_personal_assistant",
  "not_linked",
  "already_linked",
  "version_skew",
  "invalid",
  "storage_failed",
  "paused",
  "approval_required",
  "stale_plan",
  "snapshot_failed",
  "not_connected",
  "assistant_off",
  "no_restore_point",
]);
export type PersonalLinkErrorCode = typeof PersonalLinkErrorCode.Type;

export class PersonalLinkError extends Schema.TaggedError<PersonalLinkError>()(
  "PersonalLinkError",
  {
    code: PersonalLinkErrorCode,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}

export const PersonalLinkPreviewInput = Schema.Struct({
  projectId: ProjectId,
});
export type PersonalLinkPreviewInput = typeof PersonalLinkPreviewInput.Type;

/**
 * Strictly allow-listed preview returned before linking or merging two
 * personal assistants. Never carries `workspaceRoot`, git fingerprints, or
 * chat snippets.
 */
/** One syncable memory file in a preview: its name and a content hash, never its content. */
export const PersonalLinkPreviewMemoryFile = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  updatedAt: Schema.String,
  byteLength: Schema.Int,
});
export type PersonalLinkPreviewMemoryFile = typeof PersonalLinkPreviewMemoryFile.Type;

export const PersonalLinkPreview = Schema.Struct({
  protocolVersion: Schema.Int,
  projectId: ProjectId,
  assistantName: Schema.String,
  icon: Schema.NullOr(ProjectIconOverride),
  memoryFileCount: Schema.Int,
  machineLabel: Schema.String,
  memoryFileNames: Schema.Array(Schema.String),
  logicalProjectId: Schema.NullOr(TrimmedNonEmptyString),
  members: Schema.Array(LogicalProjectMember),
  routineOwner: Schema.Boolean,
  /** This seat as a link member; absent from previews made before migration support. */
  self: Schema.optional(LogicalProjectMember),
  createdAt: Schema.optional(Schema.String),
  /** Syncable files with content hashes, for the clash review. */
  memoryFiles: Schema.optional(Schema.Array(PersonalLinkPreviewMemoryFile)),
  /** The seat's settings revision and memory digest the owner approved. */
  settingsRevision: Schema.optional(Schema.Int),
  memoryDigest: Schema.optional(Schema.String),
});
export type PersonalLinkPreview = typeof PersonalLinkPreview.Type;

/**
 * What the owner approved in the merge review, bound to the seat as previewed.
 * A join refuses with `stale_plan` once the seat's settings or memory moved.
 */
export const PersonalLinkJoinApproval = Schema.Struct({
  expectedSettingsRevision: Schema.Int,
  memoryDigest: Schema.String,
});
export type PersonalLinkJoinApproval = typeof PersonalLinkJoinApproval.Type;

/**
 * How this seat treats one same-name memory clash before the first sync:
 * `keep` leaves it, `rename-shared` renames this copy so both copies sync,
 * `rename-local` renames it and keeps it on this machine only.
 */
export const PersonalLinkMemoryResolution = Schema.Struct({
  name: Schema.String,
  action: Schema.Literals(["keep", "rename-shared", "rename-local"]),
});
export type PersonalLinkMemoryResolution = typeof PersonalLinkMemoryResolution.Type;

export const PersonalLinkJoinInput = Schema.Struct({
  projectId: ProjectId,
  logicalProjectId: TrimmedNonEmptyString,
  canonicalName: Schema.optional(TrimmedNonEmptyString),
  icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  members: Schema.Array(LogicalProjectMember),
  routineOwner: Schema.Boolean,
  peerProtocolVersion: Schema.optional(Schema.Int),
  peerMachineLabel: Schema.optional(Schema.String),
  operationId: Schema.optional(TrimmedNonEmptyString),
  /** Required for a seat's first link: the reviewed revision and memory digest. */
  approval: Schema.optional(PersonalLinkJoinApproval),
  /**
   * Whose instructions and attached repositories the link starts from (1448 D-10):
   * true on the seat the owner's review names, false on every other seat. Absent
   * keeps the older behaviour (the newest edit wins).
   */
  sharedSettingsSource: Schema.optional(Schema.Boolean),
  memoryResolutions: Schema.optional(
    Schema.Array(PersonalLinkMemoryResolution).check(Schema.isMaxLength(256)),
  ),
});
export type PersonalLinkJoinInput = typeof PersonalLinkJoinInput.Type;

export const PersonalLinkJoinResult = Schema.Struct({
  projectId: ProjectId,
  logicalProject: LogicalProject,
  routineOwner: Schema.Boolean,
  replayed: Schema.Boolean,
  /** Where this machine saved its pre-merge database copy, when it made one. */
  snapshotPath: Schema.optional(Schema.String),
});
export type PersonalLinkJoinResult = typeof PersonalLinkJoinResult.Type;

export const PersonalLinkLeaveInput = Schema.Struct({
  projectId: ProjectId,
  removeEnvironmentId: Schema.optional(EnvironmentId),
});
export type PersonalLinkLeaveInput = typeof PersonalLinkLeaveInput.Type;

export const PersonalLinkLeaveResult = Schema.Struct({
  projectId: ProjectId,
  unlinked: Schema.Boolean,
  remainingMembers: Schema.Array(LogicalProjectMember),
});
export type PersonalLinkLeaveResult = typeof PersonalLinkLeaveResult.Type;

export const PersonalLinkSetRoutineOwnerInput = Schema.Struct({
  projectId: ProjectId,
  routineOwner: Schema.Boolean,
});
export type PersonalLinkSetRoutineOwnerInput = typeof PersonalLinkSetRoutineOwnerInput.Type;

export const PersonalLinkSetRoutineOwnerResult = Schema.Struct({
  projectId: ProjectId,
  routineOwner: Schema.Boolean,
});
export type PersonalLinkSetRoutineOwnerResult = typeof PersonalLinkSetRoutineOwnerResult.Type;

/**
 * The owner's switch "Use my Percy on this machine" (1448 D-12). `machines`
 * replaces the machines confirmed on this machine; left out, they stay.
 * `start` marks this seat as the one the link starts from and `name` is the
 * link's name (D-15); left out, each keeps its value.
 */
export const PersonalLinkSetSharedInput = Schema.Struct({
  enabled: Schema.Boolean,
  machines: Schema.optional(
    Schema.Array(EnvironmentId).check(Schema.isMaxLength(PERSONAL_ASSISTANT_SHARED_MAX_MACHINES)),
  ),
  start: Schema.optional(Schema.Boolean),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
});
export type PersonalLinkSetSharedInput = typeof PersonalLinkSetSharedInput.Type;

export const PersonalLinkShareStatusInput = Schema.Struct({});
export type PersonalLinkShareStatusInput = typeof PersonalLinkShareStatusInput.Type;

/** Without `restorePointId`, the newest restore point saved before a link. */
export const PersonalLinkUndoInput = Schema.Struct({
  restorePointId: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalLinkUndoInput = typeof PersonalLinkUndoInput.Type;

/**
 * Where one other machine stands for the shared Percy, as this machine sees
 * it (1448 AC-17): `joined` is a member of the link, `waiting` is confirmed
 * here and not linked yet, and the rest say why it cannot join.
 */
export const PersonalShareMachineState = Schema.Literals([
  "joined",
  "waiting",
  "switch_off",
  "not_confirmed",
  "no_grant",
  "legacy_grant",
  "other_account",
  "older_version",
  "offline",
]);
export type PersonalShareMachineState = typeof PersonalShareMachineState.Type;

export const PersonalShareMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.NullOr(Schema.String),
  state: PersonalShareMachineState,
  detail: Schema.optional(Schema.String),
  lastSyncedAt: Schema.optional(Schema.String),
});
export type PersonalShareMachine = typeof PersonalShareMachine.Type;

/** A copy of this machine's Percy that `personalLink.undo` can go back to (D-16). */
export const PersonalShareRestorePoint = Schema.Struct({
  id: Schema.String,
  savedAt: Schema.String,
  reason: Schema.Literals(["before-link", "before-undo"]),
  memoryFileCount: Schema.Int,
});
export type PersonalShareRestorePoint = typeof PersonalShareRestorePoint.Type;

/** Why turning the switch on is refused right now; null when it is not. */
export const PersonalShareRefusal = Schema.Literals(["not_connected", "assistant_off"]);
export type PersonalShareRefusal = typeof PersonalShareRefusal.Type;

/**
 * This machine's part in the Connect account's one Percy, for Settings and
 * `percy status`. It holds only what this machine knows; nothing here is a
 * secret, a path or memory content.
 */
export const PersonalShareStatus = Schema.Struct({
  enabled: Schema.Boolean,
  environmentId: EnvironmentId,
  machineLabel: Schema.String,
  /** Whether this machine is linked to SpecWithCode Connect. */
  connectLinked: Schema.Boolean,
  /** The account's link id (D-11); null while this machine is not linked to Connect. */
  linkId: Schema.NullOr(Schema.String),
  /** This machine's personal assistant; null while it has none. */
  projectId: Schema.NullOr(ProjectId),
  assistantName: Schema.NullOr(Schema.String),
  /** Whether this seat is in a link with at least one other machine. */
  linked: Schema.Boolean,
  members: Schema.Array(LogicalProjectMember),
  routineOwner: Schema.Boolean,
  /** Whether the link starts from this seat (D-15). */
  start: Schema.Boolean,
  machines: Schema.Array(PersonalShareMachine),
  restorePoints: Schema.Array(PersonalShareRestorePoint),
  refusal: Schema.NullOr(PersonalShareRefusal),
});
export type PersonalShareStatus = typeof PersonalShareStatus.Type;

export const personalLinkRpcs = [
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkPreview, {
    payload: PersonalLinkPreviewInput,
    success: PersonalLinkPreview,
    error: PersonalLinkError,
  }),
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkJoin, {
    payload: PersonalLinkJoinInput,
    success: PersonalLinkJoinResult,
    error: PersonalLinkError,
  }),
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkLeave, {
    payload: PersonalLinkLeaveInput,
    success: PersonalLinkLeaveResult,
    error: PersonalLinkError,
  }),
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkSetRoutineOwner, {
    payload: PersonalLinkSetRoutineOwnerInput,
    success: PersonalLinkSetRoutineOwnerResult,
    error: PersonalLinkError,
  }),
] as const;

/** The per-machine switch, its status and undo; owner-only, like the calls above. */
export const personalShareRpcs = [
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkSetShared, {
    payload: PersonalLinkSetSharedInput,
    success: PersonalShareStatus,
    error: PersonalLinkError,
  }),
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkShareStatus, {
    payload: PersonalLinkShareStatusInput,
    success: PersonalShareStatus,
    error: PersonalLinkError,
  }),
  Rpc.make(PERSONAL_LINK_RPC_METHODS.personalLinkUndo, {
    payload: PersonalLinkUndoInput,
    success: PersonalShareStatus,
    error: PersonalLinkError,
  }),
] as const;
