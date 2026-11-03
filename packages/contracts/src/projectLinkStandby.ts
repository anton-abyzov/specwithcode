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
 * registers the coordinator whose leases it will listen to. The owner's app
 * calls both. It may also write a re-arm consent on each machine in its list.
 * A coordinator that took over automatically may then register the next
 * machine of that list through `studio_coordinator_claim_epoch`, and only a
 * machine holding the same consent accepts it.
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

/** The most machines one re-arm list holds; the app offers fewer. */
export const STANDBY_REARM_MEMBERS_MAX = 6;

/**
 * The owner's permission, written on each machine of its list, for the
 * machines in it to register each other as the standby after an automatic
 * takeover. A peer's registration must name the same chain and come from a
 * listed machine.
 */
export const StandbyRearmConsent = Schema.Struct({
  /** The owner's arming operation; a peer arm must name the same one. */
  chainId: ProjectLinkOperationId,
  /**
   * Ordered: the first standby, then the owner's "if it takes over, arm next"
   * list. Unique by machine and project. These machines may arm each other.
   */
  members: Schema.Array(LogicalProjectMember).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(STANDBY_REARM_MEMBERS_MAX),
  ),
  afterMinutes: CoordinatorStandbyAfterMinutes,
  /** The coordinator epoch when the owner armed; peer arms below it are refused. */
  fromEpoch: NonNegativeInt,
});
export type StandbyRearmConsent = typeof StandbyRearmConsent.Type;

export const ProjectAcceptStandbyInput = Schema.Struct({
  projectId: ProjectId,
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  /**
   * Null disarms this machine as the standby. Absent leaves the registration
   * as it is; then `rearm` must be given. Older servers require it, so a
   * consent-only call fails there rather than being half applied.
   */
  standby: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        coordinator: LogicalProjectMember,
        epoch: NonNegativeInt,
        afterMinutes: CoordinatorStandbyAfterMinutes,
      }),
    ),
  ),
  /** The owner's re-arm consent for this machine; null removes it. Written before `standby`. */
  rearm: Schema.optional(Schema.NullOr(StandbyRearmConsent)),
  /**
   * With `standby: null`: disarm only a registration below this epoch (another
   * member took over as a person at it); a newer one stays.
   */
  belowEpoch: Schema.optional(NonNegativeInt),
});
export type ProjectAcceptStandbyInput = typeof ProjectAcceptStandbyInput.Type;
export const ProjectAcceptStandbyResult = Schema.Struct({
  standby: Schema.NullOr(ProjectStandbyRegistration),
  replayed: Schema.Boolean,
  /** The consent this machine now holds, when the call wrote one; null when it removed it. */
  rearm: Schema.optional(Schema.NullOr(Schema.Struct({ chainId: ProjectLinkOperationId }))),
});
export type ProjectAcceptStandbyResult = typeof ProjectAcceptStandbyResult.Type;
