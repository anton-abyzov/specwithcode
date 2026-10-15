import {
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
  type ModelSelection,
} from "@specweave-studio/contracts";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";
import {
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { launchRemote, launchTarget } from "./remoteLaunch.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/**
 * An existing checkout a launch may bind: one of the project's own git
 * worktrees. Without this check a launch could point an agent at any directory
 * on the machine.
 */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. studio_worktree_list shows them.",
    });
});

/**
 * Apply the effort the caller named to a launch's model selection, matched to
 * that model's own effort option (nearest level when it lacks the exact one).
 */
const withRequestedEffort = Effect.fn("mcp.withRequestedEffort")(function* (
  selection: ModelSelection,
  effort: string,
) {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers = yield* registry.getProviders;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const descriptors = provider?.models.find((candidate) => candidate.slug === selection.model)
    ?.capabilities?.optionDescriptors;
  const resolved = resolveEffort(effort, descriptors);
  if (!resolved.ok)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Model ${selection.model} on provider ${selection.instanceId} cannot run at effort "${effort}": ${resolved.message}`,
    });
  return {
    ...selection,
    options: withEffortSelection(selection.options, resolved),
  } satisfies ModelSelection;
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  studio_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller } = context;
        const commandId = yield* newCommandId();
        // Read first: the project's worker machine decides where a coordinator's thread runs.
        // A scratch thread has its own project; its coordinator's project still decides.
        const scratchCoordinator =
          input.scratch === true && input.machine === undefined ? caller : undefined;
        const targetProject =
          (input.scratch === true && scratchCoordinator === undefined) ||
          (input.projectId === undefined && caller === undefined && input.machine === undefined)
            ? undefined
            : yield* Effect.gen(function* () {
                const projectId =
                  scratchCoordinator?.projectId ??
                  (yield* resolveProjectId(context, input.projectId));
                const projects = yield* Project.ProjectService;
                const found = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
                return Option.getOrUndefined(found);
              });
        const target = yield* launchTarget(context, input, targetProject);
        if (target.kind === "remote") {
          if (input.effort !== undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "effort applies to threads on this machine. For another machine, pass the effort as modelSelection.options using that machine's option id from orchestrator_capabilities.",
            });
          const launched = yield* launchRemote({
            context,
            machine: target,
            params: input,
            project: targetProject,
            commandId,
            runtimeMode,
            interactionMode,
          });
          return launched;
        }
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        const attachments = input.attachments ?? [];
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        if (input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          yield* assertProjectWorktree(project.workspaceRoot, input.workspaceStrategy.worktreePath);
        }
        const project = yield* readProject;
        const isCoordinator =
          caller !== undefined && project?.workspaceSettings?.coordinatorThreadId === caller.id;
        const modelSelection =
          input.modelSelection ??
          (isCoordinator
            ? project?.defaultModelSelection
            : (caller?.modelSelection ?? project?.defaultModelSelection)) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const launchSelection =
          input.effort === undefined
            ? modelSelection
            : yield* withRequestedEffort(modelSelection, input.effort);
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection: launchSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "AttachmentClaimError"
              ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
              : unavailable(),
          ),
        );
        const thread = result.projection.thread;
        const effortValue = modelSelectionEffortValue(thread.modelSelection);
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          threadLink: formatStudioThreadLink(thread.id, thread.title || input.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          ...(effortValue === undefined ? {} : { effort: effortValue }),
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  studio_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  ),
  studio_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  ),
  studio_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with studio_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  studio_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      // Pause, archive and auto-resume are the user's lifecycle controls; an agent must not lift them.
      const lifecycle = input.workspaceSettings;
      if (
        lifecycle?.paused !== undefined ||
        lifecycle?.archived !== undefined ||
        lifecycle?.autoResume !== undefined ||
        lifecycle?.workerMachine !== undefined
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pause, archive, auto-resume and the worker machine are changed by the user in project settings, not by an agent.",
        });
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  studio_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  studio_project_clone: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  ),
});
