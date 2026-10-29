import * as MachineHandoff from "../fleet/MachineHandoff.ts";
import * as ProjectConnectionRpc from "./ProjectConnectionRpc.ts";
import * as ProjectEnvironmentService from "./ProjectEnvironmentService.ts";
import {
  WS_METHODS,
  WsProjectPlanningRpcGroup,
  WsProjectKnowledgeRpcGroup,
  ProjectThreadsDeleteError,
  type ProjectThreadsDeleteInput,
  type ProjectMemoryWriteInput,
  type AssetAccessError,
  type AssetCreateUrlResult,
  type AssetResource,
  type WsDesignRpcGroup,
  type WsDesignSystemImportRpcGroup,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import * as ThreadIncrementProgressService from "./ThreadIncrementProgressService.ts";
import * as ProjectService from "./ProjectService.ts";
import { applyWorkspaceImport } from "./ProjectEnvironmentAdoption.ts";
import { ProjectFolderService } from "./ProjectFolderChange.ts";
import * as ProjectWorktreeCleanup from "./ProjectWorktreeCleanup.ts";

type ProjectMemoryDeleteInput = Parameters<
  ProjectWorkspaceService.ProjectWorkspaceService["Service"]["deleteMemory"]
>[0];
export const handlers = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const handoff = yield* MachineHandoff.MachineHandoff;
  const environment = yield* ProjectEnvironmentService.ProjectEnvironmentService;
  const usage = yield* ProjectUsageService.ProjectUsageService;
  const skills = yield* ProjectSkillsService.ProjectSkillsService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const coordinator = yield* ProjectCoordinatorService.ProjectCoordinatorService;
  const starters = yield* ProjectStarterSuggestions.ProjectStarterSuggestionsService;
  const reports = yield* ThreadReportService.ThreadReportService;
  return {
    [WS_METHODS.machineHandoffPrepare]: handoff.prepare,
    [WS_METHODS.machineHandoffReceive]: handoff.receive,
    ...(yield* ProjectPlanRpc.handlers),
    ...(yield* ProjectConnectionRpc.handlers),
    [WS_METHODS.projectsEnvironmentRead]: environment.read,
    [WS_METHODS.projectsEnvironmentPrepare]: environment.prepare,
    [WS_METHODS.projectsEnvironmentImportPreview]: environment.previewImport,
    [WS_METHODS.projectsEnvironmentImport]: (
      input: import("@specweave-studio/contracts").ProjectEnvironmentImportInput,
    ) => applyWorkspaceImport(environment, projects, input),
    [WS_METHODS.projectsUsageRead]: usage.read,
    [WS_METHODS.projectsSkillsRead]: skills.read,
    [WS_METHODS.projectsWorkspaceRead]: workspace.readWorkspace,
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
    return {
      [WS_METHODS.projectsFolderCheck]: (
        input: import("@specweave-studio/contracts").ProjectFolderCheckInput,
      ) => folders.check(input),
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
