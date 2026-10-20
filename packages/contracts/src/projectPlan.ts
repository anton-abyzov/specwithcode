import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "./baseSchemas.ts";

export const PROJECT_PLAN_BYTES = 1_048_576;
export const PROJECT_PLAN_SPEC_BYTES = 65_536;
export const PROJECT_PLAN_TASK_LIMIT = 200;
export const PROJECT_PLAN_EVIDENCE_LIMIT = 20;
export const PROJECT_PLAN_RELEASED_CLAIMS_LIMIT = 32;
export const PROJECT_PLAN_MACHINES_LIMIT = 16;
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/));
export const ProjectPlanActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
    /** The machine running the thread. Absent means the machine that stores the plan. */
    environmentId: Schema.optionalKey(EnvironmentId),
  }),
]);
export type ProjectPlanActor = typeof ProjectPlanActor.Type;
export const ProjectPlanClaim = Schema.Struct({
  owner: ProjectPlanActor,
  claimedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectPlanClaim = typeof ProjectPlanClaim.Type;
/** When and on which machine a part of a plan last changed; linked copies keep the latest. */
export const ProjectPlanStamp = Schema.Struct({ at: IsoDateTime, environmentId: EnvironmentId });
export type ProjectPlanStamp = typeof ProjectPlanStamp.Type;
export const ProjectPlanMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: text(200),
});
export type ProjectPlanMachine = typeof ProjectPlanMachine.Type;
export const ProjectPlanAuthority = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("native") }),
  Schema.Struct({
    kind: Schema.Literal("specweave"),
    root: text(4_096),
    incrementId: Schema.String.check(
      Schema.isPattern(/^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
      Schema.isMaxLength(160),
    ),
  }),
]);
export type ProjectPlanAuthority = typeof ProjectPlanAuthority.Type;
export const ProjectPlanCriterion = Schema.Struct({ id: key, text: text(4_000) });
export type ProjectPlanCriterion = typeof ProjectPlanCriterion.Type;
/** Saved commands run only on an explicit human verification action, never when a plan is read. */
export const ProjectPlanVerificationCommand = Schema.Struct({
  executable: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  args: Schema.Array(text(4_096)).check(Schema.isMaxLength(64)),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 120_000 })),
});
export const ProjectPlanTaskDefinition = Schema.Struct({
  id: key,
  title: text(500),
  criterionIds: Schema.Array(key).check(Schema.isMaxLength(128)),
  verification: Schema.NullOr(ProjectPlanVerificationCommand),
});
export type ProjectPlanTaskDefinition = typeof ProjectPlanTaskDefinition.Type;
export const ProjectPlanDefinition = Schema.Struct({
  spec: text(PROJECT_PLAN_SPEC_BYTES),
  criteria: Schema.Array(ProjectPlanCriterion).check(Schema.isMaxLength(128)),
  tasks: Schema.Array(ProjectPlanTaskDefinition).check(Schema.isMaxLength(PROJECT_PLAN_TASK_LIMIT)),
});
export type ProjectPlanDefinition = typeof ProjectPlanDefinition.Type;
export const ProjectPlanEvidence = Schema.Struct({
  commandId: CommandId,
  contentRevision: NonNegativeInt,
  taskStateSha256: text(64),
  taskId: key,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.Literals(["unknown", "passed", "failed", "timed_out", "error", "stale"]),
  command: ProjectPlanVerificationCommand,
  workspaceRoot: text(4_096),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: text(8_192),
  stderr: text(8_192),
  outputSha256: text(64),
  truncated: Schema.Boolean,
});
export type ProjectPlanEvidence = typeof ProjectPlanEvidence.Type;
export const ProjectPlanTask = Schema.Struct({
  ...ProjectPlanTaskDefinition.fields,
  owner: Schema.NullOr(ProjectPlanActor),
  status: Schema.Literals(["planned", "in_progress", "blocked", "reported_done", "verified"]),
  note: text(4_000),
  evidence: Schema.Array(ProjectPlanEvidence).check(
    Schema.isMaxLength(PROJECT_PLAN_EVIDENCE_LIMIT),
  ),
  claimedAt: Schema.optionalKey(IsoDateTime),
  /** A claim made on another machine at the same time that lost to `owner`. */
  claimConflict: Schema.optionalKey(ProjectPlanClaim),
  /** Released claims, so a linked copy that has not seen the release cannot restore them. */
  releasedClaims: Schema.optionalKey(
    Schema.Array(ProjectPlanClaim).check(Schema.isMaxLength(PROJECT_PLAN_RELEASED_CLAIMS_LIMIT)),
  ),
  /** Last change to the owner, status or note. */
  stateStamp: Schema.optionalKey(ProjectPlanStamp),
});
export type ProjectPlanTask = typeof ProjectPlanTask.Type;
export const ProjectNativePlan = Schema.Struct({
  ...ProjectPlanDefinition.fields,
  tasks: Schema.Array(ProjectPlanTask).check(Schema.isMaxLength(PROJECT_PLAN_TASK_LIMIT)),
  contentRevision: NonNegativeInt,
  /** Last change to the spec, criteria or task list. */
  definitionStamp: Schema.optionalKey(ProjectPlanStamp),
  /** Names of the linked machines this plan has been merged with. */
  machines: Schema.optionalKey(
    Schema.Array(ProjectPlanMachine).check(Schema.isMaxLength(PROJECT_PLAN_MACHINES_LIMIT)),
  ),
});
export type ProjectNativePlan = typeof ProjectNativePlan.Type;
export const ProjectExternalPlan = Schema.Struct({
  sourceRevision: text(64),
  spec: text(262_144),
  specPath: text(4_096),
  ledgerPath: text(4_096),
  readOnly: Schema.Literal(true),
  tasks: Schema.Array(
    Schema.Struct({
      id: key,
      title: text(500),
      status: Schema.Literals([
        "planned",
        "claimed",
        "stale",
        "done",
        "released",
        "skipped",
        "blocked",
      ]),
      owner: Schema.NullOr(text(500)),
      evidence: Schema.NullOr(text(8_192)),
      /** A ledger assertion is not a test result independently verified by Studio. */
      verification: Schema.Literal("external_unverified"),
    }),
  ).check(Schema.isMaxLength(PROJECT_PLAN_TASK_LIMIT)),
});
export type ProjectExternalPlan = typeof ProjectExternalPlan.Type;
export const ProjectPlanSnapshot = Schema.Struct({
  projectId: ProjectId,
  /** The machine serving this plan; a claim from any other machine is a linked copy's. */
  environmentId: Schema.optionalKey(EnvironmentId),
  revision: NonNegativeInt,
  authority: ProjectPlanAuthority,
  native: Schema.NullOr(ProjectNativePlan),
  external: Schema.NullOr(ProjectExternalPlan),
});
export type ProjectPlanSnapshot = typeof ProjectPlanSnapshot.Type;
/** Binding metadata stays readable when the external source is unavailable. */
export const ProjectPlanAuthorityReadResult = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  authority: ProjectPlanAuthority,
});
export type ProjectPlanAuthorityReadResult = typeof ProjectPlanAuthorityReadResult.Type;
export const ProjectPlanReadInput = Schema.Struct({ projectId: ProjectId });
const change = { projectId: ProjectId, expectedRevision: NonNegativeInt };
export const ProjectPlanReplaceInput = Schema.Struct({
  ...change,
  actor: ProjectPlanActor,
  definition: ProjectPlanDefinition,
});
export type ProjectPlanReplaceInput = typeof ProjectPlanReplaceInput.Type;
export const ProjectPlanConfigureInput = Schema.Struct({
  ...change,
  actor: ProjectPlanActor,
  authority: ProjectPlanAuthority,
  discardNative: Schema.Boolean,
});
export type ProjectPlanConfigureInput = typeof ProjectPlanConfigureInput.Type;
export const ProjectPlanTaskInput = Schema.Struct({
  ...change,
  actor: ProjectPlanActor,
  taskId: key,
});
export type ProjectPlanTaskInput = typeof ProjectPlanTaskInput.Type;
export const ProjectPlanReleaseInput = Schema.Struct({
  ...ProjectPlanTaskInput.fields,
  expectedOwner: Schema.NullOr(ProjectPlanActor),
});
export type ProjectPlanReleaseInput = typeof ProjectPlanReleaseInput.Type;
export const ProjectPlanReportInput = Schema.Struct({
  ...ProjectPlanTaskInput.fields,
  status: Schema.Literals(["in_progress", "blocked", "reported_done"]),
  note: text(4_000),
});
export type ProjectPlanReportInput = typeof ProjectPlanReportInput.Type;
export const ProjectPlanVerifyInput = Schema.Struct({
  ...ProjectPlanTaskInput.fields,
  commandId: CommandId,
  /** Inspect a reserved receipt only; never start execution when it is absent. */
  recheckOnly: Schema.optional(Schema.Boolean),
});
export type ProjectPlanVerifyInput = typeof ProjectPlanVerifyInput.Type;
/** A native plan as one linked machine sends it to another. */
export const ProjectPlanLinkExport = Schema.Struct({
  logicalProjectId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  plan: ProjectNativePlan,
});
export type ProjectPlanLinkExport = typeof ProjectPlanLinkExport.Type;
export const ProjectPlanLinkExportInput = Schema.Struct({ projectId: ProjectId });
export type ProjectPlanLinkExportInput = typeof ProjectPlanLinkExportInput.Type;
export const ProjectPlanLinkMergeInput = Schema.Struct({
  projectId: ProjectId,
  peer: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    label: text(200),
  }),
  export: ProjectPlanLinkExport,
});
export type ProjectPlanLinkMergeInput = typeof ProjectPlanLinkMergeInput.Type;
export const ProjectPlanLinkMergeResult = Schema.Struct({
  changed: Schema.Boolean,
  revision: NonNegativeInt,
});
export type ProjectPlanLinkMergeResult = typeof ProjectPlanLinkMergeResult.Type;
export class ProjectPlanError extends Schema.TaggedError<ProjectPlanError>()("ProjectPlanError", {
  projectId: ProjectId,
  /** The machine holding the claim that refused this change. */
  machine: Schema.optionalKey(text(200)),
  code: Schema.Literals([
    "not_found",
    "conflict",
    "invalid",
    "claimed",
    "read_only",
    "source_unavailable",
    "source_invalid",
    "forbidden",
    "paused",
    "archived",
    "evidence_limit",
    "receipt_unavailable",
    "operation_failed",
    "not_linked",
  ]),
}) {
  override get message(): string {
    if (this.code === "claimed" && this.machine !== undefined)
      return `This task is claimed by a thread on ${this.machine}. Only the user can release that claim.`;
    return {
      not_found: "This project or task is no longer available.",
      conflict: "The plan changed elsewhere. Reload before saving.",
      invalid: "The plan is invalid or exceeds its size limit.",
      claimed:
        "This task has an active owner. Release the assignment explicitly before changing it.",
      read_only: "The configured SpecWeave spec and ledger are authoritative and read-only here.",
      source_unavailable:
        "The configured spec or ledger is unavailable. Restore the source or explicitly change authority.",
      source_invalid:
        "The configured spec or ledger is malformed, outside approved project folders, or exceeds its size limit.",
      forbidden: "This actor cannot perform this plan operation.",
      paused: "Resume this project before starting verification.",
      archived: "Restore this project before starting verification.",
      receipt_unavailable:
        "No receipt is available for this request. Nothing was executed by this recheck. Start a new attempt only if you intend another execution.",
      evidence_limit: "This task has reached its verification evidence limit.",
      operation_failed: "The plan operation failed. Reload and try again.",
      not_linked: "This project is not linked with that machine's copy.",
    }[this.code];
  }
}
