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
  AwayBringBackInput,
  AwayEmptyInput,
  AwayError,
  AwayForceLocalInput,
  AwayPlan,
  AwayPreflightInput,
  AwaySession,
  AwaySettingsPatch,
  AwaySnapshot,
  AwayStartInput,
} from "./away.ts";

export const AWAY_RPC_METHODS = {
  awayPreflight: "away.preflight",
  awayRequestAccess: "away.requestAccess",
  awayAccessStatus: "away.accessStatus",
  awayAccessRequests: "away.accessRequests",
  awayDecideAccess: "away.decideAccess",
  awayStart: "away.start",
  awayBringBack: "away.bringBack",
  awaySnapshot: "away.snapshot",
  awayUpdateConfig: "away.updateConfig",
  awayForceLocal: "away.forceLocal",
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
  // Both answer once the session is saved and keep running; clients follow `away.snapshot`.
  Rpc.make(M.awayStart, { payload: AwayStartInput, success: AwaySession, error }),
  Rpc.make(M.awayBringBack, { payload: AwayBringBackInput, success: AwaySession, error }),
  Rpc.make(M.awaySnapshot, { payload: AwayEmptyInput, success: AwaySnapshot, error }),
  Rpc.make(M.awayUpdateConfig, { payload: AwaySettingsPatch, success: AwaySnapshot, error }),
  // Run here anyway: lifts the wake hold for projects the silent target may or may not hold.
  Rpc.make(M.awayForceLocal, { payload: AwayForceLocalInput, success: AwaySession, error }),
] as const;
