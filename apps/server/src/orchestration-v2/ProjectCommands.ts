import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectTitle,
  PROJECT_NAME_MAX_LENGTH,
  projectNameKey,
  type LogicalProject,
  type ProjectCoordinatorBinding,
  type ProjectWorkspacePatch,
  type ProjectKind,
  type ThreadId,
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectOwnershipUpdate {
  readonly expectedRevision: number;
  /** Exact singleton identity the explicit handoff plan is allowed to join. */
  readonly joinExpectedLogicalProjectId?: string | null;
  /** Internal only: MachineHandoff verified a destination-bound published checkpoint. */
  readonly acceptedHandoffOperationId?: string;
  readonly logicalProject: LogicalProject;
  readonly coordinatorBinding: ProjectCoordinatorBinding;
}

export interface ProjectCreateCommand {
  readonly initialLogicalProject?: LogicalProject;
  readonly initialCoordinatorBinding?: ProjectCoordinatorBinding;
  readonly kind?: ProjectKind;
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  /** Internal handoff seed; public create payloads cannot supply this field. */
  readonly initialWorkerModelSelection?: ModelSelection | null;
  /** Internal: the temporary auth session creating the project; see TemporaryProjects. */
  readonly temporarySessionId?: string;
}

export interface ProjectMetaUpdateCommand {
  /** Server-only ownership transition, never read from an ordinary settings patch. */
  readonly ownership?: ProjectOwnershipUpdate;
  readonly workspaceSettings?: ProjectWorkspacePatch;
  readonly coordinatorThreadId?: ThreadId;
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  /** Internal automatic initialization must not replace a concurrent user choice. */
  readonly onlyIfDefaultModelUnset?: boolean;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a project that does not exist or was deleted. */
export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

/** A rejected settings write has a stable receipt and can be safely retried. */
export class ProjectSettingsRevisionConflictError extends Schema.TaggedError<ProjectSettingsRevisionConflictError>()(
  "ProjectSettingsRevisionConflictError",
  {
    projectId: ProjectId,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
) {
  override get message(): string {
    return "Project settings changed elsewhere. Reload before saving.";
  }
}

export class ProjectDefaultModelConflictError extends Schema.TaggedError<ProjectDefaultModelConflictError>()(
  "ProjectDefaultModelConflictError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "Project default model changed elsewhere. Reload before saving.";
  }
}

/** A rename would give the project another project's name, ignoring case. */
export class ProjectNameTakenError extends Schema.TaggedError<ProjectNameTakenError>()(
  "ProjectNameTakenError",
  {
    projectId: ProjectId,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return "Another project already has this name. Choose a different one.";
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectNameTakenError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
  ProjectSettingsRevisionConflictError,
  ProjectDefaultModelConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
/**
 * A rejected receipt stores its rejection as JSON, so a retried command id
 * replays the same typed error even when a fresh plan would now succeed.
 */
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
/** None for receipts that predate structured rejections. */
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  /** The target project's row, including a soft-deleted one; only create sees deleted rows as taken. */
  readonly project: ProjectRow | undefined;
  /** The active project that holds the command's requested workspace root, if any. */
  readonly workspaceOwner: ProjectRow | undefined;
  /** Another active project already named like the command's new title, if any. */
  readonly nameOwner?: ProjectRow | undefined;
}

/** Whether this command renames the project; ownership transfers carry the identity's own name. */
export function renamesProject(command: ProjectCommand): command is ProjectMetaUpdateCommand & {
  readonly title: string;
} {
  return (
    command.type === "project.meta.update" && command.title !== undefined && !command.ownership
  );
}

/**
 * The other project that already has `title`, ignoring case. Checkouts of the same
 * logical project, or of the same repository, are one project in the sidebar and may
 * share a name; `sameRepository` says whether two rows are checkouts of one repository.
 */
export function findProjectNameOwner(input: {
  readonly rows: ReadonlyArray<ProjectRow>;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly sameRepository?: (a: ProjectRow, b: ProjectRow) => boolean;
}): ProjectRow | undefined {
  const target = input.rows.find((row) => row.projectId === input.projectId);
  const identity = target?.workspaceSettings?.logicalProject?.id;
  const key = projectNameKey(input.title);
  return input.rows.find(
    (row) =>
      row.deletedAt === null &&
      row.projectId !== input.projectId &&
      projectNameKey(logicalProjectTitle(row)) === key &&
      (identity === undefined || row.workspaceSettings?.logicalProject?.id !== identity) &&
      !(target && input.sameRepository?.(target, row)),
  );
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/**
 * Decide one project command against the rows it touches. The caller reads
 * `state` under the project's lock and commits the planned event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Public create seeds remain ignored. A handoff copies the destination's
          // saved choice atomically, before settings writes or launch can fail.
          defaultModelSelection: command.initialWorkerModelSelection ?? null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            kind: command.kind ?? "code",
            ...(command.initialLogicalProject
              ? { logicalProject: command.initialLogicalProject }
              : {}),
            ...(command.initialCoordinatorBinding
              ? { coordinatorBinding: command.initialCoordinatorBinding }
              : {}),
            ...(command.temporarySessionId
              ? { temporarySessionId: command.temporarySessionId }
              : {}),
          },
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      // Keeping the current name never collides with itself, and changing only its
      // case collides with nothing but itself.
      const renamed = renamesProject(command) && command.title !== logicalProjectTitle(project);
      if (renamed && command.title.length > PROJECT_NAME_MAX_LENGTH) {
        return invariant(`Project names must be at most ${PROJECT_NAME_MAX_LENGTH} characters.`);
      }
      if (
        renamed &&
        state.nameOwner !== undefined &&
        state.nameOwner.projectId !== command.projectId
      ) {
        return Result.fail(
          new ProjectNameTakenError({
            projectId: command.projectId,
            conflictingProjectId: state.nameOwner.projectId,
          }),
        );
      }
      if (command.onlyIfDefaultModelUnset && project.defaultModelSelection !== null) {
        return Result.fail(new ProjectDefaultModelConflictError({ projectId: command.projectId }));
      }
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      const previousSettings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      if (
        command.workspaceSettings &&
        command.workspaceSettings.expectedRevision !== previousSettings.revision
      ) {
        return Result.fail(
          new ProjectSettingsRevisionConflictError({
            projectId: command.projectId,
            expectedRevision: command.workspaceSettings.expectedRevision,
            actualRevision: previousSettings.revision,
          }),
        );
      }
      if (command.ownership) {
        if (command.ownership.expectedRevision !== previousSettings.revision)
          return Result.fail(
            new ProjectSettingsRevisionConflictError({
              projectId: command.projectId,
              expectedRevision: command.ownership.expectedRevision,
              actualRevision: previousSettings.revision,
            }),
          );
        const old = previousSettings.coordinatorBinding;
        const next = command.ownership.coordinatorBinding;
        const acceptedIncoming =
          command.ownership.acceptedHandoffOperationId !== undefined &&
          command.ownership.acceptedHandoffOperationId === next.operationId &&
          next.state === "active" &&
          next.predecessor !== undefined &&
          (!old || next.epoch > old.epoch) &&
          command.ownership.logicalProject.members.some(
            (m) =>
              m.projectId === next.predecessor!.projectId &&
              m.environmentId === next.predecessor!.environmentId &&
              m.coordinatorThreadId === next.predecessor!.coordinatorThreadId,
          );
        if (
          previousSettings.logicalProject &&
          previousSettings.logicalProject.id !== command.ownership.logicalProject.id &&
          !(
            command.ownership.joinExpectedLogicalProjectId === previousSettings.logicalProject.id &&
            previousSettings.logicalProject.members.every(
              (member) => member.projectId === command.projectId,
            ) &&
            previousSettings.logicalProject.members.length <= 1 &&
            (next.state === "transferred" || acceptedIncoming)
          )
        )
          return invariant(
            "Only an explicitly accepted standalone project can join another identity.",
          );
        if (
          old &&
          !acceptedIncoming &&
          (next.epoch !== old.epoch ||
            (old.state !== "active" &&
              (next.state === "active" || next.operationId !== old.operationId)) ||
            (old.state === "transferred" && next.state !== "transferred"))
        )
          return invariant("A relinquished coordinator cannot resume or change its handoff.");
      }
      // Ignore forged extras even in internal direct calls that bypass wire decoding.
      const {
        expectedRevision: _expected,
        logicalProject: _identity,
        coordinatorBinding: _binding,
        ...settingsPatch
      } = (command.workspaceSettings ?? {}) as ProjectWorkspacePatch & {
        logicalProject?: unknown;
        coordinatorBinding?: unknown;
      };
      const renamedIdentity =
        command.title !== undefined &&
        previousSettings.logicalProject &&
        previousSettings.coordinatorBinding?.state === "active"
          ? { ...previousSettings.logicalProject, title: command.title }
          : undefined;
      const workspaceSettings =
        command.workspaceSettings ||
        command.coordinatorThreadId ||
        command.ownership ||
        renamedIdentity
          ? {
              ...previousSettings,
              ...Object.fromEntries(
                Object.entries(settingsPatch).filter(([, value]) => value !== undefined),
              ),
              ...(command.coordinatorThreadId
                ? { coordinatorThreadId: command.coordinatorThreadId }
                : {}),
              ...(renamedIdentity ? { logicalProject: renamedIdentity } : {}),
              ...(command.ownership
                ? {
                    logicalProject: command.ownership.logicalProject,
                    coordinatorBinding: command.ownership.coordinatorBinding,
                  }
                : {}),
              revision: previousSettings.revision + 1,
            }
          : undefined;
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            // The raw ID is unbounded user input and this detail is persisted.
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(workspaceSettings === undefined ? {} : { workspaceSettings }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
