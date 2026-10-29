import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  OrchestratorMcpMachineListInput,
  OrchestratorMcpMachineListResult,
} from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MachineListTool = Tool.make("studio_machine_list", {
  description:
    'List the other machines in the owner\'s private fleet that workers can run on, with whether this machine may start workers there (status "ready"), the most a worker there may do (access), the project there that matches this one, and its providers and models. Start a worker on one with studio_thread_launch {machine:"<id or label>"}; follow it with studio_thread_read/wait/send/interrupt {machine}. Only the user allows workers on a machine, in Settings > Connections; projectWorkerMachine is the machine the user chose for this project\'s workers, used when machine is omitted. When machines is empty, tell the user to add one in Settings > Connections > Your private machines > Add a machine; a Linux VPS they rent joins the same way. Never offer to run work in a provider cloud.',
  parameters: OrchestratorMcpMachineListInput,
  success: OrchestratorMcpMachineListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "List worker machines")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const ClaimEpochInput = Schema.Struct({
  logicalProjectId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  epoch: NonNegativeInt,
  threadIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(50)),
  ),
});

const ClaimEpochResult = Schema.Struct({
  logicalProjectId: Schema.String,
  accepted: Schema.Boolean,
  epoch: NonNegativeInt,
  origins: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      coordinatorEnvironmentId: Schema.NullOr(Schema.String),
    }),
  ),
});

/** Called between SpecWithCode machines when a coordinator takes over; agents never need it. */
const ClaimEpochTool = Tool.make("studio_coordinator_claim_epoch", {
  description:
    "Internal, between SpecWithCode machines. A machine that took over as a linked project's coordinator claims its epoch here. Agents never call this.",
  parameters: ClaimEpochInput,
  success: ClaimEpochResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Claim coordinator epoch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const MachinesToolkit = Toolkit.make(MachineListTool, ClaimEpochTool);
