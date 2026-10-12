import {
  CommandId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectConnectionError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Connections from "../../../project/ProjectConnectionService.ts";
import * as Access from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { ProjectConnectionsToolkit } from "./tools.ts";
const boundProject = Effect.fn("mcp.projectConnections.boundProject")(function* (
  requested?: ProjectId,
) {
  const context = yield* readCaller();
  const projectId = yield* resolveProjectId(context, requested);
  // Project connectors are never ambient permissions for an outside OAuth client.
  if (!context.caller || context.caller.projectId !== projectId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Connections are scoped to the calling thread's project.",
    });
  return projectId;
});
const failure = (error: ProjectConnectionError) =>
  new OrchestratorMcpFailure({
    code: error.code === "denied" ? "capability_denied" : "invalid_request",
    message: error.message,
  });
export const layer = Access.toLayer(ProjectConnectionsToolkit, {
  studio_project_connections_list: Access.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const service = yield* Connections.ProjectConnectionService;
      const result = yield* service.read({ projectId }).pipe(Effect.mapError(failure));
      return result.connections.map((c) => ({
        id: c.id,
        name: c.name,
        revision: c.revision,
        status: c.status,
        tools: c.status === "ready" ? c.tools.filter((t) => c.allowedTools.includes(t.name)) : [],
      }));
    }),
  ),
  studio_project_connection_call: Access.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const scope = yield* Invocation.McpInvocationContext;
      const service = yield* Connections.ProjectConnectionService;
      const actor = `thread:${scope.thread!.threadId}`;
      return yield* service
        .call({
          ...input,
          projectId,
          actor,
          commandId: CommandId.make(`${actor}:${input.commandId}`),
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
