/**
 * The `server.cleanOldAppVersions` handler: Storage's one-click removal of old
 * app versions, under the same rules and install lock as the automatic cleanup.
 * Registered apart from ws.ts (see `WsAppVersionsRpcGroup`).
 *
 * @module cloud/appVersionsRpc
 */
import { WS_METHODS, WsAppVersionsRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { withPinnedRuntimeInstallLock } from "./pinnedRuntime.ts";
import { pruneRuntimeVersionsLogged } from "./runtimeVersionRetention.ts";

export const cleanOldAppVersions = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const result = yield* withPinnedRuntimeInstallLock(
    pruneRuntimeVersionsLogged({ baseDir: config.baseDir, reason: "storage-settings" }),
  );
  return {
    removedCount: result.removed.length,
    freedBytes: result.removed.reduce((sum, entry) => sum + entry.bytes, 0),
    failedCount: result.failed.length,
    ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
  };
});

export const layerRpcHandlers = WsAppVersionsRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.succeed({
    [WS_METHODS.serverCleanOldAppVersions]: () => cleanOldAppVersions,
  }),
);
