/** The `away.*` handlers (see `WsAwayRpcGroup`). */
import { WS_METHODS, WsAwayRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { AwayAccess } from "./AwayAccessRequest.ts";
import { AwayPlanner } from "./AwayPlanner.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";

/**
 * Registered in server.ts, like the computer-use handlers: connections read
 * handlers from the request context, and adding them to ws.ts's handler graph
 * pushes it past TypeScript's instantiation limit. `RpcAuthorization` refuses
 * `away.decideAccess` to coordinator keys, since this layer has no session.
 */
export const layerRpcHandlers = WsAwayRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const planner = yield* AwayPlanner;
    const access = yield* AwayAccess;
    const handoff = yield* HandoffMode;
    return {
      [WS_METHODS.awayPreflight]: (input) => planner.preflight(input),
      [WS_METHODS.awayRequestAccess]: (input) =>
        access.send({
          targetEnvironmentId: input.targetEnvironmentId,
          fromLabel: handoff.machineLabel,
          missing: input.missing,
        }),
      [WS_METHODS.awayAccessStatus]: (input) => access.status(input),
      [WS_METHODS.awayAccessRequests]: () =>
        access.list.pipe(Effect.map((requests) => ({ requests }))),
      [WS_METHODS.awayDecideAccess]: (input) => access.decide(input),
    };
  }),
);
