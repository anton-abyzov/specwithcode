import * as MachineHandoff from "../fleet/MachineHandoff.ts";
import { withoutCoordinatorMove } from "./EqualCoordinatorMigration.ts";
import * as ProjectConnectionRpc from "./ProjectConnectionRpc.ts";
import * as ProjectEnvironmentService from "./ProjectEnvironmentService.ts";
import {
  WS_METHODS,
  WsProjectPlanningRpcGroup,
  WsProjectKnowledgeRpcGroup,
  ProjectThreadsDeleteError,
  ProjectEnvironmentError,
  type ProjectEnvironmentPrepareInput,
  type ProjectEnvironmentReadInput,
  CommandId,
  MessageId,
  ProjectWorkspaceError,
  ThreadId,
  type ProjectId,
  type ProjectFirstFeatureGuideInput,
  type ProjectSpecweaveAnswerInput,
  type ProjectSpecweaveSetUpInput,
  type ProjectThreadsDeleteInput,
  type ProjectMemoryWriteInput,
  type AssetAccessError,
  type AssetCreateUrlResult,
  type AssetResource,
  type WsDesignRpcGroup,
  type WsDesignSystemImportRpcGroup,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";
import * as ProjectStarterSuggestions from "./ProjectStarterSuggestions.ts";
import * as ProjectCoordinatorService from "./ProjectCoordinatorService.ts";
import * as ProjectUsageService from "../usage/ProjectUsageService.ts";
import * as ProjectPlanRpc from "./ProjectPlanRpc.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";
import * as ThreadReportService from "./ThreadReportService.ts";
import * as SpecweaveSetupRequests from "./SpecweaveSetupRequests.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadIncrementProgressService from "./ThreadIncrementProgressService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as FirstFeatureSample from "./firstFeatureSample.ts";
import * as ThreadRepositories from "./ThreadRepositories.ts";
import { ProjectFolderService } from "./ProjectFolderChange.ts";
import * as ProjectWorktreeCleanup from "./ProjectWorktreeCleanup.ts";
import * as ProjectRepositoryPresence from "./ProjectRepositoryPresence.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";

type ProjectMemoryDeleteInput = Parameters<
  ProjectWorkspaceService.ProjectWorkspaceService["Service"]["deleteMemory"]
>[0];
const importRemoved = (projectId: ProjectId) =>
  new ProjectEnvironmentError({
    projectId,
    code: "import_blocked",
    detail:
      "Importing a repository list was removed: threads can use every Git repository in the project folder. Update SpecWithCode on this device.",
  });
export const handlers = Effect.gen(function* () {
  const threadRepositories = yield* ThreadRepositories.makeRpc;
  const handoff = yield* MachineHandoff.MachineHandoff;
  const environment = yield* ProjectEnvironmentService.ProjectEnvironmentService;
  const usage = yield* ProjectUsageService.ProjectUsageService;
  const skills = yield* ProjectSkillsService.ProjectSkillsService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const coordinator = yield* ProjectCoordinatorService.ProjectCoordinatorService;
  const starters = yield* ProjectStarterSuggestions.ProjectStarterSuggestionsService;
  const reports = yield* ThreadReportService.ThreadReportService;
  const specweaveFile = SpecweaveSetupRequests.specweaveSetupFile(
    (yield* ServerConfig.ServerConfig).stateDir,
  );
  const threads = yield* ThreadManagementService.ThreadManagementService;
  /** Wakes the card's thread with an AC-07 sentence; a repeat of the same command is ignored. */
  const wakeForSpecweave = (
    projectId: ProjectId,
    wake: SpecweaveSetupRequests.SpecweaveWake | undefined,
  ) => {
    if (wake === undefined) return Effect.void;
    const message = SpecweaveSetupRequests.specweaveWakeMessage(wake);
    return threads
      .sendToThread({
        projectId,
        commandId: CommandId.make(message.id),
        threadId: ThreadId.make(wake.threadId),
        messageId: MessageId.make(message.id),
        text: message.text,
        attachments: [],
        // Never interrupts what the thread is doing.
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not wake the thread after a SpecWeave answer.", {
            projectId,
            threadId: wake.threadId,
            cause,
          }),
        ),
      );
  };
  return {
    [WS_METHODS.machineHandoffPrepare]: withoutCoordinatorMove(handoff.prepare),
    [WS_METHODS.machineHandoffReceive]: handoff.receive,
    ...(yield* ProjectPlanRpc.handlers),
    ...(yield* ProjectConnectionRpc.handlers),
    [WS_METHODS.projectsEnvironmentRead]: (input: ProjectEnvironmentReadInput) =>
      environment
        .read(input)
        .pipe(
          Effect.flatMap((result) =>
            input.threadId === undefined
              ? Effect.succeed(result)
              : threadRepositories
                  .read(input.projectId, input.threadId)
                  .pipe(Effect.map((thread) => (thread === null ? result : { ...result, thread }))),
          ),
        ),
    // The thread's "Add repository" runs the agent tool's own add, then reads the thread again.
    [WS_METHODS.projectsEnvironmentPrepare]: (input: ProjectEnvironmentPrepareInput) =>
      input.mode !== "thread_add"
        ? environment.prepare(input)
        : threadRepositories.add(input).pipe(
            Effect.andThen(environment.read({ projectId: input.projectId, discover: true })),
            Effect.flatMap((result) =>
              threadRepositories
                .read(input.projectId, input.threadId!)
                .pipe(Effect.map((thread) => (thread === null ? result : { ...result, thread }))),
            ),
          ),
    // Importing a SpecWeave repository list is gone: the folder's repositories are found on
    // the read. An older client that still calls these is told so.
    [WS_METHODS.projectsEnvironmentImportPreview]: (input: { readonly projectId: ProjectId }) =>
      Effect.fail(importRemoved(input.projectId)),
    [WS_METHODS.projectsEnvironmentImport]: (input: { readonly projectId: ProjectId }) =>
      Effect.fail(importRemoved(input.projectId)),
    [WS_METHODS.projectsUsageRead]: usage.read,
    [WS_METHODS.projectsSkillsRead]: skills.read,
    [WS_METHODS.projectsWorkspaceRead]: workspace.readWorkspace,
    // 1396: the card's press and every other setup settle the project's card and wake its thread.
    [WS_METHODS.projectsSpecweaveSetUp]: (input: ProjectSpecweaveSetUpInput) =>
      Effect.gen(function* () {
        if (input.requestId !== undefined) {
          const requestId = input.requestId;
          // The card's state is a convenience: a state file that cannot be written never stops setup.
          yield* Effect.tryPromise(() =>
            SpecweaveSetupRequests.markSettingUp(specweaveFile, input.projectId, requestId),
          ).pipe(Effect.ignore);
        }
        const exit = yield* Effect.exit(workspace.setUpSpecweave(input));
        const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        const settled = yield* Effect.promise(() =>
          SpecweaveSetupRequests.settleAfterSetup(specweaveFile, {
            projectId: input.projectId,
            requestId: input.requestId,
            result: Exit.isSuccess(exit)
              ? { ok: true }
              : {
                  ok: false,
                  detail: Option.match(failure, {
                    onNone: () => "SpecWeave could not be set up in this folder.",
                    onSome: (error) => error.message,
                  }),
                  needsNode: Option.match(failure, {
                    onNone: () => false,
                    onSome: (error) => error.needs === "node",
                  }),
                },
          }),
        ).pipe(Effect.orElseSucceed(() => ({}) as { wake?: SpecweaveSetupRequests.SpecweaveWake }));
        yield* wakeForSpecweave(input.projectId, settled.wake);
        return yield* exit;
      }),
    [WS_METHODS.projectsSpecweaveAnswer]: (input: ProjectSpecweaveAnswerInput) =>
      Effect.gen(function* () {
        const answered = yield* Effect.tryPromise(() =>
          SpecweaveSetupRequests.answerSpecweave(specweaveFile, input),
        ).pipe(
          Effect.mapError(
            () =>
              new ProjectWorkspaceError({ code: "operation_failed", projectId: input.projectId }),
          ),
        );
        yield* wakeForSpecweave(input.projectId, answered.wake);
        return {
          specweaveDeclined: answered.facts.declined === true,
          specweaveAdviceSeen: answered.facts.adviceSeen === true,
          ...(answered.request === undefined ? {} : { specweaveSetupRequest: answered.request }),
        };
      }),
    [WS_METHODS.projectsStarterSuggestions]: starters.read,
    [WS_METHODS.projectsMemoryRead]: workspace.readMemory,
    // People edit memory here; while the project moves, the move's copy must stay the last word.
    [WS_METHODS.projectsMemoryWrite]: (input: ProjectMemoryWriteInput) =>
      handoff.guardMemoryWrite(input.projectId, workspace.writeMemory(input)),
    [WS_METHODS.projectsMemoryDelete]: (input: ProjectMemoryDeleteInput) =>
      handoff.guardMemoryWrite(input.projectId, workspace.deleteMemory(input)),
    [WS_METHODS.projectsLibraryRead]: workspace.readLibrary,
    [WS_METHODS.projectsLibraryAddArtifact]: workspace.addLibraryArtifact,
    [WS_METHODS.projectsThreadReportsRead]: reports.read,
    [WS_METHODS.projectsThreadReportSave]: reports.save,
    [WS_METHODS.projectsCoordinatorStart]: coordinator.start,
    [WS_METHODS.projectsCoordinatorSend]: coordinator.send,
  };
});

/** What the person reads when deleting a project's threads is refused or fails. */
export function threadsDeleteMessage(cause: ProjectService.ProjectServiceError): string {
  switch (cause._tag) {
    case "ProjectNotFoundError":
      return "This project was not found.";
    case "ProjectRequestDeniedError":
      switch (cause.reason) {
        case "confirmation_required":
          return "Type the project name exactly to delete its threads.";
        case "active_work":
          return "Some threads are still working. Stop them, then delete the threads.";
        case "too_many_deletes":
          return "Too many deletes in the last minute. Wait a moment and try again.";
        default:
          return "The threads could not be deleted.";
      }
    default:
      return "The threads could not be deleted. Threads deleted before the failure stay deleted; try again to finish.";
  }
}

/**
 * The folder check, project worktree, and SpecWeave increment handlers (see
 * `WsProjectPlanningRpcGroup`).
 */
export const layerPlanningRpcHandlers = WsProjectPlanningRpcGroup.middleware(
  RpcInstrumentation,
).toLayer(
  Effect.gen(function* () {
    const incrementProgress = yield* ThreadIncrementProgressService.ThreadIncrementProgressService;
    const folders = yield* ProjectFolderService;
    const worktrees = yield* ProjectWorktreeCleanup.make;
    const projects = yield* ProjectService.ProjectService;
    const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
    const withRepositoryServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | ProjectService.ProjectService
        | RepositoryIdentityResolver.RepositoryIdentityResolver
        | SourceControlRepositoryService.SourceControlRepositoryService
      >,
    ) =>
      effect.pipe(
        Effect.provideService(ProjectService.ProjectService, projects),
        Effect.provideService(RepositoryIdentityResolver.RepositoryIdentityResolver, identities),
        Effect.provideService(
          SourceControlRepositoryService.SourceControlRepositoryService,
          repositories,
        ),
        // The repository list is kept as a project note.
        Effect.provideService(ProjectWorkspaceService.ProjectWorkspaceService, workspace),
      );
    return {
      // 1398: the sample's guide is left, finished or opened again; only a sample takes marks.
      [WS_METHODS.projectsFirstFeatureGuide]: (input: ProjectFirstFeatureGuideInput) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* FirstFeatureSample.firstFeatureGuideRpc(projects, input, now);
        }),
      [WS_METHODS.projectsRepositoriesRead]: (
        input: import("@specweave-studio/contracts").ProjectRepositoriesReadInput,
      ) =>
        withRepositoryServices(ProjectRepositoryPresence.readProjectRepositories(input.projectId)),
      [WS_METHODS.projectsRepositoriesCheck]: (
        input: import("@specweave-studio/contracts").ProjectRepositoriesCheckInput,
      ) => withRepositoryServices(ProjectRepositoryPresence.checkProjectRepositories(input)),
      [WS_METHODS.projectsFolderCheck]: (
        input: import("@specweave-studio/contracts").ProjectFolderCheckInput,
      ) => folders.check(input),
      [WS_METHODS.projectsFolderStop]: (
        input: import("@specweave-studio/contracts").ProjectFolderStopInput,
      ) => folders.stop(input),
      [WS_METHODS.projectsWorktreesRead]: worktrees.read,
      [WS_METHODS.projectsWorktreesRemove]: worktrees.remove,
      [WS_METHODS.projectsThreadsDelete]: (input: ProjectThreadsDeleteInput) =>
        projects.deleteThreads(input).pipe(
          Effect.map((deletedThreadIds) => ({ projectId: input.projectId, deletedThreadIds })),
          Effect.mapError(
            (cause) => new ProjectThreadsDeleteError({ message: threadsDeleteMessage(cause) }),
          ),
        ),
      [WS_METHODS.projectsThreadIncrementProgressRead]: incrementProgress.read,
      [WS_METHODS.projectsIncrementsList]: incrementProgress.listIncrements,
      [WS_METHODS.projectsBoard]: incrementProgress.board,
      [WS_METHODS.projectsBoardIncrement]: incrementProgress.boardIncrement,
      [WS_METHODS.projectsThreadIncrementLink]: incrementProgress.link,
    };
  }),
);

/** The `projects.knowledge*` handlers (see `WsProjectKnowledgeRpcGroup`). */
export const layerKnowledgeRpcHandlers = WsProjectKnowledgeRpcGroup.middleware(
  RpcInstrumentation,
).toLayer(
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
    return {
      [WS_METHODS.projectsKnowledgeRead]: workspace.knowledgeStatus,
      [WS_METHODS.projectsKnowledgeSearch]: workspace.searchKnowledge,
      [WS_METHODS.projectsKnowledgeReindex]: workspace.reindexKnowledge,
    };
  }),
);

export type DesignRpcHandlers = Rpc.ToHandler<
  RpcGroup.Rpcs<typeof WsDesignRpcGroup> | RpcGroup.Rpcs<typeof WsDesignSystemImportRpcGroup>
>;

/**
 * The design handlers for one `/ws` connection, built by `DesignRpc.layerWsHandlers`.
 * ws.ts reads them through this service instead of importing the design modules:
 * pulling those into ws.ts's import graph tips its RPC layer types past
 * TypeScript's instantiation depth (TS2589).
 */
export class DesignWsHandlers extends Context.Service<
  DesignWsHandlers,
  {
    readonly layerRpcHandlers: (
      session: Pick<AuthenticatedSession, "subject" | "scopes">,
    ) => Layer.Layer<DesignRpcHandlers>;
    /** A signed URL for one of a design's images, after the caller's design.get checks. */
    readonly issueAssetUrl: (
      session: Pick<AuthenticatedSession, "subject" | "scopes">,
      resource: Extract<AssetResource, { readonly _tag: "design-asset" }>,
    ) => Effect.Effect<AssetCreateUrlResult, AssetAccessError>;
  }
>()("specweave-studio/project/ProjectWorkspaceRpc/DesignWsHandlers") {}
