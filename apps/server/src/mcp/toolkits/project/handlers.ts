import {
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
  type LearnedModelPreference,
  type ModelSelection,
} from "@specweave-studio/contracts";
import { withLearnedPreference } from "@specweave-studio/shared/modelLanes";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as ServerSettings from "../../../serverSettings.ts";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import {
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { workerLaunchWithRoom } from "../../../project/WorkerLaunchRoom.ts";
import {
  launchIncrementFields,
  resolveLaunchIncrement,
  withIncrementBrief,
} from "../../../project/launchIncrement.ts";
import {
  autoRoutingApplies,
  promptWithRoutingNote,
  routeWorkerTask,
  routedSelection,
} from "../../../project/TaskRouting.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { projectInGrant } from "../../../fleet/workGrantPolicy.ts";
import {
  admitLaunch,
  assertAccountInGrant,
  assertProjectInGrant,
  recordLaunchOrigin,
  workGrantOf,
} from "../../workGrantAccess.ts";
import { launchRemote, launchTarget, placementSkippable } from "./remoteLaunch.ts";
import { routeTargets, routeToProject } from "./route.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? `${error.workspaceRoot} already belongs to another project. studio_project_list shows which.`
        : Project.projectMutationErrorMessage(error);
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** Shows the approval card in the calling thread; the user's answer applies the change. */
const requestProjectAction = Effect.fn("mcp.requestProjectAction")(function* (input: {
  readonly action: ProjectActionRequests.ProjectAction;
  readonly projectId?: ProjectId | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly reason?: string | undefined;
}) {
  const context = yield* readCaller();
  const caller = context.caller;
  if (caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Only an agent in a SpecWithCode thread can ask for this. Ask the user to do it in the project's settings.",
    });
  const projectId = yield* resolveProjectId(context, input.projectId);
  const requests = yield* ProjectActionRequests.ProjectActionRequests;
  const { requestId } = yield* requests
    .request({
      threadId: caller.id,
      projectId,
      action: input.action,
      reason: input.reason ?? "No reason given.",
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    })
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
  return {
    requestId,
    status: "awaiting_user" as const,
    message:
      "The user sees an approval card in this thread. End your turn now; their decision and what changed arrive as their answer.",
  };
});

/**
 * An existing checkout a launch may bind: one of the project's own git
 * worktrees. Without this check a launch could point an agent at any directory
 * on the machine.
 */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
  owner = "the project's",
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
      message: `worktreePath must be one of ${owner} git worktrees. studio_worktree_list shows them.`,
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
        const placed = yield* launchTarget(context, input, targetProject);
        let skipped = placed.skipped;
        // A personal assistant's work stays on its machine: neither it nor
        // its threads start work on another machine.
        if (placed.target.kind === "remote") {
          const callerProject =
            caller === undefined || caller.projectId === targetProject?.id
              ? targetProject
              : yield* Project.ProjectService.pipe(
                  Effect.flatMap((projects) => projects.getById(caller.projectId as never)),
                  Effect.map(Option.getOrUndefined),
                  Effect.orElseSucceed(() => undefined),
                );
          if (
            isPersonalAssistantProject(targetProject) ||
            isPersonalAssistantProject(callerProject)
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `${PERSONAL_ASSISTANT_PRIVATE_MESSAGE} Start this work here, or route it with studio_project_route to a project on this machine.`,
            });
        }
        if (placed.target.kind === "remote") {
          const machine = placed.target;
          if (input.effort !== undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "effort applies to threads on this machine. For another machine, pass the effort as modelSelection.options using that machine's option id from orchestrator_capabilities.",
            });
          const launched = yield* launchRemote({
            context,
            machine,
            params: input,
            project: targetProject,
            commandId,
            runtimeMode,
            interactionMode,
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catchIf(
              (error) => placed.reason !== "explicit" && placementSkippable(error),
              (error) => Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (launched.ok)
            return {
              ...launched.result,
              placement: { machine: machine.machine.label, reason: placed.reason, skipped },
            };
          skipped = [
            ...skipped,
            { machine: machine.machine.label, reason: launched.error.message },
          ];
        }
        // Work another machine started here stays inside the grant this machine gave it.
        const work = yield* admitLaunch(context, input.delegation);
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
        const scratchProjectId =
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
            : undefined;
        // Work asked for in a project stays in it: the user finds it there, and
        // it runs with that project's context. Only a request the user made
        // without a project becomes a chat outside every project.
        if (
          scratchProjectId !== undefined &&
          caller !== undefined &&
          caller.projectId !== scratchProjectId &&
          input.projectless !== true
        ) {
          const callerTitle =
            targetProject?.id === caller.projectId
              ? targetProject.title
              : yield* Project.ProjectService.pipe(
                  Effect.flatMap((projects) => projects.getById(caller.projectId)),
                  Effect.map((found) => Option.getOrUndefined(found)?.title),
                  Effect.orElseSucceed(() => undefined),
                );
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `This thread belongs to project "${callerTitle ?? caller.projectId}", so the threads it starts stay there: omit scratch to launch in the project (its root, or one of its worktrees with workspaceStrategy). For work in a repository the project does not list, launch in the project anyway and use that repository by its absolute path, or ask the user to add it to the project. Pass projectless:true with scratch only when the user asked for a chat outside any project.`,
          });
        }
        const projectId = scratchProjectId ?? (yield* resolveProjectId(context, input.projectId));
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
          const repository = input.workspaceStrategy.repository;
          let worktreeOwner = { cwd: project.workspaceRoot, label: "the project's" };
          if (repository !== undefined) {
            const resolved = ThreadLaunch.resolveLaunchRepository(project, repository);
            if (!resolved.ok)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: resolved.message,
              });
            worktreeOwner = {
              cwd: resolved.checkout.path,
              label: `repository "${resolved.checkout.id}"'s`,
            };
          }
          yield* assertProjectWorktree(
            worktreeOwner.cwd,
            input.workspaceStrategy.worktreePath,
            worktreeOwner.label,
          );
        }
        const project = yield* readProject;
        if (work !== undefined) {
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          yield* assertProjectInGrant(work, project);
        }
        const isCoordinator =
          caller !== undefined && project?.workspaceSettings?.coordinatorThreadId === caller.id;
        // Resolved where the thread starts as far as it is known now: an existing
        // worktree, else the project. A new worktree is not made yet, so a ref
        // the project lacks is looked up in the caller's own worktree, as
        // delegate_task and create_threads do. A bad ref launches nothing.
        const strategy = input.workspaceStrategy;
        const incrementResolution =
          project === undefined
            ? ({ ok: true, value: {} } as const)
            : yield* Effect.promise(() =>
                resolveLaunchIncrement({
                  workspaceRoot: project.workspaceRoot,
                  worktreePath:
                    strategy?.type === "existing_worktree" ? strategy.worktreePath : null,
                  fallbackWorktreePath:
                    strategy?.type === "worktree" && caller?.projectId === project.id
                      ? (caller.worktreePath ?? null)
                      : null,
                  ref: input.increment,
                  title: input.title,
                  caller:
                    caller === undefined || caller.projectId !== project.id
                      ? null
                      : {
                          threadId: caller.id,
                          title: caller.title,
                          branch: caller.branch,
                          worktreePath: caller.worktreePath,
                        },
                  isCoordinator,
                }),
              );
        if (!incrementResolution.ok)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: incrementResolution.message,
          });
        const increment = incrementResolution.value;
        // A coordinator's thread starts on the project's worker model, moved
        // off a provider with no room (see workerLaunchWithRoom).
        const workerSelection =
          isCoordinator && input.modelSelection === undefined && project?.defaultModelSelection
            ? yield* workerLaunchWithRoom({
                project,
                preferred: project.defaultModelSelection,
                coordinator: caller.modelSelection,
                providers: yield* (yield* ProviderRegistry.ProviderRegistry).getProviders,
                runtimePolicy: { runtimeMode, interactionMode },
              })
            : project?.defaultModelSelection;
        const modelSelection =
          input.modelSelection ??
          (isCoordinator
            ? workerSelection
            : (caller?.modelSelection ?? project?.defaultModelSelection)) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        // Auto model routing (project/TaskRouting.ts): only when no model was
        // named and the app picks it, or the caller passed a task class.
        const routes =
          project !== undefined &&
          (work === undefined || work.grant.accounts.kind === "all") &&
          autoRoutingApplies({
            pinned: input.modelSelection !== undefined,
            isCoordinator,
            taskClass: input.taskClass,
            taskLane: input.taskLane,
          });
        const providers = routes
          ? yield* (yield* ProviderRegistry.ProviderRegistry).getProviders
          : [];
        // Only instances with a V2 adapter can run a thread, as delegate_task checks.
        const adapters = routes
          ? yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2)
          : Option.none();
        const runnableInstanceIds = Option.isSome(adapters)
          ? yield* adapters.value.list().pipe(
              Effect.map((ids) => new Set<string>(ids)),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const decision =
          routes && project !== undefined
            ? yield* routeWorkerTask({
                project,
                baseline: modelSelection,
                providers,
                task: {
                  text: input.message ?? "",
                  title: input.title,
                  hint: input.taskClass,
                  attachments: attachments.map((attachment) => ({
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  })),
                },
                laneHint: input.taskLane,
                ...(runnableInstanceIds === undefined ? {} : { runnableInstanceIds }),
              })
            : null;
        const routedModel =
          decision?.moved === true
            ? routedSelection(decision, decision.selection, providers)
            : modelSelection;
        yield* assertAccountInGrant(work, routedModel.instanceId);
        // A routed thread keeps the effort the baseline ran at, mapped to its model.
        const carriedEffort =
          decision?.moved === true && input.effort === undefined
            ? modelSelectionEffortValue(modelSelection)
            : undefined;
        const launchSelection =
          input.effort !== undefined
            ? yield* withRequestedEffort(routedModel, input.effort)
            : carriedEffort !== undefined
              ? yield* withRequestedEffort(routedModel, carriedEffort).pipe(
                  Effect.orElseSucceed(() => routedModel),
                )
              : routedModel;
        const routing = decision === null ? undefined : { ...decision, selection: launchSelection };
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection: launchSelection,
          ...(routing === undefined ? {} : { routing }),
          runtimeMode,
          interactionMode,
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          ...(increment.increment === undefined
            ? {}
            : {
                increment: {
                  root: increment.increment.root,
                  incrementId: increment.increment.incrementId,
                },
              }),
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: promptWithRoutingNote(
                    withIncrementBrief(input.message ?? "", increment),
                    routing ?? null,
                  ),
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "AttachmentClaimError"
              ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
              : error._tag === "ThreadLaunchError" &&
                  error.operation === "resolve-repository" &&
                  typeof error.cause === "string"
                ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.cause })
                : unavailable(),
          ),
        );
        const thread = result.projection.thread;
        yield* recordLaunchOrigin(work, thread.id);
        const effortValue = modelSelectionEffortValue(thread.modelSelection);
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          threadLink: formatStudioThreadLink(thread.id, thread.title || input.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          ...(effortValue === undefined ? {} : { effort: effortValue }),
          ...(routing === undefined ? {} : { routing }),
          ...launchIncrementFields(increment),
          runId: run?.id ?? null,
          status: run?.status ?? null,
          // Tells a coordinator on another machine that this one applied its grant's checks.
          delegationChecked: true,
          placement: {
            machine: "this machine",
            reason: placed.reason === "explicit" ? "explicit" : "this_machine",
            skipped,
          },
        };
      }),
  ),
  studio_route_targets: McpToolAccess.readsAsCaller(() => routeTargets()),
  // The target coordinator's modes are checked in the handler: it may not exist yet.
  studio_project_route: McpToolAccess.writesThreads(
    () => [],
    (input) => routeToProject(input),
  ),
  studio_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      // Another machine's work sees only the projects its grant here covers.
      const work = yield* workGrantOf(yield* readCaller());
      const rows = snapshot.projects.filter(
        (project) =>
          project.deletedAt === null &&
          (work === undefined ||
            projectInGrant(work.grant.projects, work.grant.coordinatorEnvironmentId, project)),
      );
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
      yield* assertProjectInGrant(yield* workGrantOf(yield* readCaller()), result.value);
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
        // A title-only project is a new repository for the person; a check brings its own folder.
        if (input.origin === "automated")
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A check's project needs its own folder: pass workspaceRoot (for example under the scratch folder) with origin automated.",
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
      // An agent may mark its own check's project; only the person files a project as theirs.
      if (input.origin === "user")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            'Only the user moves a project to their own projects. Omit origin for a project they asked for, or pass origin "automated" for a check.',
        });
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
      if (input.workspaceRoot !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Moving a project to another folder needs the user's approval: call studio_project_request with action change_folder and workspaceRoot.",
        });
      if (
        lifecycle?.paused !== undefined ||
        lifecycle?.archived !== undefined ||
        lifecycle?.autoResume !== undefined ||
        lifecycle?.workerMachine !== undefined
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pause, auto-resume and the worker machine are the user's to change in project settings. To archive or restore a project, call studio_project_request; the user approves it.",
        });
      // Which list a project sits in is the person's choice once the project exists:
      // an agent must not hide their project under Automated or lift a check into theirs.
      if (lifecycle?.origin !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Whether a project is listed under Automated is the user's to change from its sidebar menu. Pass origin when you create a check's project instead.",
        });
      // The context labels these the user's own instructions, ranked above agent memory;
      // an agent that could rewrite them could raise its own text to that rank.
      if (lifecycle?.instructions !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Project instructions are the user's to change in project settings. Save what you learned with studio_project_memory_write instead.",
        });
      // Approved folders and the project kind are the access evidence the personal
      // assistant routes on; an agent widening them would grant itself projects.
      const folders = lifecycle?.environment?.additionalFolders;
      if (lifecycle?.kind !== undefined || folders !== undefined) {
        const current = Option.getOrUndefined(
          yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
        )?.workspaceSettings;
        const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
          left.length === right.length && left.every((folder) => right.includes(folder));
        if (
          (lifecycle?.kind !== undefined && lifecycle.kind !== (current?.kind ?? "code")) ||
          (folders !== undefined && !same(folders, current?.environment.additionalFolders ?? []))
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              lifecycle?.kind !== undefined && lifecycle.kind !== (current?.kind ?? "code")
                ? "A project's kind is fixed when it is created; make a new project of the kind you need."
                : "Approved folders are the user's to change in project settings; they decide what agents here can reach.",
          });
      }
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  studio_project_request: McpToolAccess.actsAsCaller((input) => requestProjectAction(input)),
  studio_project_delete: McpToolAccess.actsAsCaller((input) =>
    requestProjectAction({ ...input, action: "delete" }),
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
  studio_model_preference: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const settingsService = yield* ServerSettings.ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
      const projectOverrides = settings.projectSettingsOverrides[projectId] ?? {};
      const preferences = projectOverrides.learnedModelPreferences ?? [];
      if (input.action === "list") {
        return {
          action: "list" as const,
          projectId,
          preferences,
        };
      }
      if (input.action === "delete") {
        if (!input.id) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Pass id: the rule id to delete.",
          });
        }
        const updated = preferences.filter((pref) => pref.id !== input.id);
        const deleted = updated.length !== preferences.length;
        if (deleted) {
          yield* settingsService
            .updateSettings({
              projectSettingsOverrides: {
                [projectId]: {
                  ...projectOverrides,
                  learnedModelPreferences: updated,
                },
              },
            })
            .pipe(Effect.mapError(unavailable));
        }
        return {
          action: "delete" as const,
          projectId,
          preferences: updated,
          deleted,
        };
      }
      if (input.action === "record") {
        if (!input.preference) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass preference: {kind: 'prefer', model}, {kind: 'avoid', model}, or {kind: 'lane', lane}.",
          });
        }
        const crypto = yield* Crypto.Crypto;
        const id = `pref-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 12)}`;
        const now = yield* DateTime.now;
        const recorded: LearnedModelPreference = {
          id,
          keywords: (input.keywords ?? []).map((k) => k.toLowerCase().trim()),
          ...(input.taskClass !== undefined ? { taskClass: input.taskClass } : {}),
          ...(input.lane !== undefined ? { lane: input.lane } : {}),
          action: input.preference,
          ...(input.note !== undefined ? { note: input.note } : {}),
          createdAt: DateTime.formatIso(now),
        };
        const updated = withLearnedPreference(preferences, recorded);
        yield* settingsService
          .updateSettings({
            projectSettingsOverrides: {
              [projectId]: {
                ...projectOverrides,
                learnedModelPreferences: updated,
              },
            },
          })
          .pipe(Effect.mapError(unavailable));
        return {
          action: "record" as const,
          projectId,
          preferences: updated,
          recorded,
        };
      }
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Unknown action: ${(input as { action: string }).action}`,
      });
    }),
  ),
});
