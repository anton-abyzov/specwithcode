import {
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectKnowledgeError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Workspace from "../../../project/ProjectWorkspaceService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ProjectKnowledgeToolkit } from "./tools.ts";

const boundProject = Effect.fn("mcp.projectKnowledge.boundProject")(function* (
  requested?: ProjectId,
) {
  const context = yield* readCaller();
  // Knowledge quotes Library files, so only an agent in one of the project's threads reads it.
  if (!context.caller || (requested !== undefined && requested !== context.caller.projectId)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project knowledge is scoped to the calling thread's project.",
    });
  }
  return context.caller.projectId;
});
const failure = (error: ProjectKnowledgeError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "operation_failed" || error.code === "unavailable"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });
export const layer = Access.toLayer(ProjectKnowledgeToolkit, {
  studio_project_knowledge_search: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      return yield* workspace
        .searchKnowledge({ ...input, projectId })
        .pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_knowledge_read: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      return yield* workspace.readKnowledge({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
});
