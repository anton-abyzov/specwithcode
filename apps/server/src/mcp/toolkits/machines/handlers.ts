import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CloudSessions from "../../../cloudSessions/CloudSessions.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { MachinesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  studio_machine_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const remote = yield* RemoteWorkers.RemoteWorkers;
      const cloud = yield* CloudSessions.CloudSessions;
      const [machines, availability] = yield* Effect.all(
        [
          remote.listMachines({
            projectId: input.projectId ?? context.caller?.projectId,
            // Only a Studio thread here may look into the other machines.
            probe: context.caller !== undefined,
          }),
          // The CLI check is local and cached; a failure there hides the entry, never the machines.
          cloud.availability().pipe(Effect.option),
        ],
        { concurrency: "unbounded" },
      );
      return Option.isSome(availability)
        ? {
            ...machines,
            cloud: {
              status: availability.value.status,
              reason: availability.value.reason,
              tool: "studio_cloud_session_create" as const,
            },
          }
        : machines;
    }),
  ),
});
