import { LogicalProject, ProjectCoordinatorBinding } from "./logicalProject.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  ProjectKind,
  ProjectOrigin,
  ProjectEnvironmentSettings,
  DEFAULT_PROJECT_ENVIRONMENT,
} from "./projectEnvironment.ts";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
  SERVICE_UPDATE_VERIFYING_MESSAGE,
} from "./serviceUpdatePreparation.ts";

// Sized for memory brought over from another tool: a long-lived project keeps
// hundreds of topic files and megabytes of notes. A prompt carries only MEMORY.md
// and file names, so what is stored does not grow what is delivered.
export const PROJECT_MEMORY_FILE_BYTES = 262_144;
export const PROJECT_MEMORY_TOTAL_BYTES = 16_777_216;
export const PROJECT_MEMORY_MAX_FILES = 4_096;
export const PROJECT_CONTEXT_CHARACTER_LIMIT = 32_768;
export const ProjectMemoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/),
  Schema.isMaxLength(128),
);
/** The most characters a project goal may hold. */
export const PROJECT_GOAL_MAX_LENGTH = 8_000;
/** The most characters project instructions may hold. */
export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 16_000;

/**
 * Another of the user's machines (from studio-fleet.json) this project's
 * coordinator starts its workers on. The environment id pins that machine;
 * `projectId` is the same repository's project there, when known.
 */
export const ProjectWorkerMachine = Schema.Struct({
  machineId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)),
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
});
export type ProjectWorkerMachine = typeof ProjectWorkerMachine.Type;

/**
 * How much of a project reaches the person as alerts (sound, desktop
 * notification, phone push) and whether its row shows a waiting count. See
 * `@specweave-studio/shared/projectNotifications`.
 */
export const ProjectNotificationLevel = Schema.Literals(["all", "coordinator", "requests", "none"]);
export type ProjectNotificationLevel = typeof ProjectNotificationLevel.Type;

export const ProjectWorkspaceSettings = Schema.Struct({
  /** Server-managed identity and transfer fence; absent on legacy independent projects. */
  logicalProject: Schema.optional(LogicalProject),
  coordinatorBinding: Schema.optional(ProjectCoordinatorBinding),
  kind: ProjectKind.pipe(Schema.withDecodingDefault(Effect.succeed("code" as const))),
  environment: ProjectEnvironmentSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_ENVIRONMENT)),
  ),
  revision: NonNegativeInt,
  goal: Schema.String.check(Schema.isMaxLength(PROJECT_GOAL_MAX_LENGTH)),
  instructions: Schema.String.check(Schema.isMaxLength(PROJECT_INSTRUCTIONS_MAX_LENGTH)),
  coordinatorModelSelection: Schema.NullOr(ModelSelection),
  coordinatorThreadId: Schema.NullOr(ThreadId),
  paused: Schema.Boolean,
  archived: Schema.Boolean,
  autoResume: Schema.Boolean,
  /** Absent or null: workers run on this machine. */
  workerMachine: Schema.optionalKey(Schema.NullOr(ProjectWorkerMachine)),
  /**
   * Server-managed: the temporary `auth session issue` session that created
   * this project. The server deletes the project once that session ends.
   */
  temporarySessionId: Schema.optionalKey(Schema.String),
  /**
   * "automated" for a project a check or agent made for itself, listed apart from
   * the person's projects; "user" once the person keeps it as their own. Absent:
   * the folder decides (projectOrigin). A string on the wire, so a value a newer
   * version adds reads as absent instead of failing the whole project.
   */
  origin: Schema.optionalKey(Schema.String),
  /**
   * The person's notification level for this project. Absent: the default,
   * "coordinator". A string on the wire, so a value a newer version adds reads
   * as absent instead of failing the whole project.
   */
  notifications: Schema.optionalKey(Schema.String),
});
export type ProjectWorkspaceSettings = typeof ProjectWorkspaceSettings.Type;
export const DEFAULT_PROJECT_WORKSPACE_SETTINGS: ProjectWorkspaceSettings = {
  kind: "code",
  environment: DEFAULT_PROJECT_ENVIRONMENT,
  revision: 0,
  goal: "",
  instructions: "",
  coordinatorModelSelection: null,
  coordinatorThreadId: null,
  paused: false,
  archived: false,
  autoResume: false,
};
export const ProjectWorkspacePatch = Schema.Struct({
  kind: Schema.optional(ProjectKind),
  environment: Schema.optional(ProjectEnvironmentSettings),
  expectedRevision: NonNegativeInt,
  goal: Schema.optional(ProjectWorkspaceSettings.fields.goal),
  instructions: Schema.optional(ProjectWorkspaceSettings.fields.instructions),
  coordinatorModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  paused: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  autoResume: Schema.optional(Schema.Boolean),
  workerMachine: Schema.optional(Schema.NullOr(ProjectWorkerMachine)),
  origin: Schema.optional(ProjectOrigin),
  notifications: Schema.optional(ProjectNotificationLevel),
});
export type ProjectWorkspacePatch = typeof ProjectWorkspacePatch.Type;
export const ProjectWorkspaceReadInput = Schema.Struct({ projectId: ProjectId });
export const ProjectMemorySummary = Schema.Struct({
  name: ProjectMemoryName,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  byteLength: NonNegativeInt,
});
export type ProjectMemorySummary = typeof ProjectMemorySummary.Type;
export const ProjectMemoryFile = Schema.Struct({
  ...ProjectMemorySummary.fields,
  content: Schema.String,
});
export type ProjectMemoryFile = typeof ProjectMemoryFile.Type;
export const ProjectWorkspaceReadResult = Schema.Struct({
  settings: ProjectWorkspaceSettings,
  memory: Schema.Struct({ files: Schema.Array(ProjectMemorySummary), totalBytes: NonNegativeInt }),
});
export type ProjectWorkspaceReadResult = typeof ProjectWorkspaceReadResult.Type;
export const ProjectMemoryReadInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectMemoryName,
});
export const ProjectMemoryWriteInput = Schema.Struct({
  ...ProjectMemoryReadInput.fields,
  content: Schema.String.check(Schema.isMaxLength(PROJECT_MEMORY_FILE_BYTES)),
  expectedRevision: Schema.NullOr(NonNegativeInt),
});
export type ProjectMemoryWriteInput = typeof ProjectMemoryWriteInput.Type;
export const ProjectMemoryDeleteInput = Schema.Struct({
  ...ProjectMemoryReadInput.fields,
  expectedRevision: NonNegativeInt,
});
export const ProjectMemoryDeleteResult = Schema.Struct({ deleted: Schema.Literal(true) });
export const ProjectCoordinatorStartInput = Schema.Struct({
  projectId: ProjectId,
  commandId: CommandId,
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
});
export type ProjectCoordinatorStartInput = typeof ProjectCoordinatorStartInput.Type;
export const ProjectCoordinatorSendInput = Schema.Struct({
  projectId: ProjectId,
  commandId: CommandId,
  prompt: Schema.String.check(Schema.isMaxLength(32_000)),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  sourceThreadId: Schema.optional(ThreadId),
});
export type ProjectCoordinatorSendInput = typeof ProjectCoordinatorSendInput.Type;
export const ProjectCoordinatorResult = Schema.Struct({
  threadId: ThreadId,
  created: Schema.Boolean,
});
export type ProjectCoordinatorResult = typeof ProjectCoordinatorResult.Type;
export class ProjectWorkspaceError extends Schema.TaggedError<ProjectWorkspaceError>()(
  "ProjectWorkspaceError",
  {
    code: Schema.Literals([
      "not_found",
      "conflict",
      "invalid",
      "empty_message",
      "invalid_attachments",
      "attachment_unavailable",
      "attachment_limit",
      "invalid_coordinator",
      "invalid_source_thread",
      "paused",
      "archived",
      "model_required",
      "provider_unavailable",
      "coordinator_tools_required",
      "unsupported_provider",
      "busy",
      "transferred",
      "update_in_progress",
      "operation_failed",
      "moving",
    ]),
    projectId: ProjectId,
    /** With `update_in_progress`: the update is installed and its release is being checked. */
    verifying: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const messages = {
      not_found: "The project or memory file is no longer available.",
      conflict: "This project changed elsewhere. Reload before saving.",
      invalid:
        "The project memory name or content is invalid, or the project is at its memory limit (256 KiB per file, 16 MiB and 4,096 files per project).",
      empty_message: "Enter a message or attach a file before sending to the coordinator.",
      invalid_attachments:
        "These attachments cannot be sent. Attach the files again, then retry your message.",
      attachment_unavailable:
        "These uploaded files have expired or cannot be read. Restore or attach them again, then retry your message.",
      attachment_limit: `The attachments exceed message limits. Use up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files, including ${PROVIDER_SEND_TURN_MAX_IMAGES} images (${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 1_048_576} MiB each, ${PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / 1_048_576} MiB total), and ${PROVIDER_SEND_TURN_MAX_FILE_BYTES / 1_048_576} MiB per file. Reduce the count or size and retry.`,
      invalid_coordinator:
        "This project's coordinator thread is no longer available. Reload the project before sending.",
      invalid_source_thread:
        "The selected worker is no longer available in this project. Choose a current project thread before sending.",
      paused: "This project is paused. Resume it before starting work.",
      archived: "This project is archived. Restore it before starting work.",
      model_required:
        "Connect a provider in Settings > Providers, then choose a coordinator model or a default project model.",
      provider_unavailable:
        "The coordinator provider is unavailable. Enable it, install its CLI and sign in under Settings > Providers, or choose another coordinator model.",
      coordinator_tools_required:
        "This model cannot call tools to coordinate work. Choose a coordinator model with tool support.",
      unsupported_provider:
        "This provider cannot use additional project folders under the current permissions. Use Codex or Claude, or an ACP provider already running with Full access and no restrictive sandbox or approval override.",
      busy: "Finish or stop active project work before deleting the project.",
      transferred:
        "This coordinator handed off ownership. Open its successor; an uncertain transfer must be retried with the same handoff.",
      update_in_progress:
        this.verifying === true
          ? SERVICE_UPDATE_VERIFYING_MESSAGE
          : SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
      operation_failed: "The project operation failed. Reload and try again.",
      moving:
        "This project is moving to another machine, so its memory is read-only until the move finishes. Save the change on the machine it moves to.",
    };
    return messages[this.code];
  }
}
