import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HandoffConfigPatch,
  HandoffContinueHereInput,
  HandoffModeEmptyInput,
  HandoffModeError,
  HandoffModeSnapshot,
  HandoffSetProjectModeInput,
  HandoffSetThreadModeInput,
  HandoffThreadInput,
  HandOffInput,
  HandOffMachineInput,
  HandOffResult,
  HandoffMachineRun,
  HandoffPreflightInput,
  HandoffPreflightResult,
} from "./handoffMode.ts";

export const HANDOFF_MODE_RPC_METHODS = {
  handoffModeSnapshot: "handoffMode.snapshot",
  handoffModeUpdateConfig: "handoffMode.updateConfig",
  handoffModeSetThreadMode: "handoffMode.setThreadMode",
  handoffModeSetProjectMode: "handoffMode.setProjectMode",
  handoffModeCheckpointNow: "handoffMode.checkpointNow",
  handoffModeHandOff: "handoffMode.handOff",
  handoffModeHandOffMachine: "handoffMode.handOffMachine",
  handoffModeContinueHere: "handoffMode.continueHere",
  handoffModeResumeFenced: "handoffMode.resumeFenced",
  handoffModePreflight: "handoffMode.preflight",
} as const;

const M = HANDOFF_MODE_RPC_METHODS;
const error = Schema.Union([HandoffModeError, EnvironmentAuthorizationError]);

/** Handoff mode RPCs, registered as their own group (see `WsHandoffModeRpcGroup`). */
export const handoffModeRpcs = [
  Rpc.make(M.handoffModeSnapshot, {
    payload: HandoffModeEmptyInput,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModeUpdateConfig, {
    payload: HandoffConfigPatch,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModeSetThreadMode, {
    payload: HandoffSetThreadModeInput,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModeSetProjectMode, {
    payload: HandoffSetProjectModeInput,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModeCheckpointNow, {
    payload: HandoffThreadInput,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModeHandOff, { payload: HandOffInput, success: HandOffResult, error }),
  Rpc.make(M.handoffModeHandOffMachine, {
    payload: HandOffMachineInput,
    success: HandoffMachineRun,
    error,
  }),
  Rpc.make(M.handoffModeContinueHere, {
    payload: HandoffContinueHereInput,
    success: HandOffResult,
    error,
  }),
  Rpc.make(M.handoffModeResumeFenced, {
    payload: HandoffModeEmptyInput,
    success: HandoffModeSnapshot,
    error,
  }),
  Rpc.make(M.handoffModePreflight, {
    payload: HandoffPreflightInput,
    success: Schema.Array(HandoffPreflightResult),
    error,
  }),
] as const;
