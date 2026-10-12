import {
  type GoogleAccountError,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Google from "../../../integrations/google/GoogleAccountService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { GoogleToolkit } from "./tools.ts";

/**
 * The calling thread's project. Google data is never an ambient permission:
 * an outside MCP client, or a thread of another project, gets nothing.
 */
const callerProject = Effect.fn("mcp.google.callerProject")(function* () {
  const context = yield* readCaller();
  if (!context.caller) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Google tools are only available to threads of a project the user gave access.",
    });
  }
  return context.caller.projectId;
});

const failure = (error: GoogleAccountError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

const read = <A>(
  run: (
    service: Google.GoogleAccountService["Service"],
    projectId: ProjectId,
  ) => Effect.Effect<A, GoogleAccountError>,
) =>
  Effect.gen(function* () {
    const projectId = yield* callerProject();
    const service = yield* Google.GoogleAccountService;
    return yield* run(service, projectId).pipe(Effect.mapError(failure));
  });

export const layer = Access.toLayer(GoogleToolkit, {
  studio_google_status: Access.reads(() =>
    Effect.gen(function* () {
      const projectId = yield* callerProject();
      const service = yield* Google.GoogleAccountService;
      return yield* service.projectAccess(projectId);
    }),
  ),
  studio_google_gmail_search: Access.reads((input) =>
    read((service, projectId) => service.gmailSearch(projectId, input)),
  ),
  studio_google_gmail_read: Access.reads((input) =>
    read((service, projectId) => service.gmailRead(projectId, input.messageId)),
  ),
  studio_google_calendar_events: Access.reads((input) =>
    read((service, projectId) => service.calendarEvents(projectId, input)),
  ),
  studio_google_drive_search: Access.reads((input) =>
    read((service, projectId) => service.driveSearch(projectId, input)),
  ),
  studio_google_drive_read: Access.reads((input) =>
    read((service, projectId) => service.driveRead(projectId, input.fileId)),
  ),
});
