import { LogicalProject, ProjectCoordinatorBinding } from "./logicalProject.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  PROJECT_MEMORY_FILE_BYTES,
  PROJECT_MEMORY_MAX_FILES,
  PROJECT_MEMORY_TOTAL_BYTES,
} from "./projectWorkspace.ts";

/** The conversation, goal and instructions: everything a bundle carries except memory notes. */
export const MACHINE_HANDOFF_MAX_BYTES = 2_097_152;
/** A move carries the project's whole memory, up to the per-project limit. */
export const MACHINE_HANDOFF_MEMORY_MAX_BYTES = PROJECT_MEMORY_TOTAL_BYTES;
/**
 * The serialized bundle as it crosses each environment's WebSocket: 2 MiB of
 * context plus 16 MiB of notes leaves 12 MiB for JSON escaping, and the whole
 * stays under the 32 MiB per-message limit of the strictest WebSocket proxy in
 * the path (the server itself accepts 100 MiB messages).
 */
export const MACHINE_HANDOFF_BUNDLE_MAX_BYTES = 31_457_280;
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
  /** Immutable folder-copy coordinates; bound into the retained bundle digest. */
  copyScope: Schema.optional(
    Schema.Struct({
      copyRoot: bounded(4096),
      projectRelativePath: bounded(4096),
    }),
  ),
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
  /**
   * The folder arrived by folder copy (project-folder only): Git publication and
   * materialization are skipped, and the destination requires its applied copy.
   */
  transport: Schema.optional(Schema.Literal("folder-copy")),
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
  notes: Schema.Array(
    Schema.Struct({ name: bounded(128), content: bounded(PROJECT_MEMORY_FILE_BYTES) }),
  ).check(Schema.isMaxLength(PROJECT_MEMORY_MAX_FILES)),
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
/** Rows a refusal or drift read lists; the total and digest still cover every path. */
export const MACHINE_HANDOFF_MAX_CHANGE_ROWS = 500;
/** What differs on the source since a folder copy, by path. Edits on a listed path keep the digest. */
export const MachineHandoffSourceChanges = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  total: Schema.Number,
  truncated: Schema.Boolean,
  /** Whether the move may go ahead without these paths; older uncaptured copies may not. */
  acceptable: Schema.Boolean,
  rows: Schema.Array(
    Schema.Struct({
      path: bounded(4096),
      kind: Schema.Literals(["changed", "added", "removed", "unreadable", "repository"]),
      size: Schema.optional(Schema.Number),
      /** The file was still being written when copied: the copy may mix two versions. */
      unsettled: Schema.optional(Schema.Literal(true)),
      repository: Schema.optional(
        Schema.Struct({
          headFrom: Schema.optional(bounded(64)),
          headTo: Schema.optional(bounded(64)),
          branchesChanged: Schema.Array(bounded(1024)),
          stashFrom: Schema.Number,
          stashTo: Schema.Number,
          indexChanged: Schema.Boolean,
          /** Tags, notes, remote-tracking or other refs differ. */
          refsChanged: Schema.optional(Schema.Boolean),
          /** Git config, exclude rules or hooks differ. */
          settingsChanged: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ).check(Schema.isMaxLength(MACHINE_HANDOFF_MAX_CHANGE_ROWS)),
});
export type MachineHandoffSourceChanges = typeof MachineHandoffSourceChanges.Type;
/** Threads a busy refusal names; `total` still counts every blocking thread. */
export const MACHINE_HANDOFF_MAX_BUSY_THREADS = 10;
/** Why a thread keeps a project from moving: what the person can do about it differs. */
export const MachineHandoffBusyReason = Schema.Literals([
  "running",
  "waiting_for_answer",
  "waiting_for_sign_in",
  "pending_approval",
  "provider_session",
  "pending_effect",
]);
export type MachineHandoffBusyReason = typeof MachineHandoffBusyReason.Type;
export const MachineHandoffBusyThread = Schema.Struct({
  threadId: ThreadId,
  title: bounded(512),
  projectId: ProjectId,
  projectTitle: Schema.optional(bounded(512)),
  reason: MachineHandoffBusyReason,
});
export type MachineHandoffBusyThread = typeof MachineHandoffBusyThread.Type;
/** The threads that keep a project busy, first ones first. */
export const MachineHandoffBusyThreads = Schema.Struct({
  total: Schema.Number,
  threads: Schema.Array(MachineHandoffBusyThread).check(
    Schema.isMaxLength(MACHINE_HANDOFF_MAX_BUSY_THREADS),
  ),
});
export type MachineHandoffBusyThreads = typeof MachineHandoffBusyThreads.Type;
export const MachineHandoffPrepareInput = Schema.Struct({
  destination: Schema.optional(MachineHandoffDestination),
  acknowledgment: Schema.optional(MachineHandoffAcknowledgment),
  projectId: ProjectId,
  sourceThreadId: Schema.optional(ThreadId),
  operationId: MachineHandoffOperationId,
  publish: Schema.Boolean,
  expectedDigest: Schema.optional(MachineHandoffBundle.fields.digest),
  /** The digest of a source change list the person reviewed and chose to move without. */
  acceptedSourceChanges: Schema.optional(MachineHandoffSourceChanges.fields.digest),
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
  /** Moved memory notes read back on this machine with the bundle's exact content. */
  verifiedNotes: Schema.optional(Schema.Number),
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
      "destination_memory_full",
      "memory_mismatch",
    ]),
    /** source_changed after a folder copy: exactly which paths differ, for review. */
    changes: Schema.optional(MachineHandoffSourceChanges),
    /** busy: which threads hold the project, from newer machines; older ones send none. */
    busy: Schema.optional(MachineHandoffBusyThreads),
  },
) {
  override get message(): string {
    return {
      not_found: "The handoff project or source chat is no longer available.",
      busy: this.busy?.total
        ? `${this.busy.total === 1 ? "A thread is" : `${this.busy.total} threads are`} still working or waiting for you. Answer or close what each one asks, or stop its work, then try again.`
        : "Finish active work in this project before handing it off.",
      invalid: "The handoff is invalid or belongs to a different project or machine.",
      too_large: "The retained context exceeds the handoff limit. Select a smaller source chat.",
      conflict: "This handoff ID already belongs to different work. Start a new handoff.",
      source_changed: this.changes
        ? "Files changed on the source after the copy. Review them before moving the coordinator."
        : "The source changed after the preview. Start a new handoff.",
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
      destination_memory_full:
        "This machine's project memory cannot also hold the moved notes (16 MiB and 4,096 files per project). Remove notes here, then retry the same handoff.",
      memory_mismatch:
        "A moved memory note did not read back intact on this machine. Retry the same handoff.",
    }[this.code];
  }
}
