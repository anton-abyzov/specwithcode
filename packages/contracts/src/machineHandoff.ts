import { LogicalProject, ProjectCoordinatorBinding } from "./logicalProject.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";

export const MACHINE_HANDOFF_MAX_BYTES = 2_097_152;
export const MachineHandoffOperationId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const MachineHandoffRepository = Schema.Struct({
  relativePath: bounded(512),
  identity: bounded(512),
  head: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  ref: bounded(256),
});
export type MachineHandoffRepository = typeof MachineHandoffRepository.Type;
export const MachineHandoffManifest = Schema.Struct({
  version: Schema.Literal(1),
  operationId: MachineHandoffOperationId,
  repositories: Schema.Array(MachineHandoffRepository).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
});
export type MachineHandoffManifest = typeof MachineHandoffManifest.Type;
export const MachineHandoffDestination = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  coordinatorThreadId: Schema.optional(ThreadId),
  logicalProjectId: Schema.optional(bounded(512)),
  /** A preview may describe this plan; only explicitly accepted start performs the join. */
  joinExistingProject: Schema.optional(Schema.Boolean),
  /** Execute in the explicitly selected registered folder; omitted preserves legacy transfers. */
  executionMode: Schema.optional(Schema.Literal("project-folder")),
});
export const MachineHandoffAcknowledgment = Schema.Struct({
  operationId: MachineHandoffOperationId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const MachineHandoffContext = Schema.Struct({
  goal: bounded(8_000),
  instructions: bounded(16_000),
  /**
   * The access the source coordinator ran with. The destination saves it as the
   * project's mode and starts its coordinator on it; older bundles omit it and
   * keep the destination's own default.
   */
  runtimeMode: Schema.optional(RuntimeMode),
  notes: Schema.Array(Schema.Struct({ name: bounded(128), content: bounded(262_144) })).check(
    Schema.isMaxLength(4096),
  ),
  threads: Schema.Array(
    Schema.Struct({
      environmentId: Schema.optional(EnvironmentId),
      projectId: Schema.optional(ProjectId),
      modelSelection: Schema.optional(ModelSelection),
      threadId: ThreadId,
      title: bounded(1000),
      branch: Schema.NullOr(bounded(1024)),
      worktreePath: Schema.NullOr(bounded(4096)),
      kind: Schema.Literals(["coordinator", "worker"]),
      messages: Schema.Array(
        Schema.Struct({
          id: bounded(512),
          role: Schema.Literals(["user", "assistant"]),
          text: bounded(MACHINE_HANDOFF_MAX_BYTES),
          createdAt: bounded(64),
          runId: Schema.optional(bounded(512)),
          modelSelection: Schema.optional(ModelSelection),
        }),
      ).check(Schema.isMaxLength(2000)),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type MachineHandoffContext = typeof MachineHandoffContext.Type;
const logicalTransferFields = {
  logicalProject: Schema.optional(LogicalProject),
  coordinatorBinding: Schema.optional(ProjectCoordinatorBinding),
  destination: Schema.optional(MachineHandoffDestination),
};
export const MachineHandoffBundle = Schema.Struct({
  ...logicalTransferFields,
  manifest: MachineHandoffManifest,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  createdAt: bounded(64),
  context: MachineHandoffContext,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type MachineHandoffBundle = typeof MachineHandoffBundle.Type;
export const MachineHandoffPrepareInput = Schema.Struct({
  destination: Schema.optional(MachineHandoffDestination),
  acknowledgment: Schema.optional(MachineHandoffAcknowledgment),
  projectId: ProjectId,
  sourceThreadId: Schema.optional(ThreadId),
  operationId: MachineHandoffOperationId,
  publish: Schema.Boolean,
  expectedDigest: Schema.optional(MachineHandoffBundle.fields.digest),
});
export type MachineHandoffPrepareInput = typeof MachineHandoffPrepareInput.Type;
export const MachineHandoffPrepareResult = Schema.Struct({
  bundle: MachineHandoffBundle,
  publication: Schema.Literals(["unpublished", "published"]),
  contextBytes: Schema.Number,
  messageCount: Schema.Number,
});
export type MachineHandoffPrepareResult = typeof MachineHandoffPrepareResult.Type;
/** Destination checks need checkpoint identities, never the retained conversation. */
export const MachineHandoffPreviewMetadata = Schema.Struct({
  ...logicalTransferFields,
  manifest: MachineHandoffManifest,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  digest: MachineHandoffBundle.fields.digest,
});
export type MachineHandoffPreviewMetadata = typeof MachineHandoffPreviewMetadata.Type;
export const MachineHandoffReceiveInput = Schema.Union([
  Schema.Struct({
    ...MachineHandoffPreviewMetadata.fields,
    projectId: ProjectId,
    operationId: MachineHandoffOperationId,
    mode: Schema.Literal("preview"),
    // Fail closed for queued clients that still try to send a full preview.
    bundle: Schema.optionalKey(Schema.Never),
    context: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    projectId: ProjectId,
    operationId: MachineHandoffOperationId,
    mode: Schema.Literal("start"),
    bundle: MachineHandoffBundle,
  }),
]);
export type MachineHandoffReceiveInput = typeof MachineHandoffReceiveInput.Type;
export const MachineHandoffReceiveResult = Schema.Struct({
  executionMode: Schema.optional(Schema.Literal("project-folder")),
  environmentId: Schema.optional(EnvironmentId),
  logicalProject: Schema.optional(LogicalProject),
  coordinatorBinding: Schema.optional(ProjectCoordinatorBinding),
  operationId: MachineHandoffOperationId,
  phase: Schema.Literals(["ready", "started"]),
  projectId: ProjectId,
  coordinatorThreadId: Schema.NullOr(ThreadId),
  workspacePath: Schema.String,
  contextPath: Schema.NullOr(Schema.String),
  replayed: Schema.Boolean,
});
export type MachineHandoffReceiveResult = typeof MachineHandoffReceiveResult.Type;
export class MachineHandoffError extends Schema.TaggedError<MachineHandoffError>()(
  "MachineHandoffError",
  {
    code: Schema.Literals([
      "not_found",
      "busy",
      "invalid",
      "too_large",
      "conflict",
      "source_changed",
      "worker_checkpoint",
      "git_refused",
      "dirty_source",
      "dirty_destination",
      "identity_mismatch",
      "unsafe_path",
      "diverged",
      "missing_repository",
      "remote_unavailable",
      "storage_failed",
      "launch_failed",
    ]),
  },
) {
  override get message(): string {
    return {
      not_found: "The handoff project or source chat is no longer available.",
      busy: "Finish active work in this project before handing it off.",
      invalid: "The handoff is invalid or belongs to a different project or machine.",
      too_large: "The retained context exceeds the handoff limit. Select a smaller source chat.",
      conflict: "This handoff ID already belongs to different work. Start a new handoff.",
      source_changed: "The source changed after the preview. Start a new handoff.",
      worker_checkpoint:
        "A worker has separate code that is not checkpointed in this workspace. Commit and merge its changes into the source workspace before handing off.",
      dirty_source: "Commit or stash source changes before publishing this handoff.",
      dirty_destination:
        "The destination checkout has local changes. Preserve them before receiving this handoff.",
      identity_mismatch: "The source and destination repositories do not match.",
      unsafe_path:
        "A repository path or symbolic link is unsafe to transfer. Use real repository folders, keep handoff workspaces outside the project, and remove tracked absolute links or links outside the repository while preserving their targets.",
      diverged:
        "The destination repository has diverged from the source. Reconcile it before handing off.",
      missing_repository: "A required repository is missing or not initialized on this machine.",
      remote_unavailable:
        "The published Git objects are unavailable. Check remote access and finish publishing the same handoff.",
      git_refused:
        "The repositories could not be handed off safely. Check repository identity, clean status, and remote access.",
      storage_failed: "The handoff could not be saved. Retry the same handoff.",
      launch_failed:
        "The context is retained, but the coordinator could not start. Retry this handoff.",
    }[this.code];
  }
}
