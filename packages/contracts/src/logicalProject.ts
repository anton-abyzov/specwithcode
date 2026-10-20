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
   * Set by a manual takeover: when a member made itself the coordinator while
   * the previous one was unreachable. Turns the previous one ran after this
   * are listed for review once it returns.
   */
  takenOverAt: Schema.optional(IsoDateTime),
});
export type ProjectCoordinatorBinding = typeof ProjectCoordinatorBinding.Type;

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
