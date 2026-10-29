import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import {
  CoordinatorStandbyAfterMinutes,
  LogicalProjectMember,
  ProjectCoordinatorBinding,
} from "./logicalProject.ts";
import { ProjectLinkOperationId } from "./projectLink.ts";

/**
 * Automatic coordinator takeover is off until the owner arms it on both
 * machines: `setStandby` on the active coordinator names the one member that
 * may take over and after how long, and `acceptStandby` on that member
 * registers the coordinator whose leases it will listen to. Neither is ever
 * sent by a peer; the owner's app calls both.
 */
export const ProjectSetStandbyInput = Schema.Struct({
  operationId: ProjectLinkOperationId,
  projectId: ProjectId,
  /** Null turns automatic takeover off. */
  standby: Schema.NullOr(
    Schema.Struct({
      member: LogicalProjectMember,
      afterMinutes: CoordinatorStandbyAfterMinutes,
    }),
  ),
  /**
   * Turning the standby off or changing it first releases the old one. When
   * it does not answer, the change is refused unless this is set; the release
   * is then sent again until it is answered.
   */
  changeAnyway: Schema.optional(Schema.Boolean),
});
export type ProjectSetStandbyInput = typeof ProjectSetStandbyInput.Type;
export const ProjectSetStandbyResult = Schema.Struct({
  coordinatorBinding: ProjectCoordinatorBinding,
  /** The binding already named that standby with that delay. */
  replayed: Schema.Boolean,
});
export type ProjectSetStandbyResult = typeof ProjectSetStandbyResult.Type;

/** What a standby registered: whose leases it accepts, at which epoch, and its delay. */
export const ProjectStandbyRegistration = Schema.Struct({
  coordinator: LogicalProjectMember,
  epoch: NonNegativeInt,
  afterMinutes: CoordinatorStandbyAfterMinutes,
  acceptedAt: IsoDateTime,
});
export type ProjectStandbyRegistration = typeof ProjectStandbyRegistration.Type;

export const ProjectAcceptStandbyInput = Schema.Struct({
  projectId: ProjectId,
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  /** Null disarms this machine as the standby. */
  standby: Schema.NullOr(
    Schema.Struct({
      coordinator: LogicalProjectMember,
      epoch: NonNegativeInt,
      afterMinutes: CoordinatorStandbyAfterMinutes,
    }),
  ),
});
export type ProjectAcceptStandbyInput = typeof ProjectAcceptStandbyInput.Type;
export const ProjectAcceptStandbyResult = Schema.Struct({
  standby: Schema.NullOr(ProjectStandbyRegistration),
  replayed: Schema.Boolean,
});
export type ProjectAcceptStandbyResult = typeof ProjectAcceptStandbyResult.Type;
