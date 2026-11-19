/**
 * Placeholder for the red run of 1427 T-05; the implementation follows.
 *
 * @module CoordinatorMessageReceiver
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  CoordinatorMessageDeliverRequest,
  CoordinatorMessageDeliverResponse,
} from "../handoff/coordinatorMessageWire.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";

export class CoordinatorMessageReceiver extends Context.Service<
  CoordinatorMessageReceiver,
  {
    readonly deliver: (
      caller: ReceiverCaller,
      request: CoordinatorMessageDeliverRequest,
    ) => Effect.Effect<CoordinatorMessageDeliverResponse, HandoffRefusal>;
    readonly flush: Effect.Effect<number>;
  }
>()("specweave-studio/project/CoordinatorMessageReceiver") {}

export const revokedMessageRefusal = (_receiver: string, _sender: string) =>
  new HandoffRefusal({ status: 500, code: "failed", message: "Not built yet." });

export const layer = Layer.succeed(
  CoordinatorMessageReceiver,
  CoordinatorMessageReceiver.of({
    deliver: () => Effect.fail(revokedMessageRefusal("", "")),
    flush: Effect.succeed(0),
  }),
);
