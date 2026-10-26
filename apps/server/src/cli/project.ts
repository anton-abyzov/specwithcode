import {
  AuthAdministrativeScopes,
  CommandId,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ProjectFolderCheck,
  type ProjectFolderCheckInput,
  type ProjectMutation,
  type ProjectSnapshot,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type * as Terminal from "effect/Terminal";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { folderThreadsText, nestedProjectsText } from "../project/ProjectActionRequests.ts";
import { folderChangeRefusal, planningImpactText } from "../project/ProjectFolderChange.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectMutationOperation } from "../project/ProjectMutation.ts";
import * as StudioProjectFileLoader from "../project/StudioProjectFileLoader.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { PROJECT_CLI_SESSION_LABEL } from "../project/TemporaryProjects.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = ProjectMutation;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class ProjectCommandIdGenerationError extends Schema.TaggedError<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedError<ProjectLiveServerDeclaredResponseError>()(
  "ProjectLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    /** The server's own words for a refusal, such as why a folder change was refused. */
    detail: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Server request failed (${this.code}, trace ${this.traceId}).`
      : `${this.detail} (${this.code}, trace ${this.traceId})`;
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedError<ProjectLiveServerUndeclaredStatusError>()(
  "ProjectLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class ProjectLiveServerRequestError extends Schema.TaggedError<ProjectLiveServerRequestError>()(
  "ProjectLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedError<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedError<ProjectIdentifierEmptyError>()(
  "ProjectIdentifierEmptyError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return "Project identifier cannot be empty.";
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'.`;
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedError<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `An active project already exists for '${this.workspaceRoot}'.`;
  }
}

export class ProjectRemoveConfirmationError extends Schema.TaggedError<ProjectRemoveConfirmationError>()(
  "ProjectRemoveConfirmationError",
  {
    operation: Schema.Literal("removeProject"),
    title: Schema.String,
    typed: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.typed === undefined
      ? `Nothing was removed. Removing a project deletes its threads, memory, plans and routines. Confirm with --confirm "${this.title}".`
      : `Nothing was removed: "${this.typed}" is not the project's title. Confirm with --confirm "${this.title}".`;
  }
}

export class ProjectMoveRefusedError extends Schema.TaggedError<ProjectMoveRefusedError>()(
  "ProjectMoveRefusedError",
  {
    operation: Schema.Literal("moveProject"),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectLiveServerRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectRemoveConfirmationError,
  ProjectMoveRefusedError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

export function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError {
  if (isEnvironmentHttpCommonError(cause)) {
    const detail = "detail" in cause && typeof cause.detail === "string" ? cause.detail : "";
    return new ProjectLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      ...(detail.length > 0 ? { detail } : {}),
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new ProjectLiveServerRequestError({ operation: "callLiveServer", cause });
}

const projectCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const layerProjectCliRuntime = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(StudioProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
/** Checking and changing a folder read Git remotes and walk the new folder, so they get longer. */
const PROJECT_CLI_FOLDER_TIMEOUT = Duration.seconds(30);
const withProjectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: PROJECT_CLI_SESSION_LABEL,
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: ProjectSnapshot;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* new ProjectIdentifierEmptyError({
      operation: "resolveProjectTarget",
      identifier: input.identifier,
    });
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === "Success" ? normalizedWorkspaceRootResult.success : null;

  // A stored workspace path still identifies its project after the directory is gone.
  const exactWorkspaceMatch = activeProjects.find(
    (project) => project.workspaceRoot === (normalizedWorkspaceRoot ?? trimmedIdentifier),
  );

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* new ProjectNotFoundError({
      operation: "resolveProjectTarget",
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      ...(normalizedWorkspaceRoot === null ? {} : { normalizedWorkspaceRoot }),
      ...(normalizedWorkspaceRootResult._tag === "Failure"
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    });
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.projects.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.projects.mutate({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.projects.mutate>[0]);
  }).pipe(
    command.type === "project.folder.change"
      ? Effect.timeout(PROJECT_CLI_FOLDER_TIMEOUT)
      : withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const checkLiveProjectFolder = (
  origin: string,
  bearerToken: string,
  payload: ProjectFolderCheckInput,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.projects.folderCheck({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload,
    });
  }).pipe(
    Effect.timeout(PROJECT_CLI_FOLDER_TIMEOUT),
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projects = yield* ProjectService.ProjectService;
  return yield* projects.snapshot;
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withProjectCliSessionToken(environmentAuth, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.result(attempt);
    if (attempted._tag === "Success") {
      return Option.some(attempted.success);
    }

    yield* Effect.logDebug("Failed to connect to the persisted project CLI server.", {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    });
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: ProjectSnapshot;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
    /** The running app's folder check; absent offline, where folders cannot change. */
    readonly checkFolder?: (
      input: ProjectFolderCheckInput,
    ) => Effect.Effect<ProjectFolderCheck, Error, HttpClient.HttpClient>;
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | Terminal.Terminal
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);

    if (Option.isSome(liveMode)) {
      return yield* withProjectCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
            checkFolder: (input) => checkLiveProjectFolder(liveMode.value.origin, token, input),
          });
          yield* Console.log(output);
        }),
      );
    }

    const layerOfflineRuntime = layerProjectCliRuntime.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const projects = yield* ProjectService.ProjectService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => projectMutationOperation(projects, command).pipe(Effect.asVoid),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(layerOfflineRuntime));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* new ProjectAlreadyExistsError({
            operation: "addProject",
            projectId: existingProject.id,
            workspaceRoot,
          });
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(yield* projectCommandUuid);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

/** Asks a terminal for the project's title; a script, or a person who quits, gets none. */
const askProjectTitle = (title: string) =>
  process.stdin.isTTY && process.stdout.isTTY
    ? Prompt.run(
        Prompt.String({
          message: `Removing "${title}" deletes its memory, plans and routines. Type its title to confirm:`,
        }),
      ).pipe(
        Effect.map((typed) => Option.some(typed.trim())),
        Effect.catchTags({ QuitError: () => Effect.succeedNone }),
      )
    : Effect.succeedNone;

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
  confirm: Flag.String("confirm").pipe(
    Flag.withDescription(
      "The project's exact title, to confirm the deletion. A terminal asks for it when this is left out.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Remove a project and its memory, plans and routines; --force also deletes its threads. Folders and Git branches stay. Needs --confirm with the project's exact title.",
  ),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        // A delete names the project it destroys, typed by the person: an id or path
        // in a script is not that confirmation.
        const typed = Option.getOrUndefined(
          Option.isSome(flags.confirm) ? flags.confirm : yield* askProjectTitle(project.title),
        );
        if (typed !== project.title)
          return yield* new ProjectRemoveConfirmationError({
            operation: "removeProject",
            title: project.title,
            ...(typed === undefined ? {} : { typed }),
          });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
          confirmationTitle: typed,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.String("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

/** What `project move --check` prints: the folder check, with nothing changed. */
export function formatFolderCheck(
  project: { readonly id: ProjectId; readonly title: string },
  check: ProjectFolderCheck,
  confirmed: {
    readonly differentRepository: boolean;
    readonly planningImpact: boolean;
  } = { differentRepository: false, planningImpact: false },
): string {
  const repository = check.sameRepository
    ? `same (${check.targetRepository ?? "no Git remote"})`
    : `different: the current folder ${check.currentRepository === null ? "has no Git remote" : `is ${check.currentRepository}`}, the new one ${check.targetRepository === null ? "has none" : `is ${check.targetRepository}`}`;
  const layout = check.layout;
  const planning = planningImpactText(check);
  const nested = nestedProjectsText(check);
  const refusal = folderChangeRefusal(
    check,
    confirmed.differentRepository,
    confirmed.planningImpact,
  );
  const verdict = check.unchanged
    ? "The project already uses this folder."
    : check.refusal !== undefined
      ? `Refused: ${check.refusal.detail}`
      : refusal === null
        ? "Ready to move."
        : refusal.reason === "repository_mismatch"
          ? `Needs --confirm-different-repository. ${refusal.detail}`
          : refusal.reason === "planning_impact"
            ? `Needs --confirm-planning-impact. ${refusal.detail}`
            : `Refused: ${refusal.detail}`;
  return [
    `Folder check for project ${project.id} (${project.title}). Nothing changed.`,
    `  Current folder: ${check.currentRoot}`,
    `  New folder: ${check.targetRoot}${check.targetExists ? "" : check.refusal?.reason === "folder_not_directory" ? " (not a folder)" : " (does not exist)"}`,
    `  Repository: ${repository}`,
    `  Threads: ${check.threadCount}, ${check.keptInPlaceCount} kept in place, ${check.reboundWorktreeCount} rebound to the new folder`,
    ...(check.unchanged
      ? []
      : [
          `    ${folderThreadsText({
            from: check.currentRoot,
            to: check.targetRoot,
            keptInPlace: check.keptInPlaceCount,
            reboundWorktrees: check.reboundWorktreeCount,
            threadCount: check.threadCount,
            done: false,
          })}`,
        ]),
    ...(check.activeThreads.length === 0
      ? []
      : [`  Running: ${check.activeThreads.map((thread) => `"${thread.title}"`).join(", ")}`]),
    ...(layout === undefined
      ? []
      : [
          `  Layout: ${layout.kind}, ${layout.repositoryCount} ${layout.repositoryCount === 1 ? "repository" : "repositories"}${layout.repositories.length === 0 ? "" : ` (${layout.repositories.slice(0, 5).join(", ")}${layout.repositories.length > 5 ? ", ..." : ""})`}${layout.truncated ? ", walk stopped early" : ""}`,
        ]),
    `  Planning: ${planning ?? "unchanged"}`,
    ...(nested === null ? [] : [`  Other projects: ${nested}`]),
    ...(check.conflictingProject === null
      ? []
      : [`  Owned by: "${check.conflictingProject.title}" (${check.conflictingProject.id})`]),
    `  Result: ${verdict}`,
  ].join("\n");
}

/**
 * Moves a project to another folder, after the running app checks it. Threads
 * in the project folder follow it from their next turn, and threads on a
 * checkout inside it move to the same checkout in the new folder. When the old
 * folder stays a checkout of another repository (moving up to an umbrella),
 * those threads keep running there instead and only the coordinator and new
 * threads use the new folder. Memory and history stay with the project.
 */
const projectMoveCommand = Command.make("move", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or current workspace root."),
  ),
  workspaceRoot: Argument.String("folder").pipe(
    Argument.withDescription("The folder the project should use."),
  ),
  confirmDifferentRepository: Flag.Boolean("confirm-different-repository").pipe(
    Flag.withDescription("Use the folder even when it is not a checkout of the same repository."),
    Flag.withDefault(false),
  ),
  confirmPlanningImpact: Flag.Boolean("confirm-planning-impact").pipe(
    Flag.withDescription(
      "Use the folder even when plan cards would read another SpecWeave planning root.",
    ),
    Flag.withDefault(false),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Show what the move would do without changing anything."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Move a project to another folder. Threads in the project folder follow it, unless the old folder stays a checkout of another repository: then they keep running there and only the coordinator and new threads use the new folder. Memory and history stay with the project. Needs the app running; --check shows what would happen.",
  ),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectMoveMutation")(function* ({
        snapshot,
        dispatch,
        checkFolder,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
        readonly checkFolder?: (
          input: ProjectFolderCheckInput,
        ) => Effect.Effect<ProjectFolderCheck, Error, HttpClient.HttpClient>;
      }) {
        const project = yield* findActiveProjectTarget({ snapshot, identifier: flags.project });
        const path = yield* Path.Path;
        const workspaceRoot = path.resolve(flags.workspaceRoot);
        if (checkFolder === undefined)
          return yield* new ProjectMoveRefusedError({
            operation: "moveProject",
            detail:
              "Nothing changed. Start the app first: it checks the folder, keeps running work safe and moves the threads.",
          });
        const check = yield* checkFolder({ projectId: project.id, workspaceRoot });
        if (flags.check)
          return formatFolderCheck(project, check, {
            differentRepository: flags.confirmDifferentRepository,
            planningImpact: flags.confirmPlanningImpact,
          });
        if (check.unchanged)
          return `Project ${project.id} (${project.title}) already uses ${check.targetRoot}.`;
        // The server refuses the same way, but its answer does not carry the reason.
        if (check.refusal !== undefined)
          return yield* new ProjectMoveRefusedError({
            operation: "moveProject",
            detail: `Nothing changed: ${check.refusal.detail}`,
          });
        const refusal = folderChangeRefusal(
          check,
          flags.confirmDifferentRepository,
          flags.confirmPlanningImpact,
        );
        if (refusal !== null)
          return yield* new ProjectMoveRefusedError({
            operation: "moveProject",
            detail: `Nothing changed: ${refusal.detail}${
              refusal.reason === "repository_mismatch"
                ? " Pass --confirm-different-repository to use it."
                : refusal.reason === "planning_impact"
                  ? " Pass --confirm-planning-impact to accept it."
                  : ""
            }`,
          });
        yield* dispatch({
          type: "project.folder.change",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          workspaceRoot,
          ...(flags.confirmDifferentRepository ? { confirmDifferentRepository: true } : {}),
          ...(flags.confirmPlanningImpact ? { confirmPlanningImpact: true } : {}),
        });
        // The change answers with the project only; the check just before counted the threads.
        return `Moved project ${project.id} (${project.title}) from ${check.currentRoot} to ${check.targetRoot}. ${folderThreadsText(
          {
            from: check.currentRoot,
            to: check.targetRoot,
            keptInPlace: check.keptInPlaceCount,
            reboundWorktrees: check.reboundWorktreeCount,
            done: true,
          },
        )}`;
      }),
    ),
  ),
);

/**
 * Archives or restores a project. An archived project keeps its threads, memory,
 * plans and folder, and project lists fold it away. Its existing threads stop too:
 * they take no new messages, cannot delegate, skip environment setup, and are not
 * resumed after a usage limit resets. Restoring the project undoes all of this.
 */
const makeProjectArchiveCommand = (archived: boolean) =>
  Command.make(archived ? "archive" : "unarchive", {
    ...projectLocationFlags,
    project: Argument.String("project").pipe(
      Argument.withDescription(
        `Project id or workspace root to ${archived ? "archive" : "restore"}.`,
      ),
    ),
  }).pipe(
    Command.withDescription(
      archived
        ? "Archive a project: hide it from project lists and stop its threads (no new messages, delegation, environment setup or resume after a usage limit). Threads, memory and folder are kept; unarchive restores it."
        : "Restore an archived project.",
    ),
    Command.withHandler((flags) =>
      runProjectMutation(
        flags,
        Effect.fn(archived ? "projectArchiveMutation" : "projectUnarchiveMutation")(function* ({
          snapshot,
          dispatch,
        }: {
          readonly snapshot: ProjectSnapshot;
          readonly dispatch: (
            command: ProjectCliDispatchCommand,
          ) => Effect.Effect<
            void,
            Error,
            FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
          >;
        }) {
          const target = yield* findActiveProjectTarget({ snapshot, identifier: flags.project });
          const settings = snapshot.projects.find(
            (project) => project.id === target.id,
          )?.workspaceSettings;
          if ((settings?.archived ?? false) === archived) {
            return `Project ${target.id} (${target.title}) is already ${archived ? "archived" : "active"}.`;
          }
          yield* dispatch({
            type: "project.update",
            commandId: CommandId.make(yield* projectCommandUuid),
            projectId: target.id,
            workspaceSettings: { expectedRevision: settings?.revision ?? 0, archived },
          });
          return archived
            ? `Archived project ${target.id} (${target.title}); its threads, memory and folder are kept.`
            : `Restored project ${target.id} (${target.title}).`;
        }),
      ),
    ),
  );

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectMoveCommand,
    makeProjectArchiveCommand(true),
    makeProjectArchiveCommand(false),
  ]),
);
