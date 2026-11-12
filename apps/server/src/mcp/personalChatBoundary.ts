import { OrchestratorMcpFailure, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";

export const PERSONAL_CHAT_PUSH_REFUSAL =
  "Project chats cannot send messages into the personal assistant. Keep the result in its project; when the user asks the personal assistant for a report, it can read it there.";
export const PERSONAL_CHAT_ROUTE_REFUSAL =
  "Use studio_project_route for work the user explicitly asks the personal assistant to send to a project. For requested status, feedback or reports, read the project without posting into its chat.";

/** Only generic agent sends use this guard. Explicit user routing has its own provenance checks. */
export const assertPersonalChatBoundary = Effect.fn("mcp.assertPersonalChatBoundary")(function* (
  sourceProjectId: ProjectId | undefined,
  targetProjectId: ProjectId,
) {
  // External clients have no agent thread. Same-project assistant workers remain supported.
  if (sourceProjectId === undefined || sourceProjectId === targetProjectId) return;
  const projects = yield* ProjectService.ProjectService;
  const read = (id: ProjectId) =>
    projects.getById(id).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Unable to check the personal assistant's chat boundary.",
          }),
      ),
    );
  const target = yield* read(targetProjectId);
  const source = yield* read(sourceProjectId);
  if (Option.isNone(target) || Option.isNone(source))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Both projects must exist before sending between their chats.",
    });
  if (target.value.workspaceSettings?.kind === "personal")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: PERSONAL_CHAT_PUSH_REFUSAL,
    });
  if (source.value.workspaceSettings?.kind === "personal")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: PERSONAL_CHAT_ROUTE_REFUSAL,
    });
});

export const PERSONAL_READ_REFUSAL =
  "The personal assistant's chats are private to it. Ask the user to bring what you need into this project.";

const lookupFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Unable to check the personal assistant's privacy boundary.",
  });

/**
 * Whether a caller in `callerProjectId` may read threads of `targetProjectId`.
 * Thread-less clients and the assistant's own threads may; an agent thread in
 * any other project may not read a personal project's chats. The assistant
 * reading a project's threads stays allowed.
 */
export const personalReadAllowed = Effect.fn("mcp.personalReadAllowed")(function* (
  callerProjectId: ProjectId | undefined,
  targetProjectId: ProjectId,
) {
  if (callerProjectId === undefined || callerProjectId === targetProjectId) return true;
  const projects = yield* ProjectService.ProjectService;
  const target = yield* projects.getById(targetProjectId).pipe(Effect.mapError(lookupFailure));
  return Option.isNone(target) || target.value.workspaceSettings?.kind !== "personal";
});

/** Refuses an agent in another project reading the personal assistant's chats. */
export const assertPersonalReadBoundary = Effect.fn("mcp.assertPersonalReadBoundary")(function* (
  callerProjectId: ProjectId | undefined,
  targetProjectId: ProjectId,
) {
  if (yield* personalReadAllowed(callerProjectId, targetProjectId)) return;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: PERSONAL_READ_REFUSAL,
  });
});
