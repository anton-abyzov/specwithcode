import type { OrchestratorMcpMachineListResult, RuntimeMode } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { clampRuntimeMode } from "../../../fleet/remoteWorkerMatching.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { claimCoordinatorEpoch, workGrantOf } from "../../workGrantAccess.ts";
import { isOtherMachineCredential } from "../orchestrator/remote.ts";
import { MachinesToolkit } from "./tools.ts";

/**
 * An outside client's work there runs within both its own approval and the
 * machine's grant to this one, so each row reports the lower of the two.
 */
const withinClientCeiling = (
  result: OrchestratorMcpMachineListResult,
  ceiling: RuntimeMode,
): OrchestratorMcpMachineListResult => ({
  ...result,
  machines: result.machines.map((machine) => {
    if (machine.access === null) return machine;
    const clamped = clampRuntimeMode({ started: machine.access, requested: undefined, ceiling });
    return clamped.ok ? { ...machine, access: clamped.mode } : machine;
  }),
});

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  studio_machine_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const remote = yield* RemoteWorkers.RemoteWorkers;
      const client = context.caller === undefined ? context.scope.client : undefined;
      // A thread here or an outside agent approved here may look into the
      // other machines. Another machine's own credential sees grant status
      // only: its work reaches a third machine through the threads it starts.
      const machineCredential =
        client !== undefined &&
        (isOtherMachineCredential(client) || (yield* workGrantOf(context)) !== undefined);
      const listed = yield* remote.listMachines({
        projectId: input.projectId ?? context.caller?.projectId,
        probe: context.caller !== undefined || (client !== undefined && !machineCredential),
      });
      return client === undefined || machineCredential
        ? listed
        : withinClientCeiling(listed, McpInvocationContext.clientRuntimeModeCeiling(client));
    }),
  ),
  studio_coordinator_claim_epoch: McpToolAccess.writes((input) =>
    readCaller().pipe(Effect.flatMap((context) => claimCoordinatorEpoch(context, input))),
  ),
});
