import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { HandoffModeError } from "./handoffMode.ts";
import { HandoffBatchInput, HandoffBatchReadInput, HandoffBatchRun } from "./handoffTransfer.ts";

export const HANDOFF_BATCH_RPC_METHODS = {
  handoffBatchStart: "handoffBatch.start",
  handoffBatchRead: "handoffBatch.read",
} as const;

const error = Schema.Union([HandoffModeError, EnvironmentAuthorizationError]);

/** The hand off batch's window calls, registered beside Away mode's (see `WsAwayRpcGroup`). */
export const handoffBatchRpcs = [
  Rpc.make(HANDOFF_BATCH_RPC_METHODS.handoffBatchStart, {
    payload: HandoffBatchInput,
    success: HandoffBatchRun,
    error,
  }),
  Rpc.make(HANDOFF_BATCH_RPC_METHODS.handoffBatchRead, {
    payload: HandoffBatchReadInput,
    success: Schema.Array(HandoffBatchRun),
    error,
  }),
] as const;
