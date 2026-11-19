import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** The longest folder path a member records. */
export const LOGICAL_PROJECT_MEMBER_ROOT_MAX_LENGTH = 4096;

/**
 * A host owns its physical checkout and transcript; neither is the domain identity.
 * Members match by `environmentId` and `projectId` (`logicalProjectMemberKey`); the
 * folder they record never decides a match.
 */
export const LogicalProjectMember = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  /** The member's project folder on its machine when it was linked (a later move does not update it); absent on members linked before this field. */
  workspaceRoot: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(LOGICAL_PROJECT_MEMBER_ROOT_MAX_LENGTH)),
  ),
});
export type LogicalProjectMember = typeof LogicalProjectMember.Type;

export const LogicalProject = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  coordinatorId: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  members: Schema.Array(LogicalProjectMember).check(
    Schema.isMaxLength(256),
    Schema.makeFilter(
      (members) =>
        new Set(members.map((m) => JSON.stringify([m.environmentId, m.projectId]))).size ===
        members.length,
    ),
  ),
});
export type LogicalProject = typeof LogicalProject.Type;

/** A checkout or handoff operation label never replaces the project's domain name. */
export function logicalProjectTitle(project: {
  readonly title: string;
  readonly workspaceSettings?:
    | { readonly logicalProject?: Pick<LogicalProject, "title"> | null | undefined }
    | null
    | undefined;
}): string {
  return project.workspaceSettings?.logicalProject?.title ?? project.title;
}

/** The longest name a rename may give a project. */
export const PROJECT_NAME_MAX_LENGTH = 120;

/**
 * Two project names are the same when they match ignoring case and surrounding
 * space: "SpecWeave" and " specweave " collide, so neither can take the other's name.
 */
export function projectNameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/**
 * Where the desktop app tells its own server that the Mac is about to sleep,
 * so the server announces a sleeping lease to its standbys first. Only this
 * machine's own bearer with access:write may call it.
 */
export const COORDINATOR_SUSPEND_PATH = "/api/coordinator/v1/suspend";

/** The silence, in minutes, after which an armed standby takes over the coordinator. */
export const COORDINATOR_STANDBY_AFTER_MINUTES = [5, 15, 30, 60] as const;
export const DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES = 5;
export const CoordinatorStandbyAfterMinutes = Schema.Literals(COORDINATOR_STANDBY_AFTER_MINUTES);
export type CoordinatorStandbyAfterMinutes = typeof CoordinatorStandbyAfterMinutes.Type;

/**
 * The one member the owner chose to take over this coordinator automatically
 * when it goes quiet. Off when absent. The standby learns its role from the
 * owner's `acceptStandby`, or from a coordinator that took over automatically
 * under a re-arm consent the owner's app wrote on that standby; never from a
 * peer message alone.
 */
export const ProjectCoordinatorStandby = Schema.Struct({
  member: LogicalProjectMember,
  afterMinutes: CoordinatorStandbyAfterMinutes,
  enabledAt: IsoDateTime,
});
export type ProjectCoordinatorStandby = typeof ProjectCoordinatorStandby.Type;

/** A relinquished binding never becomes active through an ordinary settings edit. */
export const ProjectCoordinatorBinding = Schema.Struct({
  epoch: NonNegativeInt,
  state: Schema.Literals(["active", "transferring", "transferred"]),
  operationId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  predecessor: Schema.optional(LogicalProjectMember),
  successor: Schema.optional(LogicalProjectMember),
  /** Why a handoff returned the coordinator to this machine after a failure. */
  releaseReason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /**
   * Set by a takeover: when a member made itself the coordinator while the
   * previous one was unreachable, by the owner's click or by an armed standby
   * (`takenOverBy`). Turns the previous one ran after this are listed for
   * review once it returns.
   */
  takenOverAt: Schema.optional(IsoDateTime),
  /** Who took over: the owner (`person`) or an armed standby (`auto`). */
  takenOverBy: Schema.optional(Schema.Literals(["person", "auto"])),
  /** Set only on an active binding while automatic takeover is on. */
  standby: Schema.optional(ProjectCoordinatorStandby),
  /**
   * Members this coordinator unlinked after it replaced a predecessor, so the
   * predecessor's older list, read once it gives way, never lists them again.
   * Absent from machines older than member sync, which ignore it.
   */
  removedMembers: Schema.optional(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId })).check(
      Schema.isMaxLength(256),
    ),
  ),
  /**
   * Role operations that were under way when this copy became an equal coordinator. A late
   * write under one of them never fences this copy again. Machines from before equal
   * coordinators ignore it.
   */
  retiredOperationIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(16)),
  ),
  /**
   * Whether this copy is the one that fired the project's routines alone before the machines
   * settle a runner. Written when a copy becomes an equal coordinator or joins a project, so
   * that making every copy active never makes two of them the owner. Absent on a binding
   * from before; `coordinatorOwnsRoutines` then reads the binding's shape.
   */
  routineOwner: Schema.optional(Schema.Boolean),
});
export type ProjectCoordinatorBinding = typeof ProjectCoordinatorBinding.Type;

/** Started beside the project's first coordinator: active above epoch 0, with no predecessor. */
export function coordinatorStartedBeside(binding: ProjectCoordinatorBinding | undefined): boolean {
  return binding?.state === "active" && binding.epoch > 0 && binding.predecessor === undefined;
}

/**
 * Whether a copy's binding is the one the release before routine runners let fire the
 * project's routines alone: the project's own coordinator, or one that was handed the role or
 * took it over. A copy that joined, followed another machine or was started beside the first
 * is active too, and is not the owner.
 */
export function coordinatorOwnsRoutines(
  binding: ProjectCoordinatorBinding | null | undefined,
): boolean {
  if (binding == null) return true;
  if (binding.state !== "active") return false;
  return binding.routineOwner ?? !coordinatorStartedBeside(binding);
}

/**
 * Every machine runs its own coordinator, so any of them may leave its shared project,
 * unless it is alone in its list or a role operation from before equal coordinators is
 * still open on it.
 */
export function coordinatorMayLeave(
  binding: ProjectCoordinatorBinding | undefined,
  memberCount: number,
): boolean {
  return (binding === undefined || binding.state === "active") && memberCount > 1;
}

export function projectCoordinatorIsFenced(
  settings:
    | {
        readonly coordinatorBinding?: ProjectCoordinatorBinding | null | undefined;
      }
    | null
    | undefined,
): boolean {
  return settings?.coordinatorBinding != null && settings.coordinatorBinding.state !== "active";
}

export function logicalProjectMemberKey(
  member: Pick<LogicalProjectMember, "environmentId" | "projectId">,
): string {
  return JSON.stringify([member.environmentId, member.projectId]);
}

/** During release all execution waits; after acknowledgment ordinary workers remain usable. */
export function projectExecutionIsFenced(
  settings:
    | {
        readonly coordinatorBinding?: ProjectCoordinatorBinding | null | undefined;
        readonly coordinatorThreadId?: string | null | undefined;
      }
    | null
    | undefined,
  projectId: string,
  threadId?: string | null,
): boolean {
  return (
    settings?.coordinatorBinding?.state === "transferring" ||
    (settings?.coordinatorBinding?.state === "transferred" &&
      threadId === (settings.coordinatorThreadId ?? `project-coordinator:${projectId}`))
  );
}

/**
 * Whether a thread is the project's coordinator. Its children are the
 * project's workers, first-class threads, not internal subagents.
 */
export function isProjectCoordinatorThreadId(
  threadId: string | null | undefined,
  project: {
    readonly id: string;
    readonly workspaceSettings?: { readonly coordinatorThreadId?: string | null } | undefined;
  },
): boolean {
  if (!threadId) return false;
  return (
    threadId === `project-coordinator:${project.id}` ||
    threadId === project.workspaceSettings?.coordinatorThreadId
  );
}

interface CoordinatorLineage {
  readonly parentThreadId: string | null;
  readonly relationshipToParent: string | null;
}

/**
 * Whether deleting a project's threads keeps this one: the coordinator, and the
 * subagent threads that run inside it (directly or through other subagents).
 * Its first-class workers are not kept. `lineageOf` finds a parent's lineage.
 */
export function staysWithProjectCoordinator(
  threadId: string,
  lineage: CoordinatorLineage | null | undefined,
  project: Parameters<typeof isProjectCoordinatorThreadId>[1],
  lineageOf: (threadId: string) => CoordinatorLineage | null | undefined,
): boolean {
  const seen = new Set<string>();
  let id: string | null = threadId;
  let current = lineage;
  while (id !== null && !seen.has(id)) {
    if (isProjectCoordinatorThreadId(id, project)) return true;
    seen.add(id);
    if (current?.relationshipToParent !== "subagent") return false;
    id = current.parentThreadId;
    current = id === null ? null : lineageOf(id);
  }
  return false;
}

/**
 * Whether a machine keeps its own coordinator when it joins a project, by the capabilities
 * its server advertises or the features its tools list. One that does not say so is from
 * before equal coordinators: its accept relinquishes the coordinator, so nothing links with it.
 */
export function environmentRunsEqualCoordinators(
  capabilities: { readonly equalCoordinators?: boolean | undefined } | null | undefined,
): boolean {
  return capabilities?.equalCoordinators === true;
}
