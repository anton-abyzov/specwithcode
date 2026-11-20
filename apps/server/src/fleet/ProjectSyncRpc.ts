/** The `projectSync.*` handlers (see `WsProjectSyncRpcGroup`). */
import { PROJECT_SYNC_RPC_METHODS, WsProjectSyncRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectSync from "./ProjectSync.ts";
import * as ProjectSyncExtras from "./ProjectSyncExtras.ts";

/** Registered in server.ts, like the away handlers, to keep ws.ts's handler graph small. */
export const layerRpcHandlers = WsProjectSyncRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const sync = yield* ProjectSync.ProjectSync;
    const extras = yield* ProjectSyncExtras.ProjectSyncExtras;
    return {
      [PROJECT_SYNC_RPC_METHODS.projectSyncStatus]: (input) => sync.status(input),
      [PROJECT_SYNC_RPC_METHODS.projectSyncInventory]: (input) => extras.inventory(input),
      [PROJECT_SYNC_RPC_METHODS.projectSyncFetch]: (input) => sync.fetch(input),
      [PROJECT_SYNC_RPC_METHODS.projectSyncRun]: (input) => sync.run(input),
      [PROJECT_SYNC_RPC_METHODS.projectSyncSendExtras]: (input) => extras.sendExtras(input),
    };
  }),
);
