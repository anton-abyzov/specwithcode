import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { normalizeProjectEnvironment } from "./ProjectEnvironmentPaths.ts";
import {
  CommandId,
  ProjectEnvironmentError,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type OrchestrationProjectShell,
  type ModelSelection,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  type ThreadId,
} from "@specweave-studio/contracts";
import { defaultProjectModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  planProjectCommand,
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

export interface ProjectCreateInput extends ProjectCreatePayload {
  /** Internal handoff seed, committed atomically with creation; null disables auto-seeding. */
  readonly initialWorkerModelSelection?: ModelSelection | null;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  /** Internal automatic initialization, checked under the project command lock. */
  readonly onlyIfDefaultModelUnset?: boolean;
  /** Internal coordinator binding, never accepted from a client settings patch. */
  readonly coordinatorThreadId?: ThreadId;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
  readonly confirmationTitle?: string;
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
    return `Project ${this.projectId} is not empty.`;
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
        return "Stop active project work before changing folder access.";
      case "active_work":
        return "Finish or stop active project work before deleting the project.";
    }
  }
}

/** Return only reviewed messages; unexpected operational details stay private. */
export function projectMutationErrorMessage(cause: unknown): string {
  return cause instanceof ProjectRequestDeniedError ||
    cause instanceof ProjectNotEmptyError ||
    cause instanceof ProjectEnvironmentError
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
>()("studio/project/ProjectService") {}

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
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: { project, workspaceOwner },
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
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        workspaceRoot === undefined
          ? planAndCommit
          : workspaceLocks.withLock(workspaceRoot, planAndCommit),
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

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* normalizeWorkspaceRoot({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        createIfMissing: input.createWorkspaceRootIfMissing ?? false,
      });
      yield* commit({
        type: "project.create",
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        workspaceRoot,
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        ...(input.initialWorkerModelSelection === undefined
          ? {}
          : { initialWorkerModelSelection: input.initialWorkerModelSelection }),
      });
      yield* projectEnrichment.invalidate([workspaceRoot]);
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
        workspaceRoot !== previousRoot ||
        (environment !== undefined &&
          JSON.stringify(environment) !== JSON.stringify(priorEnvironment))
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
        if (
          [...snapshot.threads, ...snapshot.archivedThreads].some(
            (thread) =>
              thread.projectId === input.projectId &&
              (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null),
          )
        )
          return yield* new ProjectRequestDeniedError({
            projectId: input.projectId,
            reason: "environment_active",
          });
      }
      yield* commit({
        type: "project.meta.update",
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
      projection.runtimeRequests.some((request) => request.status === "pending")
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
              cause instanceof ProjectRequestDeniedError
                ? cause
                : new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      // A deleted row still reaches commit, so a retried command id replays its
      // receipt and any other command id is rejected as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      if (existing.value.deletedAt === null) {
        if (input.force && input.confirmationTitle !== existing.value.title) {
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
        if (
          [...active.threads, ...active.archivedThreads].some(
            (thread) =>
              thread.projectId === projectId &&
              (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null),
          )
        ) {
          return yield* new ProjectRequestDeniedError({ projectId, reason: "active_work" });
        }
        yield* deleteChildThreads(input);
      }
      yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
      yield* projectEnrichment.invalidate([existing.value.workspaceRoot]);
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
