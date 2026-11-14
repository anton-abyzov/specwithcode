import {
  type GoogleAccountError,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@specweave-studio/contracts";
import { teamRulesToolRefusal } from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../../../teamRules/TeamRules.ts";
import * as Effect from "effect/Effect";
import * as Google from "../../../integrations/google/GoogleAccountService.ts";
import { requirePersonalData } from "../../../personalData/personalDataGate.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { refuseRevoked, workGrantOf } from "../../workGrantAccess.ts";
import { proposeSend, sendApproved } from "./sendApproval.ts";
import { GoogleToolkit } from "./tools.ts";

/**
 * The calling thread's project. Google data is never an ambient permission:
 * an outside MCP client, or a thread of another project, gets nothing. Work
 * another machine started here also needs the owner to have allowed that
 * machine the source `tool` reads: the project's own switch is not enough.
 */
const callerProject = Effect.fn("mcp.google.callerProject")(function* (tool: string) {
  const refused = teamRulesToolRefusal(yield* currentTeamRules, "google");
  if (refused !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: refused.message,
    });
  }
  const context = yield* readCaller();
  if (!context.caller) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Google tools are only available to threads of a project the user gave access.",
    });
  }
  const work = yield* workGrantOf({ scope: context.scope, caller: context.caller });
  // A stopped or ended grant reads nothing, even while its threads wind down.
  if (work !== undefined) yield* refuseRevoked(work);
  yield* requirePersonalData(work, tool);
  return context.caller.projectId;
});

const failure = (error: GoogleAccountError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

const read = <A>(
  tool: string,
  run: (
    service: Google.GoogleAccountService["Service"],
    projectId: ProjectId,
  ) => Effect.Effect<A, GoogleAccountError>,
) =>
  Effect.gen(function* () {
    const projectId = yield* callerProject(tool);
    const service = yield* Google.GoogleAccountService;
    return yield* run(service, projectId).pipe(Effect.mapError(failure));
  });

export const layer = Access.toLayer(GoogleToolkit, {
  studio_google_status: Access.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* callerProject("studio_google_status");
      const service = yield* Google.GoogleAccountService;
      return yield* service.projectAccess(projectId, input);
    }),
  ),
  studio_google_gmail_search: Access.reads((input) =>
    read("studio_google_gmail_search", (service, projectId) =>
      service.gmailSearch(projectId, input),
    ),
  ),
  studio_google_gmail_read: Access.reads((input) =>
    read("studio_google_gmail_read", (service, projectId) =>
      service.gmailRead(projectId, input.messageId),
    ),
  ),
  // Saves a draft in the user's own mailbox and never sends it; only a live project thread may.
  studio_google_gmail_create_draft: Access.actsAsCaller((input) =>
    read("studio_google_gmail_create_draft", (service, projectId) =>
      service.gmailCreateDraft(projectId, input),
    ),
  ),
  // Shows the reply card in the caller's own thread.
  studio_google_gmail_propose_send: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const projectId = yield* callerProject("studio_google_gmail_propose_send");
      const service = yield* Google.GoogleAccountService;
      return yield* proposeSend(service, projectId, input.draftIds);
    }),
  ),
  // Sends only what the person answered Send for on that card.
  studio_google_gmail_send_draft: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const projectId = yield* callerProject("studio_google_gmail_send_draft");
      const service = yield* Google.GoogleAccountService;
      return yield* sendApproved(service, projectId, input);
    }),
  ),
  studio_google_calendar_events: Access.reads((input) =>
    read("studio_google_calendar_events", (service, projectId) =>
      service.calendarEvents(projectId, input),
    ),
  ),
  studio_google_drive_search: Access.reads((input) =>
    read("studio_google_drive_search", (service, projectId) =>
      service.driveSearch(projectId, input),
    ),
  ),
  studio_google_drive_read: Access.reads((input) =>
    read("studio_google_drive_read", (service, projectId) =>
      service.driveRead(projectId, input.fileId),
    ),
  ),
});
