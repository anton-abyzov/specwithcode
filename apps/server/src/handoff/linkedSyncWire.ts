/**
 * Server-driven sync of linked copies over the handoff peer route
 * (`LinkedPeerSync` drives, `LinkedPeerRoute` answers). The driving server
 * first exchanges small digests (`linked-digest`) and moves content only for
 * what changed: the coordinator's notes, goal and instructions
 * (`linked-content`, `linked-replica`), giving way after a takeover
 * (`linked-supersede`) and plan claims (`plan-export`, `plan-merge`). Member
 * lists follow the coordinator: a digest and a supersede answer may carry the
 * copy's members, and `linked-members` pushes the coordinator's list to a
 * member. Those fields are optional, so older machines ignore them. Memory
 * pages use the `memory-*` paths. Bumped whenever what the two machines do
 * with these changes; a mismatch is refused.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  LogicalProjectMember,
  NonNegativeInt,
  ProjectCoordinatorBinding,
  ProjectId,
  ProjectLinkNote,
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  ProjectPlanLinkExport,
  ProjectPlanLinkMergeInput,
} from "@specweave-studio/contracts";

export const LINKED_SYNC_PROTOCOL_VERSION = 1;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** A copy's whole member list, as its shared identity holds it. */
const memberList = Schema.Array(LogicalProjectMember).check(Schema.isMaxLength(256));

/** Which copy a request is about: the receiver's copy of one logical project. */
const copyFields = {
  protocolVersion: NonNegativeInt,
  logicalProjectId: text(512),
  projectId: ProjectId,
};

export const LinkedDigestRequest = Schema.Struct(copyFields);
export type LinkedDigestRequest = typeof LinkedDigestRequest.Type;
/** Everything a pass compares before it moves any content; a few hundred bytes. */
export const LinkedDigestResponse = Schema.Struct({
  protocolVersion: NonNegativeInt,
  member: LogicalProjectMember,
  binding: Schema.NullOr(ProjectCoordinatorBinding),
  /** `coordinatorContentDigest` of this copy's own notes, goal and instructions. */
  coordinatorDigest: text(128),
  replica: Schema.NullOr(
    Schema.Struct({
      from: LogicalProjectMember,
      digest: text(128),
      fromEpoch: Schema.optional(NonNegativeInt),
    }),
  ),
  /** The whole-memory digest; null when this copy could not tell. */
  memoryDigest: Schema.NullOr(text(128)),
  /** Of the plan this copy exports; null without a native plan to share. */
  planDigest: Schema.NullOr(text(128)),
  /** The members this copy lists; absent from machines older than member sync. */
  members: Schema.optional(memberList),
});
export type LinkedDigestResponse = typeof LinkedDigestResponse.Type;

/** The coordinator's own notes, goal and instructions; only an active copy answers. */
export const LinkedContentRequest = Schema.Struct(copyFields);
export type LinkedContentRequest = typeof LinkedContentRequest.Type;
const contentFields = {
  digest: text(128),
  goal: text(PROJECT_GOAL_MAX_LENGTH),
  instructions: text(PROJECT_INSTRUCTIONS_MAX_LENGTH),
  notes: Schema.Array(ProjectLinkNote).check(Schema.isMaxLength(4096)),
  notesTruncated: Schema.Boolean,
};
export const LinkedContentResponse = Schema.Struct({
  ...contentFields,
  member: LogicalProjectMember,
  epoch: NonNegativeInt,
});
export type LinkedContentResponse = typeof LinkedContentResponse.Type;

/** The driving coordinator's content, for the receiver's replica. */
export const LinkedReplicaRequest = Schema.Struct({
  ...copyFields,
  ...contentFields,
  from: LogicalProjectMember,
  fromEpoch: NonNegativeInt,
});
export type LinkedReplicaRequest = typeof LinkedReplicaRequest.Type;
export const LinkedReplicaResponse = Schema.Struct({
  replicatedAt: IsoDateTime,
  replayed: Schema.Boolean,
});
export type LinkedReplicaResponse = typeof LinkedReplicaResponse.Type;

/** From the copy that took over: the receiver, its predecessor, gives way. */
export const LinkedSupersedeRequest = Schema.Struct({
  ...copyFields,
  successor: LogicalProjectMember,
  coordinatorBinding: ProjectCoordinatorBinding,
});
export type LinkedSupersedeRequest = typeof LinkedSupersedeRequest.Type;
export const LinkedSupersedeResponse = Schema.Struct({
  coordinatorBinding: ProjectCoordinatorBinding,
  replayed: Schema.Boolean,
  /** The members the copy that gave way lists, for the copy that took over to add. */
  members: Schema.optional(memberList),
});
export type LinkedSupersedeResponse = typeof LinkedSupersedeResponse.Type;

/** The driving coordinator's member list, for the receiver to adopt. */
export const LinkedMembersRequest = Schema.Struct({
  ...copyFields,
  from: LogicalProjectMember,
  fromEpoch: NonNegativeInt,
  members: memberList,
});
export type LinkedMembersRequest = typeof LinkedMembersRequest.Type;
export const LinkedMembersResponse = Schema.Struct({
  replayed: Schema.Boolean,
  changed: Schema.Boolean,
});
export type LinkedMembersResponse = typeof LinkedMembersResponse.Type;

export const LinkedPlanExportRequest = Schema.Struct(copyFields);
export type LinkedPlanExportRequest = typeof LinkedPlanExportRequest.Type;
export const LinkedPlanExportResponse = ProjectPlanLinkExport;

export const LinkedPlanMergeRequest = Schema.Struct({
  ...copyFields,
  peer: ProjectPlanLinkMergeInput.fields.peer,
  export: ProjectPlanLinkExport,
});
export type LinkedPlanMergeRequest = typeof LinkedPlanMergeRequest.Type;
