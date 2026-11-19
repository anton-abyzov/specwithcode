/**
 * Wire shapes of the release named below, for the compatibility cases of
 * equal coordinators (`EqualCoordinatorMigration.test.ts`). Copied from that
 * release's tag, not derived from this build's schemas, so a change here to
 * what a peer reads or sends shows as a failing case:
 *
 * - the coordinator binding: `packages/contracts/src/logicalProject.ts`
 * - the supersede request of peer sync: `apps/server/src/handoff/linkedSyncWire.ts`
 *
 * Pin it again, from the new tag, when a release changes either.
 */
import * as Schema from "effect/Schema";

export const PINNED_RELEASE = "1.0.385";

const Member = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  coordinatorThreadId: Schema.String,
  workspaceRoot: Schema.optionalKey(Schema.String),
});

export const PinnedReleaseBinding = Schema.Struct({
  epoch: Schema.Number,
  state: Schema.Literals(["active", "transferring", "transferred"]),
  operationId: Schema.optional(Schema.String),
  predecessor: Schema.optional(Member),
  successor: Schema.optional(Member),
  releaseReason: Schema.optional(Schema.String),
  takenOverAt: Schema.optional(Schema.String),
  takenOverBy: Schema.optional(Schema.Literals(["person", "auto"])),
  standby: Schema.optional(
    Schema.Struct({ member: Member, afterMinutes: Schema.Number, enabledAt: Schema.String }),
  ),
  removedMembers: Schema.optional(
    Schema.Array(Schema.Struct({ environmentId: Schema.String, projectId: Schema.String })),
  ),
});

export const PinnedReleaseSupersedeRequest = Schema.Struct({
  protocolVersion: Schema.Number,
  logicalProjectId: Schema.String,
  projectId: Schema.String,
  successor: Member,
  coordinatorBinding: PinnedReleaseBinding,
});
