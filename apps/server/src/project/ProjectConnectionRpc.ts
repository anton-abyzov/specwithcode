import { WS_METHODS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Connections from "./ProjectConnectionService.ts";
export const handlers = Effect.gen(function* () {
  const service = yield* Connections.ProjectConnectionService;
  return {
    [WS_METHODS.nativeConnectionsRead]: service.discoverNative,
    [WS_METHODS.projectsConnectionsRead]: service.read,
    [WS_METHODS.projectsConnectionSave]: service.save,
    [WS_METHODS.projectsConnectionCheck]: service.check,
    [WS_METHODS.projectsConnectionRevoke]: service.revoke,
  };
});
