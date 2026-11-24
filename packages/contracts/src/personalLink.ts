import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectIconOverride } from "./project.ts";
import { LogicalProject, LogicalProjectMember } from "./logicalProject.ts";

/**
 * Protocol version for linking a personal assistant across the owner's own
 * machines. Peers below this version are refused with `version_skew` so the
 * owner sees "Update <machine> to link Percy" rather than silently syncing
 * partial or incompatible shapes.
 */
export const PERSONAL_LINK_PROTOCOL_VERSION = 1;

export const PERSONAL_LINK_RPC_METHODS = {
  personalLinkPreview: "personalLink.preview",
  personalLinkJoin: "personalLink.join",
  personalLinkLeave: "personalLink.leave",
  personalLinkSetRoutineOwner: "personalLink.setRoutineOwner",
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
