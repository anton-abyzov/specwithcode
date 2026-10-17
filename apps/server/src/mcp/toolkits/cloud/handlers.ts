import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as CloudSessions from "../../../cloudSessions/CloudSessions.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { CloudToolkit } from "./tools.ts";

/** The service's reasons in the codes MCP clients already know; the detail is written for the user. */
const asMcpFailure = (error: CloudSessions.CloudSessionError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unavailable"
        ? "provider_unavailable"
        : error.reason === "invalid_request" || error.reason === "not_found"
          ? "invalid_request"
          : "orchestration_error",
    message: error.detail.slice(0, 1000),
  });

const handlers = {
  studio_cloud_session_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const cloud = yield* CloudSessions.CloudSessions;
      return yield* cloud
        .create({ ...input, projectId, createdByThreadId: context.caller?.id })
        .pipe(Effect.mapError(asMcpFailure));
    }),
  ),
  studio_cloud_session_send: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const cloud = yield* CloudSessions.CloudSessions;
      return yield* cloud.send(input).pipe(Effect.mapError(asMcpFailure));
    }),
  ),
  studio_cloud_session_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cloud = yield* CloudSessions.CloudSessions;
      return yield* cloud
        .list({ projectId: input.projectId ?? context.caller?.projectId })
        .pipe(Effect.mapError(asMcpFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CloudToolkit.tools>;

export const layer = McpToolAccess.toLayer(CloudToolkit, handlers);
