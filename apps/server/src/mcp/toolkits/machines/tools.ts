import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  OrchestratorMcpMachineListInput,
  OrchestratorMcpMachineListResult,
  StandbyRearmReason,
} from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MachineListTool = Tool.make("studio_machine_list", {
  description:
    'List the other machines in the owner\'s private fleet that workers can run on, with whether this machine may start workers there (status "ready"), the most a worker there may do (access), the project there that matches this one, its providers and models, and its platform (operating system, and iosSimulators when it can or cannot run iOS Simulators; absent when it has not said). For simulator or Xcode work pass needs to studio_thread_launch instead of picking a machine by hand. Start a worker on one with studio_thread_launch {machine:"<id or label>"}; follow it with studio_thread_read/wait/send/interrupt {machine}, or several at once with studio_threads_wait. An outside MCP client the user approved on this machine (OAuth or a static token from auth mcp-token) may do the same within its approved access; a read-only one may list, read and wait but not launch, send or interrupt. Only the user allows workers on a machine: on this one, in Settings > Machines, on that machine\'s card, Allow on the line "Agents on <this machine> can start work on <machine>"; what that machine lets this one use there is set on it, in Settings > Machines > Who can run work here. projectScope "linked" or "listed" means that machine lets this one use only some of its projects: it refuses studio_project_add_to_machine, and status "project_not_in_grant" means this project is not among them, so tell the user before planning work there (they widen it on that machine in Settings > Machines > Who can run work here). projectWorkerMachines lists the machines the user chose for this project\'s workers, in the order a launch without machine tries them ("local" is this machine); a machine that cannot take the thread is skipped, and placement in the launch result says where it went. incoming lists machines that run work on this one but that this one may not use yet: to start a session on, fetch a file from or move a thread to one, quote its allow step to the user (one click on that machine) and end your turn. When machines and incoming are empty, tell the user to add one in Settings > Machines > Add a machine; a Linux VPS they rent joins the same way. Never offer to run work in a provider cloud.',
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
  /** Also register this machine as the caller's standby, under the owner's re-arm consent here. */
  standby: Schema.optional(
    Schema.Struct({ chainId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)) }),
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
  /** Present when the claim asked for a standby registration. */
  standby: Schema.optional(
    Schema.Struct({
      armed: Schema.Boolean,
      code: Schema.optional(StandbyRearmReason),
      message: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
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
