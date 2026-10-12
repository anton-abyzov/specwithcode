import {
  OrchestratorMcpFailure,
  OrchestratorMcpMachineListInput,
  OrchestratorMcpMachineListResult,
} from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MachineListTool = Tool.make("studio_machine_list", {
  description:
    'List the other machines in the owner\'s private fleet that workers can run on, with whether this machine may start workers there (status "ready"), the most a worker there may do (access), the project there that matches this one, and its providers and models. Start a worker on one with studio_thread_launch {machine:"<id or label>"}; follow it with studio_thread_read/wait/send/interrupt {machine}. Only the user allows workers on a machine, in Settings > Connections; projectWorkerMachine is the machine the user chose for this project\'s workers, used when machine is omitted.',
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

export const MachinesToolkit = Toolkit.make(MachineListTool);
