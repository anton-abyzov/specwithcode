import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  AwayAccessDecisionInput,
  AwayAccessRequestInput,
  AwayAccessRequestList,
  AwayAccessRequestRecord,
  AwayAccessRequestResult,
  AwayAccessStatusInput,
  AwayEmptyInput,
  AwayError,
  AwayPlan,
  AwayPreflightInput,
} from "./away.ts";

export const AWAY_RPC_METHODS = {
  awayPreflight: "away.preflight",
  awayRequestAccess: "away.requestAccess",
  awayAccessStatus: "away.accessStatus",
  awayAccessRequests: "away.accessRequests",
  awayDecideAccess: "away.decideAccess",
} as const;

const M = AWAY_RPC_METHODS;
const error = Schema.Union([AwayError, EnvironmentAuthorizationError]);

/** Away mode RPCs, registered as their own group (see `WsAwayRpcGroup`). */
export const awayRpcs = [
  Rpc.make(M.awayPreflight, { payload: AwayPreflightInput, success: AwayPlan, error }),
  Rpc.make(M.awayRequestAccess, {
    payload: AwayAccessRequestInput,
    success: AwayAccessRequestResult,
    error,
  }),
  Rpc.make(M.awayAccessStatus, {
    payload: AwayAccessStatusInput,
    success: AwayAccessRequestResult,
    error,
  }),
  Rpc.make(M.awayAccessRequests, {
    payload: AwayEmptyInput,
    success: AwayAccessRequestList,
    error,
  }),
  Rpc.make(M.awayDecideAccess, {
    payload: AwayAccessDecisionInput,
    success: AwayAccessRequestRecord,
    error,
  }),
] as const;
