import * as Effect from "effect/Effect";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { claimCoordinatorEpoch } from "../../workGrantAccess.ts";
import { MachinesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  studio_machine_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const remote = yield* RemoteWorkers.RemoteWorkers;
      return yield* remote.listMachines({
        projectId: input.projectId ?? context.caller?.projectId,
        // Only a Studio thread here may look into the other machines.
        probe: context.caller !== undefined,
      });
    }),
  ),
  studio_coordinator_claim_epoch: McpToolAccess.writes((input) =>
    readCaller().pipe(Effect.flatMap((context) => claimCoordinatorEpoch(context, input))),
  ),
});
