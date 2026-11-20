import {
  CoordinatorMessageBody,
  OrchestratorMcpFailure,
  CoordinatorMessageId,
  CoordinatorMessageState,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { CoordinatorMessageOutbox } from "../../../project/CoordinatorMessageOutbox.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
export const CoordinatorMessageToolkit = Toolkit.make(
  Tool.make("studio_coordinator_message", {
    description:
      "Send a short report to another linked machine's coordinator. Only this project's coordinator can send. A message informs, never steers or grants consent. Use findings for read-only access, reply only to an incoming non-reply, and put large context in a report reference. Keep clientRequestId stable across retries. An offline destination queues for up to 24 hours. This never moves or claims a thread; use Hand off for that.",
    parameters: Schema.Struct({
      machine: Schema.String,
      clientRequestId: Schema.String,
      ...CoordinatorMessageBody.fields,
    }),
    success: Schema.Struct({ messageId: CoordinatorMessageId, state: CoordinatorMessageState }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [CoordinatorMessageOutbox, ThreadManagementService, McpInvocationContext],
  }).annotate(Tool.Destructive, true),
);
