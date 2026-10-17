import {
  CloudSessionCreateInput,
  CloudSessionCreateResult,
  CloudSessionSendInput,
  CloudSessionSendResult,
  CloudSessionsListInput,
  CloudSessionsSnapshot,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as CloudSessions from "../../../cloudSessions/CloudSessions.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CloudSessions.CloudSessions,
];

const CloudSessionCreateTool = Tool.make("studio_cloud_session_create", {
  description:
    "Start an Anthropic cloud session: Claude Code running on Anthropic's VM against this project's repository, using the user's own claude.ai plan (no extra charge; no fleet machine involved). Pass the whole task: the session cannot see this conversation, this machine or any file that is not on the pushed branch. Without upload, the checkout must have an origin on github.com with no unpushed commits; with upload:true the committed files are sent as a bundle (under 100 MB) and the session cannot push results back. Returns the session URL for the user and a `claude --teleport` command to continue locally. studio_machine_list reports under cloud whether this machine can start one; a status other than ready names the fix. Creation takes a few minutes while the VM clones and runs the setup script.",
  parameters: CloudSessionCreateInput,
  success: CloudSessionCreateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a cloud session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const CloudSessionSendTool = Tool.make("studio_cloud_session_send", {
  description:
    "Send a follow-up message to a cloud session started here or with `claude --cloud` on this machine. The session receives it as a new turn; its reply is only visible at the session URL or after `claude --teleport <id>`, never here. ok:false carries the CLI's own error, such as an archived session.",
  parameters: CloudSessionSendInput,
  success: CloudSessionSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message a cloud session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const CloudSessionsListTool = Tool.make("studio_cloud_session_list", {
  description:
    "Whether this machine can start Anthropic cloud sessions (availability, with the fix when it cannot) and the sessions it started: URL, repository, branch, task, created and last-sent times. projectId narrows to one project; omitted lists the calling thread's project, or every project for a client outside a thread. Nothing here reads a session's transcript; open the URL for that.",
  parameters: CloudSessionsListInput,
  success: CloudSessionsSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List cloud sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const CloudToolkit = Toolkit.make(
  CloudSessionCreateTool,
  CloudSessionSendTool,
  CloudSessionsListTool,
);
