/**
 * The `server.getStorageCleanupPlan` and `server.runStorageCleanup` handlers:
 * Settings > Storage's list of what the cleanup would remove and keep, and its
 * "Clean up now" button. Both call the storage cleanup service the server
 * started, never a second one: two services would run two sweeps over the same
 * folders. Registered apart from ws.ts (see `WsStorageCleanupRpcGroup`).
 *
 * @module storageCleanupRpc
 */
import { WS_METHODS, WsStorageCleanupRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import { StorageCleanupService } from "./storageCleanup.ts";

export const layerRpcHandlers = WsStorageCleanupRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const cleanup = yield* StorageCleanupService;
    return {
      [WS_METHODS.serverGetStorageCleanupPlan]: () => cleanup.plan,
      [WS_METHODS.serverRunStorageCleanup]: () => cleanup.cleanNow,
    };
  }),
);
