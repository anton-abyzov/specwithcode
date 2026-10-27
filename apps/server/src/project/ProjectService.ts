import { stringifyJson } from "../json.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ThreadId as CoordinatorThreadId,
  logicalProjectTitle,
  projectNameKey,
  repositoryGroupingKeyOf,
  type LogicalProject,
  type ProjectCoordinatorBinding,
} from "@specweave-studio/contracts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { normalizeProjectEnvironment } from "./ProjectEnvironmentPaths.ts";
import {
  CommandId,
  ProjectEnvironmentError,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type OrchestrationProjectShell,
  type ModelSelection,
  ProjectFolderCheckError,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectEnvironmentSettings,
  type ProjectOrigin,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  type OrchestrationV2ThreadShell,
  type RuntimeRequestId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { defaultProjectModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  findProjectNameOwner,
  planProjectCommand,
  createsPersonalAssistant,
  renamesProject,
  type ProjectCommand,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";

/**
 * The origin a new project saves: the one its creator gave, or "automated" for a
 * project a temporary agent token makes. Anything else stays unset, so its folder
 * is judged each time it is shown (projectOrigin) and a wrong guess is never saved.
 */
export function createdOrigin(input: Pick<ProjectCreateInput, "origin" | "temporarySessionId">): {
  origin?: ProjectOrigin;
} {
  if (input.origin !== undefined) return { origin: input.origin };
  return input.temporarySessionId !== undefined ? { origin: "automated" } : {};
}

/** The key every personal create waits on, so concurrent ones see each other. */
const PERSONAL_ASSISTANT_LOCK = "\u0000personal-assistant";

export interface ProjectCreateInput extends ProjectCreatePayload {
  readonly initialLogicalProject?: LogicalProject;
  readonly initialCoordinatorBinding?: ProjectCoordinatorBinding;
  /** Internal handoff seed, committed atomically with creation; null disables auto-seeding. */
  readonly initialWorkerModelSelection?: ModelSelection | null;
  /** Internal: set by the server for temporary agent sessions, never by a client payload. */
  readonly temporarySessionId?: string;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  /** Internal adoption guard: inspection does not authorize rebinding a canonical path. */
  readonly requireUnchangedEnvironmentPaths?: boolean;
  readonly ownership?: ProjectOwnershipUpdate;
  /** Internal automatic initialization, checked under the project command lock. */
  readonly onlyIfDefaultModelUnset?: boolean;
  /** Internal coordinator binding, never accepted from a client settings patch. */
  readonly coordinatorThreadId?: ThreadId;
  /**
   * Internal: the approval card that asked for this change. Its own pending
   * request does not count as active work in the thread that asked.
   */
  readonly approvalRequestId?: RuntimeRequestId;
  /**
   * Internal, from a folder change: threads that go on running where they are
   * (their own checkout, or kept in the old folder), each with the worktree path
   * it had then. Their work does not hold up a new root while that path is
   * unchanged. Ignored when the update also changes the approved folders.
   */
  readonly threadsStayingInPlace?: ReadonlyMap<string, string | null>;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
  readonly confirmationTitle?: string;
  /** Internal: the approval card that asked for this deletion; see ProjectUpdateInput. */
  readonly approvalRequestId?: RuntimeRequestId;
  /**
   * Internal: "server" for the app's own cleanup, such as the temporary project
   * sweep. Any other delete is someone's request and counts toward the delete
   * burst limit. Never copied from a client payload.
   */
  readonly initiator?: "client" | "server";
}

/**
 * Deletes someone asks for that are accepted per rolling window. Deleting a
 * project also deletes its memory, routines, connections and plans, so a client
 * sending many deletes at once (15 in 9 seconds on 2026-10-17) is refused.
 */
export const PROJECT_DELETE_BURST_LIMIT = 5;
export const PROJECT_DELETE_BURST_WINDOW_MS = 60_000;

/** True while a thread holds work a project change must not pull the folder from under. */
export function threadHasActiveWork(
  thread: Pick<OrchestrationV2ThreadShell, "activeRunId" | "pendingRuntimeRequest">,
  approvalRequestId?: RuntimeRequestId,
): boolean {
  return (
    thread.activeRunId !== null ||
    (thread.pendingRuntimeRequest !== null &&
      (approvalRequestId === undefined || thread.pendingRuntimeRequest.id !== approvalRequestId))
  );
}

/**
 * True when `next` keeps every prior approval exactly and only appends folders or
 * repositories. Both sides must be normalized (canonical paths), so a prior folder whose
 * real path moved does not count as kept. Adding does not affect turns in flight: the
 * environment is read when each turn starts.
 */
export function isAdditiveEnvironmentChange(
  prior: ProjectEnvironmentSettings,
  next: ProjectEnvironmentSettings,
): boolean {
  const folders = new Set(next.additionalFolders);
  const repositories = new Map(next.repositories.map((repository) => [repository.id, repository]));
  return (
    prior.additionalFolders.every((folder) => folders.has(folder)) &&
    prior.repositories.every((repository) => {
      const kept = repositories.get(repository.id);
      return (
        kept !== undefined && kept.url === repository.url && kept.localPath === repository.localPath
      );
    })
  );
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedError<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedError<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "This project still has threads, and deleting it deletes them too. Confirm the deletion to go ahead.";
  }
}

/** Why a project's main folder could not change, in words the user can act on. */
export class ProjectFolderChangeError extends Schema.TaggedError<ProjectFolderChangeError>()(
  "ProjectFolderChangeError",
  {
    projectId: ProjectId,
    reason: Schema.Literals([
      "folder_missing",
      "folder_conflict",
      "repository_mismatch",
      "active_work",
      "planning_impact",
      "folder_not_directory",
      "folder_protected",
      "repository_unreadable",
      "environment_invalid",
      /** The project's threads changed while the folder was changing; check again. */
      "changed_meanwhile",
      /** project.update cannot move the folder; project.folder.change does it safely. */
      "use_folder_change",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Expected client denials carry safe, actionable text through both RPC and HTTP. */
export class ProjectRequestDeniedError extends Schema.TaggedError<ProjectRequestDeniedError>()(
  "ProjectRequestDeniedError",
  {
    projectId: ProjectId,
    reason: Schema.Literals([
      "settings_conflict",
      "confirmation_required",
      "active_work",
      "environment_active",
      "name_taken",
      "assistant_exists",
      "kind_fixed",
      "too_many_deletes",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "settings_conflict":
        return "Project settings changed elsewhere. Reload before saving.";
      case "confirmation_required":
        return "Type the project name exactly to confirm deletion.";
      case "environment_active":
        return "Stop active project work before removing or changing folder access. Adding a folder works while threads run.";
      case "active_work":
        return "Finish or stop active project work before deleting the project.";
      case "name_taken":
        return "Another project already has this name. Choose a different one.";
      case "assistant_exists":
        return "This machine already has its personal assistant. Open it instead of creating another.";
      case "kind_fixed":
        return "A project's kind is set when it is created and cannot be changed.";
      case "too_many_deletes":
        return "Too many projects were deleted in the last minute. Wait a minute, then delete the rest.";
    }
  }
}

/** A missing imported folder is an expected refusal, not an internal failure. */
export function isMissingProjectFolder(cause: unknown): boolean {
  return (
    Schema.is(ProjectOperationError)(cause) &&
    cause.operation === "normalize-workspace" &&
    Schema.is(WorkspacePaths.WorkspaceRootNotExistsError)(cause.cause)
  );
}

/** Return only reviewed messages; unexpected operational details stay private. */
export function projectMutationErrorMessage(cause: unknown): string {
  if (isMissingProjectFolder(cause))
    return "The project folder does not exist. Choose an existing folder or create it before importing.";
  return Schema.is(ProjectRequestDeniedError)(cause) ||
    Schema.is(ProjectNotEmptyError)(cause) ||
    Schema.is(ProjectFolderChangeError)(cause) ||
    Schema.is(ProjectFolderCheckError)(cause) ||
    Schema.is(ProjectConflictError)(cause) ||
    Schema.is(ProjectEnvironmentError)(cause)
    ? cause.message
    : "Failed to mutate project.";
}

export class ProjectOperationError extends Schema.TaggedError<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "dispatch-project-command",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectEnvironmentError
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectNotEmptyError
  | ProjectRequestDeniedError
  | ProjectFolderChangeError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /**
     * An active project's shell with its immediately available repository
     * identity; missing identity resolves in the background.
     */
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    /** Active project shells, enriched like `getShell`, in creation order. */
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectOperationError>;
  }
>()("specweave-studio/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const threadProjections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  // Commands for one project run in order. Commands that claim a workspace root
  // also hold that root, so two projects cannot both claim it.
  const projectLocks = yield* KeyedLock.make<ProjectId>();
  const workspaceLocks = yield* KeyedLock.make<string>();
  // When recent client deletes were accepted, in epoch millis. Kept in memory: a
  // restart forgets them, which only ever allows more deletes, never fewer.
  const recentClientDeletes = yield* Ref.make<ReadonlyArray<number>>([]);

  const toProject = (
    row: ProjectStore.ProjectRow,
    enrichment: ProjectEnrichmentService.ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    ...(row.workspaceSettings ? { workspaceSettings: row.workspaceSettings } : {}),
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (row: ProjectStore.ProjectRow) {
    const enrichment =
      row.deletedAt === null ? yield* projectEnrichment.getAvailable(row.workspaceRoot) : null;
    return toProject(row, enrichment);
  });

  const readRow = (projectId: ProjectId, options?: { readonly includeDeleted?: boolean }) =>
    projects
      .get(projectId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );

  const normalizeWorkspaceRoot = (input: {
    readonly projectId?: ProjectId;
    readonly workspaceRoot: string;
    readonly createIfMissing?: boolean;
  }) =>
    workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createIfMissing ?? false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "normalize-workspace",
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        ),
      );

  /**
   * The other project already named `title` on this machine. Checkouts of one
   * repository show as one project in the sidebar, so they may share a name.
   */
  const findNameOwner = Effect.fn("ProjectService.findNameOwner")(function* (
    projectId: ProjectId,
    title: string,
  ) {
    const rows = yield* projects.list();
    const key = projectNameKey(title);
    const named = rows.filter(
      (row) => row.projectId !== projectId && projectNameKey(logicalProjectTitle(row)) === key,
    );
    const target = rows.find((row) => row.projectId === projectId);
    if (named.length === 0 || target === undefined) return undefined;
    const repositoryKeys = new Map<ProjectId, string>();
    for (const row of [target, ...named]) {
      // Resolved now if needed: a checkout added a moment ago has no cached identity yet.
      const identity = yield* projectEnrichment.repositoryIdentityNow(row.workspaceRoot);
      if (identity) repositoryKeys.set(row.projectId, repositoryGroupingKeyOf(identity));
    }
    return findProjectNameOwner({
      rows,
      projectId,
      title,
      sameRepository: (a, b) => {
        const repository = repositoryKeys.get(a.projectId);
        return repository !== undefined && repository === repositoryKeys.get(b.projectId);
      },
    });
  });

  /**
   * Plan one command against rows read under its locks, then commit its event or
   * its rejection. A reused command id resolves to the receipt it already has.
   */
  const commit = Effect.fn("ProjectService.commit")(function* (command: ProjectCommand) {
    const { projectId } = command;
    const dispatchError = (cause: unknown) =>
      new ProjectOperationError({ operation: "dispatch-project-command", projectId, cause });
    const workspaceRoot = command.type === "project.delete" ? undefined : command.workspaceRoot;
    const planAndCommit = Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* readRow(projectId, { includeDeleted: true }));
      const workspaceOwner =
        workspaceRoot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceRoot(workspaceRoot)
                .pipe(Effect.mapError(dispatchError)),
            );
      const nameOwner = renamesProject(command)
        ? yield* findNameOwner(projectId, command.title).pipe(Effect.mapError(dispatchError))
        : undefined;
      const assistant = createsPersonalAssistant(command)
        ? machineAssistantOf(yield* projects.list().pipe(Effect.mapError(dispatchError)))
        : undefined;
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: { project, workspaceOwner, nameOwner, assistant },
        eventId,
        now,
      });
      if (Result.isSuccess(planned)) {
        const { receipt } = yield* eventSink.commitProjectCommand({
          commandId: command.commandId,
          projectId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
        });
        return receipt;
      }
      return yield* eventSink.commitRejectedProjectCommand({
        commandId: command.commandId,
        projectId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeProjectCommandRejection(planned.failure),
      });
    });
    const inWorkspace =
      workspaceRoot === undefined
        ? planAndCommit
        : workspaceLocks.withLock(workspaceRoot, planAndCommit);
    // Two personal creates at once must see each other: they share one lock.
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        createsPersonalAssistant(command)
          ? workspaceLocks.withLock(PERSONAL_ASSISTANT_LOCK, inWorkspace)
          : inWorkspace,
      )
      .pipe(Effect.mapError(dispatchError));
    if (receipt.projectId !== projectId || receipt.commandType !== command.type) {
      return yield* dispatchError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.projectId}.`,
      );
    }
    // A retried command re-plans against the state it already produced, so its
    // first receipt, not the new plan, decides the outcome.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeProjectCommandRejection(receipt.error));
    switch (rejection?._tag) {
      case "ProjectWorkspaceConflictError":
        return yield* new ProjectConflictError({
          projectId,
          workspaceRoot: rejection.workspaceRoot,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectSettingsRevisionConflictError":
      case "ProjectDefaultModelConflictError":
        return yield* new ProjectRequestDeniedError({ projectId, reason: "settings_conflict" });
      case "ProjectNameTakenError":
        return yield* new ProjectRequestDeniedError({ projectId, reason: "name_taken" });
      case "PersonalAssistantExistsError":
        return yield* new ProjectRequestDeniedError({ projectId, reason: "assistant_exists" });
      case "ProjectKindFixedError":
        return yield* new ProjectRequestDeniedError({ projectId, reason: "kind_fixed" });
      case "ProjectCommandMissingProjectError":
        return yield* new ProjectNotFoundError({ projectId });
      default:
        return yield* dispatchError(
          rejection ?? receipt.error ?? "The command was previously rejected.",
        );
    }
  });

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* readRow(projectId, { includeDeleted: true });
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project row.",
      });
    }
    return yield* hydrate(row.value);
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* readRow(projectId, options);
      return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* normalizeWorkspaceRoot({ workspaceRoot });
    const row = yield* (
      options?.includeDeleted === true
        ? projects
            .list({ includeDeleted: true })
            .pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(rows.find((row) => row.workspaceRoot === normalized)),
              ),
            )
        : projects.findActiveByWorkspaceRoot(normalized)
    ).pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
  });

  // A new project merges a finished thread's branch once its checks pass, unless
  // Settings changed the environment value; older projects keep that value.
  const seedNewProjectFinishAction = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      if (Option.isNone(serverSettings)) return;
      const settings = yield* serverSettings.value.getSettings;
      const entry = settings.projectSettingsOverrides[projectId] ?? {};
      if (settings.threadFinishAction !== "pull_request" || entry.threadFinishAction !== undefined)
        return;
      yield* serverSettings.value.updateSettings({
        projectSettingsOverrideChanges: {
          [projectId]: { set: { threadFinishAction: "auto_merge" } },
        },
      });
    }).pipe(
      // Best effort: a settings store that cannot write (or a test double without
      // updateSettings) must never fail project creation.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not set a new project's finish action", { projectId, cause }),
      ),
    );

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* normalizeWorkspaceRoot({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        createIfMissing: input.createWorkspaceRootIfMissing ?? false,
      });
      const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
      const logicalId = input.initialLogicalProject?.id ?? `logical:${yield* randomUuidV4}`;
      const members = Option.isSome(serverEnvironment)
        ? [
            {
              environmentId: yield* serverEnvironment.value.getEnvironmentId,
              projectId: input.projectId,
              coordinatorThreadId: CoordinatorThreadId.make(
                `project-coordinator:${input.projectId}`,
              ),
            },
          ]
        : [];
      yield* commit({
        type: "project.create",
        initialLogicalProject: input.initialLogicalProject ?? {
          id: logicalId,
          title: input.title,
          coordinatorId: `coordinator:${logicalId}`,
          members,
        },
        initialCoordinatorBinding: input.initialCoordinatorBinding ?? { epoch: 0, state: "active" },
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        workspaceRoot,
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        ...(input.initialWorkerModelSelection === undefined
          ? {}
          : { initialWorkerModelSelection: input.initialWorkerModelSelection }),
        ...(input.temporarySessionId === undefined
          ? {}
          : { temporarySessionId: input.temporarySessionId }),
        ...createdOrigin(input),
      });
      yield* projectEnrichment.invalidate([workspaceRoot]);
      yield* seedNewProjectFinishAction(input.projectId);
      const created = yield* readCommitted(input.projectId);
      if (input.initialWorkerModelSelection !== undefined || created.defaultModelSelection !== null)
        return created;
      // A new project starts on Opus 5.5 with Thinking on when this host's Claude
      // subscription offers it, unless Settings already names a default for it.
      const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
      if (Option.isNone(registry)) return created;
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      if (Option.isSome(serverSettings)) {
        const settings = yield* serverSettings.value.getSettings.pipe(Effect.option);
        if (
          Option.isNone(settings) ||
          resolveProjectSettings(settings.value, input.projectId, created).settings
            .defaultModelSelection !== null
        )
          return created;
      }
      const model = defaultProjectModelSelection(yield* registry.value.getProviders);
      if (!model) return created;
      yield* commit({
        type: "project.meta.update",
        commandId: CommandId.make(`${input.commandId}:default-model`),
        projectId: input.projectId,
        defaultModelSelection: model,
        onlyIfDefaultModelUnset: true,
      }).pipe(
        Effect.catch((error) =>
          error._tag === "ProjectRequestDeniedError" && error.reason === "settings_conflict"
            ? Effect.void
            : Effect.fail(error),
        ),
      );
      return yield* readCommitted(input.projectId);
    },
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* readRow(input.projectId);
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      const previousRoot = existing.value.workspaceRoot;
      let workspaceRoot =
        input.workspaceRoot === undefined
          ? previousRoot
          : yield* normalizeWorkspaceRoot({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
            });
      const priorEnvironment =
        existing.value.workspaceSettings?.environment ??
        DEFAULT_PROJECT_WORKSPACE_SETTINGS.environment;
      const changedRoot = workspaceRoot !== previousRoot;
      const suppliedEnvironment = input.workspaceSettings?.environment;
      const requestedEnvironment =
        suppliedEnvironment ??
        existing.value.workspaceSettings?.environment ??
        DEFAULT_PROJECT_WORKSPACE_SETTINGS.environment;
      if (
        (suppliedEnvironment !== undefined || input.workspaceRoot !== undefined) &&
        (requestedEnvironment.additionalFolders.length > 0 ||
          requestedEnvironment.repositories.length > 0 ||
          priorEnvironment.additionalFolders.length > 0 ||
          priorEnvironment.repositories.length > 0)
      ) {
        // An explicit save binds the main folder's canonical identity too. Native turns never
        // re-approve a root that was later replaced with a symlink.
        const canonicalRoot = yield* fs.realPath(workspaceRoot).pipe(
          Effect.mapError(
            () =>
              new ProjectEnvironmentError({
                projectId: input.projectId,
                code: "path_not_approved",
              }),
          ),
        );
        if (
          canonicalRoot !== previousRoot &&
          !changedRoot &&
          (priorEnvironment.additionalFolders.length > 0 ||
            priorEnvironment.repositories.length > 0)
        ) {
          return yield* new ProjectEnvironmentError({
            projectId: input.projectId,
            code: "path_not_approved",
          });
        }
        workspaceRoot = canonicalRoot;
      }
      const environment =
        suppliedEnvironment === undefined && workspaceRoot === previousRoot
          ? undefined
          : requestedEnvironment.additionalFolders.length === 0 &&
              requestedEnvironment.repositories.length === 0
            ? requestedEnvironment
            : yield* normalizeProjectEnvironment(
                input.projectId,
                workspaceRoot,
                requestedEnvironment,
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
      if (
        input.requireUnchangedEnvironmentPaths &&
        (workspaceRoot !== previousRoot ||
          JSON.stringify(environment) !== JSON.stringify(requestedEnvironment))
      ) {
        return yield* new ProjectEnvironmentError({
          projectId: input.projectId,
          code: "import_changed",
        });
      }
      // Removing or changing an approval can pull a folder from under a running turn; adding
      // one only applies from the next turn, so it does not wait for active work.
      if (
        workspaceRoot !== previousRoot ||
        (environment !== undefined &&
          stringifyJson(environment) !== stringifyJson(priorEnvironment) &&
          !isAdditiveEnvironmentChange(priorEnvironment, environment))
      ) {
        const snapshot = yield* threadProjections.getShellSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "list-threads",
                projectId: input.projectId,
                cause,
              }),
          ),
        );
        const staying = suppliedEnvironment === undefined ? input.threadsStayingInPlace : undefined;
        if (
          [...snapshot.threads, ...snapshot.archivedThreads].some(
            (thread) =>
              thread.projectId === input.projectId &&
              !(
                staying?.has(thread.id) === true && staying.get(thread.id) === thread.worktreePath
              ) &&
              threadHasActiveWork(thread, input.approvalRequestId),
          )
        )
          return yield* new ProjectRequestDeniedError({
            projectId: input.projectId,
            reason: "environment_active",
          });
      }
      yield* commit({
        type: "project.meta.update",
        ...(input.ownership ? { ownership: input.ownership } : {}),
        commandId: input.commandId,
        projectId: input.projectId,
        ...(input.workspaceSettings === undefined
          ? {}
          : {
              workspaceSettings: {
                ...input.workspaceSettings,
                ...(environment === undefined ? {} : { environment }),
              },
            }),
        ...(input.coordinatorThreadId === undefined
          ? {}
          : { coordinatorThreadId: input.coordinatorThreadId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(workspaceRoot === previousRoot ? {} : { workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.onlyIfDefaultModelUnset === undefined
          ? {}
          : { onlyIfDefaultModelUnset: input.onlyIfDefaultModelUnset }),
        ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
        ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
        ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
        ...(input.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      });
      if (workspaceRoot !== previousRoot) {
        yield* projectEnrichment.invalidate([previousRoot, workspaceRoot]);
      }
      return yield* readCommitted(input.projectId);
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  /** Delete one child thread durably; a stable command id makes a retry resume the cascade. */
  const deleteChildThread = Effect.fn("ProjectService.deleteChildThread")(function* (
    input: ProjectDeleteInput,
    threadId: ThreadId,
  ) {
    yield* legacyImporter.ensureTranscript(threadId);
    const projection = yield* threadProjections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
    ]);
    if (projection.thread.deletedAt !== null || projection.thread.projectId !== input.projectId) {
      return;
    }
    // This read and refusal run under ThreadCommandExecutor.withLock. Ordinary
    // message dispatch uses that same lock, so it cannot admit work between
    // this check and the durable deletion command.
    if (
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      ) ||
      projection.runtimeRequests.some(
        (request) =>
          request.status === "pending" &&
          (input.approvalRequestId === undefined || request.id !== input.approvalRequestId),
      )
    ) {
      return yield* new ProjectRequestDeniedError({
        projectId: input.projectId,
        reason: "active_work",
      });
    }
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`${input.commandId}:delete-thread:${threadId}`),
      threadId,
    };
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* threadProjections.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    const committed = yield* eventSink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
    });
    if (
      committed.receipt.threadId !== command.threadId ||
      committed.receipt.commandType !== command.type
    ) {
      return yield* Effect.fail("The thread deletion command ID belongs to a different command.");
    }
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(
        committed.receipt.error ?? "Thread deletion was previously rejected.",
      );
    }
  });

  /** Refuse a non-empty project without force, else delete its live threads first. */
  const deleteChildThreads = Effect.fn("ProjectService.deleteChildThreads")(function* (
    input: ProjectDeleteInput,
  ) {
    const { projectId } = input;
    // The V2 shell is the only record of which threads are live.
    const snapshot = yield* threadProjections
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => thread.projectId === projectId,
    );
    if (projectThreads.length > 0 && input.force !== true) {
      return yield* new ProjectNotEmptyError({ projectId });
    }
    // Delete children durably before the project so a failed cascade can be retried.
    yield* Effect.forEach(
      projectThreads,
      (thread) =>
        threadCommands
          .withLock(thread.id, deleteChildThread(input, thread.id))
          .pipe(
            Effect.mapError((cause) =>
              Schema.is(ProjectRequestDeniedError)(cause)
                ? cause
                : new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  /**
   * Take one slot of the client delete burst limit, or refuse. Deletes for
   * different projects run in parallel, so the check and the claim are one update.
   */
  const reserveClientDelete = Effect.fn("ProjectService.reserveClientDelete")(function* (
    projectId: ProjectId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const reserved = yield* Ref.modify(recentClientDeletes, (times) => {
      const recent = times.filter((at) => now - at < PROJECT_DELETE_BURST_WINDOW_MS);
      return recent.length >= PROJECT_DELETE_BURST_LIMIT
        ? [false, recent]
        : [true, [...recent, now]];
    });
    if (!reserved) {
      yield* Effect.logWarning("Refused a project delete: too many in the last minute", {
        projectId,
        limit: PROJECT_DELETE_BURST_LIMIT,
      });
      return yield* new ProjectRequestDeniedError({ projectId, reason: "too_many_deletes" });
    }
    return now;
  });

  /** Give back a slot whose delete failed, so a retry is not counted twice. */
  const releaseClientDelete = (at: number) =>
    Ref.update(recentClientDeletes, (times) => {
      const index = times.indexOf(at);
      return index === -1 ? times : [...times.slice(0, index), ...times.slice(index + 1)];
    });

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      const initiator = input.initiator ?? "client";
      // A deleted row still reaches commit, so a retried command id replays its
      // receipt and any other command id is rejected as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }
      const project = existing.value;
      if (project.deletedAt !== null) {
        yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
        yield* projectEnrichment.invalidate([project.workspaceRoot]);
        return yield* readCommitted(projectId);
      }

      if (input.force && input.confirmationTitle !== project.title) {
        return yield* new ProjectRequestDeniedError({
          projectId,
          reason: "confirmation_required",
        });
      }
      const active = yield* threadProjections
        .getShellSnapshot()
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
          ),
        );
      const projectThreads = [...active.threads, ...active.archivedThreads].filter(
        (thread) => thread.projectId === projectId,
      );
      if (projectThreads.some((thread) => threadHasActiveWork(thread, input.approvalRequestId))) {
        return yield* new ProjectRequestDeniedError({ projectId, reason: "active_work" });
      }
      const slot = initiator === "client" ? yield* reserveClientDelete(projectId) : undefined;
      const remove = Effect.gen(function* () {
        yield* deleteChildThreads(input);
        yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
      });
      yield* slot === undefined
        ? remove
        : remove.pipe(Effect.onError(() => releaseClientDelete(slot)));
      // Deletion cannot be undone; this line is how the next incident shows who and what.
      yield* Effect.logInfo("project.deleted", {
        projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        threadCount: projectThreads.length,
        commandId: input.commandId,
        initiator,
        force: input.force === true,
        ...(input.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: input.approvalRequestId }),
      });
      yield* projectEnrichment.invalidate([project.workspaceRoot]);
      return yield* readCommitted(projectId);
    },
  );

  const enrichShell = (shell: OrchestrationProjectShell) =>
    projectEnrichment.getAvailable(shell.workspaceRoot).pipe(
      Effect.map((enrichment) => ({
        ...shell,
        repositoryIdentity: enrichment.repositoryIdentity,
      })),
    );

  const getShell: ProjectService["Service"]["getShell"] = Effect.fn("ProjectService.getShell")(
    function* (projectId) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      return Option.isNone(shell) ? shell : Option.some(yield* enrichShell(shell.value));
    },
  );

  const listShells: ProjectService["Service"]["listShells"] = Effect.fn(
    "ProjectService.listShells",
  )(function* (options) {
    const shells = yield* projects
      .listShells(options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    return yield* Effect.forEach(shells, enrichShell, { concurrency: 16 });
  });

  const snapshot = Effect.gen(function* () {
    const rows = yield* projects
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  return ProjectService.of({
    create,
    bootstrap,
    update: (input) =>
      input.workspaceSettings === undefined && input.workspaceRoot === undefined
        ? update(input)
        : admission.withLock(input.projectId, update(input)),
    delete: (input) => admission.withLock(input.projectId, deleteProject(input)),
    getById,
    getByWorkspaceRoot,
    snapshot,
    getShell,
    listShells,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(ProjectAdmission.layer),
);
