import { OrchestratorMcpFailure, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";

export const PERSONAL_CHAT_PUSH_REFUSAL =
  "Project chats cannot send messages into the personal assistant. Keep the result in its project; when the user asks Aide for a report, Aide can read it there.";
export const PERSONAL_CHAT_ROUTE_REFUSAL =
  "Use studio_project_route for work the user explicitly asks Aide to send to a project. For requested status, feedback or reports, read the project without posting into its chat.";

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
